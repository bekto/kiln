/**
 * T028 — live reload: the SSE endpoint behind `GET /__reload`, the
 * serve-time injection of the browser client into HTML responses, and the
 * wiring that turns a successful T027 rebuild into one `reload` broadcast.
 *
 * `serve.ts`'s `src/server/*.ts` scan imports this module and takes its
 * `middleware` export. Importing it has side effects by design — module
 * init runs exactly once per process (ESM registry): it registers the
 * broadcast listener first, then starts the watcher. When no watch root
 * exists the throw is caught and printed as a warning, so the server and
 * the SSE endpoint still run.
 *
 * The two router entries run in order:
 *   1. `eventStream` answers `GET /__reload` and never falls through;
 *   2. `injectHtml` wraps the response of every other request, then calls
 *      `next()` — T026's static handler writes through the wrapper.
 *
 * Nothing here is reachable from `kiln build`: the client partial is
 * spliced into responses on the way out, so build output on disk stays
 * free of the script, and non-HTML responses pass through untouched.
 */
import { readFileSync } from "node:fs";
import type { OutgoingHttpHeaders, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.ts";
import { onAfterRebuild, startWatching } from "../watch.ts";
import type { Middleware } from "./static.ts";

/** The endpoint every injected client opens (and the only SSE route). */
const SSE_PATH = "/__reload";

/** Keep-alive comment cadence on a held-open stream. */
const PING_MS = 25_000;

/**
 * One broadcast frame: the named event with an empty payload. The empty
 * `data:` line is required — WHATWG drops events whose data buffer is
 * empty, so `event: reload` alone would never reach a browser; clients
 * still receive it with `event.data === ""` (no payload).
 */
const RELOAD_EVENT = "event: reload\ndata:\n\n";

/**
 * The shipped browser client, resolved relative to this module (like
 * serve.ts's SERVER_DIR), never relative to cwd: it is kiln's own asset,
 * so a fixture project or installed package finds the same file.
 */
const CLIENT = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "templates",
    "partials",
    "live-reload.html",
  ),
);

/** Every open `/__reload` stream — the broadcast set. */
const clients = new Set<ServerResponse>();

/** Write one frame unless the socket has already gone away. */
function send(res: ServerResponse, frame: string): void {
  if (!res.writableEnded && !res.destroyed) res.write(frame);
}

/** Push `event: reload` to every connected client. */
function broadcast(): void {
  for (const res of clients) {
    try {
      send(res, RELOAD_EVENT);
    } catch {
      // Socket died between the guard and the write; the connection's own
      // close/error handlers drop it from the set.
    }
  }
}

/** `GET /__reload`:200 event-stream, initial `: ping`, held open. */
const eventStream: Middleware = (req, res, next) => {
  let pathname: string;
  try {
    pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    next();
    return;
  }
  if (req.method !== "GET" || pathname !== SSE_PATH) {
    next();
    return;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  send(res, ": ping\n\n");
  clients.add(res);
  const ping = setInterval(() => send(res, ": ping\n\n"), PING_MS);
  ping.unref();
  const drop = (): void => {
    clearInterval(ping);
    clients.delete(res);
  };
  res.on("close", drop);
  res.on("error", drop);
};

/** `writeHead`'s headers argument as a lowercase-keyed object. */
function normalizeHeaders(raw: unknown): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (Array.isArray(entry) && entry.length > 0) {
        headers[String(entry[0]).toLowerCase()] = entry[1];
      }
    }
  } else if (raw !== null && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw)) {
      headers[key.toLowerCase()] = value;
    }
  }
  return headers;
}

/**
 * Insert the client just before the last `</body>`; append when absent.
 * The body is decoded as latin1 — a byte-preserving round trip — so the
 * regex index IS the buffer offset and no encoding can shift the splice.
 */
function splice(body: Buffer): Buffer {
  const text = body.toString("latin1");
  const pattern = /<\/body\s*>/gi;
  let at = -1;
  for (
    let match = pattern.exec(text);
    match !== null;
    match = pattern.exec(text)
  ) {
    at = match.index;
  }
  if (at < 0) return Buffer.concat([body, CLIENT]);
  return Buffer.concat([body.subarray(0, at), CLIENT, body.subarray(at)]);
}

/** Coerce a `write()`/`end()` chunk to the bytes that get buffered. */
function asBuffer(chunk: unknown, encoding: string | undefined): Buffer {
  if (typeof chunk === "string") {
    return Buffer.from(chunk, (encoding ?? "utf8") as BufferEncoding);
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new TypeError(
    'The "chunk" argument must be of type string or an instance of Buffer or Uint8Array',
  );
}

/**
 * Wrap `res` so an html response is buffered until `end()` and the client
 * is spliced in exactly once, however the body was chunked. The wrapper
 * defers the real `writeHead` until the flush, which keeps `headersSent`
 * false for the chain (T026's runner and error paths still work) and lets
 * `Content-Length` be recomputed from the final bytes — or left absent,
 * letting Node chunk. Non-html responses restore the originals at the
 * first header decision and flow through byte for byte.
 */
function installInjection(res: ServerResponse): void {
  const originalHead = res.writeHead;
  const originalWrite = res.write;
  const originalEnd = res.end;

  let mode: "open" | "html" | "pass" = "open";
  let headSeen = false;
  let status = 200;
  let statusReason: string | undefined;
  const headHeaders: OutgoingHttpHeaders = {};
  let chunks: Buffer[] = [];
  const acks: Array<() => void> = [];

  const restore = (): void => {
    res.writeHead = originalHead;
    res.write = originalWrite;
    res.end = originalEnd;
  };

  /**
   * First header decision: `text/html` (from writeHead args, merged into
   * `headHeaders`, or from the store) → keep buffering; anything else →
   * pass the response through untouched.
   */
  const decide = (): boolean => {
    const contentType = headHeaders["content-type"] ??
      res.getHeader("content-type");
    if (
      typeof contentType === "string" &&
      contentType.toLowerCase().startsWith("text/html")
    ) {
      mode = "html";
      return true;
    }
    mode = "pass";
    return false;
  };

  /** Buffer end()'s final chunk (if any) and send the finished response. */
  const flush = (done?: () => void): void => {
    const injected = splice(Buffer.concat(chunks));
    chunks = [];
    restore();

    // Sole ownership of the header set: every header is replayed through
    // the writeHead call below and the setHeader store is cleared, so the
    // wire never depends on Node's merge order between the two sources.
    const stored = res.getHeaders();
    const recordedLength = headHeaders["content-length"] ??
      stored["content-length"];
    const headers: OutgoingHttpHeaders = { ...stored, ...headHeaders };
    for (const key of Object.keys(stored)) res.removeHeader(key);
    delete headers["content-length"];
    if (recordedLength !== undefined) {
      const originalLength = Number(recordedLength);
      // A HEAD response carries no bytes but must advertise the length of
      // the GET it answers for: the original body plus the client.
      headers["content-length"] =
        res.req.method === "HEAD" && Number.isFinite(originalLength)
          ? originalLength + CLIENT.length
          : injected.length;
    }

    const finalStatus = headSeen ? status : res.statusCode;
    if (statusReason !== undefined) {
      res.writeHead(finalStatus, statusReason, headers);
    } else {
      res.writeHead(finalStatus, headers);
    }
    if (done !== undefined) res.end(injected, done);
    else res.end(injected);
    for (const ack of acks.splice(0)) process.nextTick(ack);
  };

  res.writeHead = function writeHeadProxy(
    ...args: unknown[]
  ): ServerResponse {
    const statusArg = typeof args[0] === "number" ? args[0] : 200;
    let reasonArg: string | undefined;
    let rawHeaders: unknown;
    if (typeof args[1] === "string") {
      reasonArg = args[1];
      rawHeaders = args[2];
    } else {
      rawHeaders = args[1];
    }
    const incoming = normalizeHeaders(rawHeaders);
    Object.assign(headHeaders, incoming);
    if (mode === "open" && !decide()) {
      restore();
      return Reflect.apply(originalHead, res, args);
    }
    headSeen = true;
    status = statusArg;
    statusReason = reasonArg;
    return res;
  } as typeof res.writeHead;

  res.write = function writeProxy(...args: unknown[]): boolean {
    if (mode === "open" && !decide()) {
      restore();
      return Reflect.apply(originalWrite, res, args);
    }
    const encoding = typeof args[1] === "string" ? args[1] : undefined;
    const ack =
      typeof args[1] === "function"
        ? (args[1] as () => void)
        : typeof args[2] === "function"
          ? (args[2] as () => void)
          : undefined;
    chunks.push(asBuffer(args[0], encoding));
    if (ack !== undefined) acks.push(ack);
    return true;
  } as typeof res.write;

  res.end = function endProxy(...args: unknown[]): ServerResponse {
    if (mode === "open" && !decide()) {
      restore();
      return Reflect.apply(originalEnd, res, args);
    }
    const raw = [...args];
    let done: (() => void) | undefined;
    if (raw.length > 0 && typeof raw[raw.length - 1] === "function") {
      done = raw.pop() as () => void;
    }
    if (raw.length > 0) {
      const encoding = typeof raw[1] === "string" ? raw[1] : undefined;
      chunks.push(asBuffer(raw[0], encoding));
    }
    flush(done);
    return res;
  } as typeof res.end;
}

/** The injection router entry: wrap, then fall through to the writer. */
const injectHtml: Middleware = (_req, res, next) => {
  installInjection(res);
  next();
};

/** What serve.ts's `src/server/*.ts` scan picks up, in run order. */
export const middleware: Middleware[] = [eventStream, injectHtml];

// --- module init (once per process; after every binding above) ---

// Listener first so no rebuild can complete before the broadcast is armed.
// It stays registered even below, when starting the watcher throws: the
// broadcast then simply has no producer until something else watches.
onAfterRebuild((result) => {
  if (result.ok) broadcast();
});
try {
  startWatching(await loadConfig());
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`kiln serve: watch disabled: ${reason}\n`);
}
