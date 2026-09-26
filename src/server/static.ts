/**
 * T026 — the static file server behind `kiln serve`, and the registration
 * seam T028 plugs into: `createServer(router)` runs the ordered middleware
 * list — each entry either responds or calls `next()` — before the built-in
 * handler, which serves files rooted at the build output with MIME types,
 * directory/`index.html` resolution, the extensionless `<path>.html`
 * fallback, and a `dist/404.html` page. `node:http` only; deliberately no
 * watching, no SSE endpoint, and no HTML injection (T027/T028 own those).
 */
import type { Stats } from "node:fs";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";

/**
 * One router entry (the shape T028's `reload.ts` exports as `middleware`):
 * respond directly, or call `next()` to fall through to the next entry and
 * ultimately the static handler. Async rejection is handled by the runner.
 */
export type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void | Promise<void>;

/** Options for `createServer`. */
export interface ServerOptions {
  /** Absolute path to the directory being served (config `outDir`). */
  root: string;
}

/** MIME types by lowercase extension; everything else is a download. */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
};

/** `stat` that answers "no" instead of throwing (missing/unreadable paths). */
async function statSafe(target: string): Promise<Stats | undefined> {
  try {
    return await stat(target);
  } catch {
    return undefined;
  }
}

/**
 * Stream one file with its MIME type and length, status `status`. Node
 * suppresses response bodies for HEAD on its own, so the same path serves
 * `curl -sI` and `curl -s` — headers are identical, the body is dropped.
 */
async function sendFile(
  filePath: string,
  stats: Stats,
  res: ServerResponse,
  status = 200,
): Promise<void> {
  res.writeHead(status, {
    "content-type": MIME_TYPES[path.extname(filePath).toLowerCase()] ??
      "application/octet-stream",
    "content-length": stats.size,
  });
  if (res.req.method === "HEAD") {
    res.end();
    return;
  }
  await pipeline(createReadStream(filePath), res);
}

/**
 * 404: `dist/404.html` when present (status 404, HTML content type — looked
 * up per request so adding the file turns it on without a restart), else the
 * plain body `404 Not Found`.
 */
async function notFound(root: string, res: ServerResponse): Promise<void> {
  const page = path.join(root, "404.html");
  const stats = await statSafe(page);
  if (stats !== undefined && stats.isFile()) {
    await sendFile(page, stats, res, 404);
    return;
  }
  res.writeHead(404, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": 13,
  });
  res.end("404 Not Found");
}

/**
 * The built-in static handler, in the ticket's resolution order: exact file
 * → directory redirect/index → extensionless `<path>.html` → 404. The
 * decoded request path is re-rooted under `root` and containment-checked
 * before any `stat`, so `..` / `%2e%2e` / `%2f` traversal can never name a
 * path outside the served directory — it just resolves to "not found".
 */
async function handleStatic(
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, {
      "content-type": "text/plain; charset=utf-8",
      allow: "GET, HEAD",
    });
    res.end("405 Method Not Allowed");
    return;
  }

  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    await notFound(root, res);
    return;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    // Malformed percent-encoding matches nothing.
    await notFound(root, res);
    return;
  }

  // Re-root under `root`: strip leading separators (so `path.resolve` cannot
  // treat an absolute-looking path as an escape) and collapse `.`/`..` —
  // then require the result to stay inside `root`. Anything that normalizes
  // outside falls through to 404 without a single byte being read.
  const relative = path.posix.normalize(decoded).replace(/^[/\\]+/, "");
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) {
    await notFound(root, res);
    return;
  }

  // Query strings never reach the filesystem; the redirect preserves them.
  const search = url.search;
  const stats = await statSafe(target);

  if (stats?.isFile()) {
    await sendFile(target, stats, res);
    return;
  }

  if (stats?.isDirectory()) {
    if (!url.pathname.endsWith("/")) {
      res.writeHead(301, { location: `${url.pathname}/${search}` });
      res.end();
      return;
    }
    const index = path.join(target, "index.html");
    const indexStats = await statSafe(index);
    if (indexStats?.isFile()) {
      await sendFile(index, indexStats, res);
      return;
    }
    await notFound(root, res);
    return;
  }

  // Extensionless pretty URL: `/about` → `/about.html`.
  if (path.extname(target) === "") {
    const pretty = `${target}.html`;
    const prettyStats = await statSafe(pretty);
    if (prettyStats?.isFile()) {
      await sendFile(pretty, prettyStats, res);
      return;
    }
  }

  await notFound(root, res);
}

/**
 * The T026→T028 seam: build the `node:http` server around the static
 * handler, running each router middleware first in order. A middleware that
 * calls `next()` falls through (a double call is ignored — the chain has
 * already advanced); one that responds never reaches the static handler.
 */
export function createServer(
  router: readonly Middleware[],
  options: ServerOptions,
): Server {
  const { root } = options;
  return createHttpServer((req, res) => {
    let index = 0;
    const run = (): void => {
      // A middleware that responded (headers sent or stream ended) must not
      // advance the chain even if it also calls next() — the static handler
      // would try to writeHead over a finished response.
      if (res.writableEnded || res.headersSent) return;
      const middleware = router[index];
      if (middleware === undefined) {
        void handleStatic(root, req, res).catch(() => {
          // Mid-stream failure (file vanished / reset socket): there is no
          // honest status left to send, so tear the response down.
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
        return;
      }
      index += 1;
      let advanced = false;
      const next = (): void => {
        if (advanced) return;
        advanced = true;
        run();
      };
      try {
        const result = middleware(req, res, next);
        if (result instanceof Promise) {
          result.catch(() => {
            if (!res.headersSent) res.writeHead(500);
            res.end();
          });
        }
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    };
    run();
  });
}
