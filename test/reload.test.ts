/**
 * T028 acceptance — live reload (SSE).
 *
 * The first test owns the scan-load side effect: it is the only import of
 * `src/server/reload.ts`, performed with the cwd pinned to a dist-only
 * fixture so module init's `startWatching` throws and the warn-and-serve
 * path is pinned. Every later test re-imports the cached module (the ESM
 * registry runs init exactly once), so this file relies on the repo's
 * `--test-concurrency=1` and node:test's declaration-order execution.
 *
 * Layers, cheapest first:
 * - In-process `createServer` (the exact T026 seam) covers the endpoint
 *   contract and the injection matrix — splices split across chunk
 *   boundaries, Content-Length recompute, chunked when unpromised, the
 *   setHeader store, HEAD/GET length agreement, non-HTML passthrough —
 *   then the real watcher → broadcast wiring: exactly one event per ok
 *   rebuild on every client, nothing for a failed rebuild, and closed
 *   clients dropping out of the set.
 * - The shipped partial runs inside `node:vm` against a fake
 *   EventSource/timer/location harness: the first connect is silent, the
 *   named `reload` event reloads, and the backoff ladder is
 *   1s → 2s → 4s → 8s → capped at 10s with a reset after every open.
 * - Child-process `kiln serve` covers the production path end to end: scan
 *   → endpoint → injection → watcher rebuild → reload event, a broken
 *   template staying silent until it is fixed, a restart staying silent
 *   until the next rebuild, and `kiln build` output staying clean.
 *
 * Every bind is ephemeral (listen 0 / free-port probe) and every wait polls
 * a condition with a long deadline (debounce plus real rebuild time).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { loadConfig } from "../src/config.ts";
import { build } from "../src/pipeline/build.ts";
import { createServer } from "../src/server/static.ts";
import type { Middleware } from "../src/server/static.ts";
import { onAfterRebuild, startWatching } from "../src/watch.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(TEST_DIR);
const CLI = path.join(REPO, "src", "cli.ts");
const PARTIAL_PATH = path.join(
  REPO,
  "templates",
  "partials",
  "live-reload.html",
);

/** The exact bytes the injector splices — read once, before any test. */
const partial = await readFile(PARTIAL_PATH, "utf8");

const tempRoots: string[] = [];

after(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** Materialize a fixture project from a `path → bytes` map. */
async function makeFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "kiln-reload-"));
  tempRoots.push(root);
  for (const [name, source] of Object.entries(files)) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  return root;
}

/** Occurrences of `needle` in `haystack` (0 when absent). */
function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Poll `condition` every 25 ms until it holds or `timeoutMs` elapses.
 * Real wall-clock waits on purpose: the debounce timer and the inotify
 * delivery behind these conditions are real, so the waits stay generous
 * and the assertions stay timing-tolerant.
 */
async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(25);
  }
}

/** Run `fn` with stdout/stderr captured; restored even when `fn` throws. */
async function capture<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const previousOut = process.stdout.write;
  const previousErr = process.stderr.write;
  process.stdout.write = ((chunk: unknown): boolean => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown): boolean => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const value = await fn();
    return { value, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = previousOut;
    process.stderr.write = previousErr;
  }
}

/**
 * Run `fn` against an in-process server (the exact seam `kiln serve`
 * wires) on an ephemeral port, tearing the listener and its keep-alive
 * sockets — including held-open SSE streams — down afterwards.
 */
async function withServer<T>(
  root: string,
  router: readonly Middleware[],
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const server: Server = createServer(router, {
    root: path.join(root, "dist"),
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  try {
    const { port } = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    const closed = once(server, "close");
    server.close();
    await closed;
  }
}

/**
 * The scan-loaded router. Deliberately `await import()` rather than a top
 * level static import (test case exercising a module-loading boundary): a
 * static import would run module init at file load — before the first test
 * pins the cwd to the dist-only fixture — starting the watcher against the
 * real repo and making the warn-and-serve path unobservable.
 */
async function reloadMiddleware(): Promise<Middleware[]> {
  const mod = await import("../src/server/reload.ts");
  return mod.middleware;
}

interface SseStream {
  /** Everything received on the wire so far. */
  text(): string;
  /** Resolves once the stream is over (server side or cancel()). */
  closed: Promise<void>;
  cancel(): Promise<void>;
}

/**
 * Open `GET /__reload` and pump the body as it arrives. The endpoint
 * contract (status, headers) is asserted on every open; connection-level
 * failures are retried briefly so a restarted server's dead pooled socket
 * cannot flake a test.
 */
async function openSse(base: string): Promise<SseStream> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${base}/__reload`, {
        headers: { accept: "text/event-stream" },
      });
    } catch (error) {
      lastError = error;
      await sleep(250);
      continue;
    }
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "text/event-stream",
      "Content-Type: text/event-stream",
    );
    assert.equal(response.headers.get("cache-control"), "no-cache");
    const reader = response.body?.getReader();
    assert.ok(reader, "the SSE response streams a body");
    let buffer = "";
    const closed = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += Buffer.from(value).toString("utf8");
        }
      } catch {
        // Socket torn down (server stop / cancel): the stream is over.
      }
    })();
    return {
      text: () => buffer,
      closed,
      cancel: async () => {
        await reader.cancel().catch(() => undefined);
      },
    };
  }
  throw lastError;
}

/** Find a port nobody holds: bind 0, read the port, release it. */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  const listening = once(probe, "listening");
  probe.listen(0);
  await listening;
  const { port } = probe.address() as AddressInfo;
  const closed = once(probe, "close");
  probe.close();
  await closed;
  return port;
}

interface ServeChild {
  stdout: string;
  stderr: string;
  stop: () => Promise<void>;
}

/**
 * Spawn the real CLI (`kiln serve --port <p>` in `cwd`) and wait until it
 * answers; `stop()` kills and reaps the child and is safe to call twice.
 */
async function startServe(cwd: string, port: number): Promise<ServeChild> {
  const child = spawn(process.execPath, [CLI, "serve", "--port", String(port)], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.stdout === null || child.stderr === null) {
    throw new Error("serve child stdio was not piped");
  }
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const exited = once(child, "exit");
  void exited.catch(() => undefined);

  const deadline = Date.now() + 8000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `serve exited before ready; stdout=${stdout} stderr=${stderr}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) {
        await response.arrayBuffer();
        break;
      }
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`serve never answered; stdout=${stdout} stderr=${stderr}`);
    }
    await sleep(30);
  }

  return {
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      await exited;
    },
  };
}

/** One watched content-file change — the watcher's debounce coalesces. */
async function editContent(root: string, body: string): Promise<void> {
  await writeFile(
    path.join(root, "content", "index.md"),
    `---\ntitle: Home\n---\n${body}\n`,
    "utf8",
  );
}

/** The buildable two-page fixture the watcher and child tests share. */
const LAYOUT =
  '<!doctype html>\n<html lang="en"><head><title>{{ site.title }}</title></head>' +
  "<body>{{ content | safe }}</body></html>\n";

const PROJECT: Record<string, string> = {
  "templates/post.html": LAYOUT,
  "content/index.md": "---\ntitle: Home\n---\nHello **live** reload.",
  "public/app.css": "body { margin: 0; }\n",
  "public/data.json": '{"ok":true}\n',
};

test("scan load: missing watch roots warn; GET /__reload streams200", async () => {
  // The scan's import, with the cwd a dist-only fixture: all three watch
  // roots are missing, so startWatching throws and init must print a
  // warning instead of failing the scan.
  const noWatchRoot = await makeFixture({
    "dist/index.html": "<html><body>dist only</body></html>\n",
  });
  const captured = await capture(async () => {
    const previous = process.cwd();
    process.chdir(noWatchRoot);
    try {
      await reloadMiddleware();
    } finally {
      process.chdir(previous);
    }
  });
  assert.match(captured.stderr, /watch disabled/);
  assert.match(captured.stderr, /no watchable root/);
  assert.ok(
    !captured.stderr.includes("\n    at "),
    "the warning carries no stack trace",
  );

  // The server and the endpoint still run.
  await withServer(noWatchRoot, await reloadMiddleware(), async (base) => {
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    await home.arrayBuffer();

    const sse = await openSse(base);
    try {
      await waitFor(() => sse.text().includes(": ping"), 3000, "the initial ping");
      assert.ok(
        sse.text().startsWith(": ping"),
        "the stream opens with the keep-alive comment",
      );
      await sleep(400); // several ping intervals short of the 25s cadence
      assert.ok(
        !sse.text().includes("event: reload"),
        "a fresh connection stays silent",
      );
    } finally {
      await sse.cancel();
    }
  });
});

test("injection: html gets the client once before </body>; non-html stays byte-identical", async () => {
  const root = await makeFixture({
    "dist/index.html":
      '<!doctype html>\n<html lang="en"><head><title>Home</title></head>\n' +
      "<body><p>home</p></body></html>\n",
    "dist/shout.html":
      '<!doctype html>\n<html><body><p>LOUD</p></BODY></html>\n',
    "dist/no-body.html":
      '<!doctype html>\n<html><head><title>x</title></head><p>no tag</p></html>\n',
    "dist/style.css": "body { color: #111; }\n",
    "dist/data.json": '{"ok":true}\n',
    "dist/app.js": "console.log(1);\n",
  });
  await withServer(root, await reloadMiddleware(), async (base) => {
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.equal(
      home.headers.get("content-type"),
      "text/html; charset=utf-8",
    );
    const html = await home.text();
    assert.equal(countOf(html, partial), 1, "the client lands exactly once");
    assert.equal(countOf(html, "EventSource"), 1, "one client script total");
    assert.ok(
      html.indexOf(partial) >= 0 &&
        html.indexOf(partial) < html.lastIndexOf("</body>"),
      "immediately before </body>",
    );
    assert.equal(
      home.headers.get("content-length"),
      String(Buffer.byteLength(html, "utf8")),
      "Content-Length describes the injected bytes",
    );

    // A case-variant close tag still counts.
    const shout = await (await fetch(`${base}/shout.html`)).text();
    assert.equal(countOf(shout, partial), 1);
    assert.ok(
      shout.indexOf(partial) < shout.lastIndexOf("</BODY>"),
      "case-insensitive </body> splice",
    );

    // No </body> at all → the client is appended at the end.
    const noBody = await (await fetch(`${base}/no-body.html`)).text();
    assert.equal(countOf(noBody, partial), 1);
    assert.equal(noBody.slice(-partial.length), partial, "appended verbatim");

    // HEAD advertises exactly the length GET delivers, with no body.
    const head = await fetch(`${base}/`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(
      head.headers.get("content-length"),
      home.headers.get("content-length"),
      "HEAD and GET agree on the injected length",
    );
    assert.equal(await head.text(), "");

    // Non-HTML: byte-identical to disk, no client, correct MIME.
    for (const [route, file, type] of [
      ["/style.css", "dist/style.css", "text/css; charset=utf-8"],
      ["/data.json", "dist/data.json", "application/json"],
      ["/app.js", "dist/app.js", "text/javascript; charset=utf-8"],
    ] as const) {
      const response = await fetch(`${base}${route}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), type);
      const body = await response.text();
      assert.equal(body, await readFile(path.join(root, file), "utf8"));
      assert.ok(!body.includes("EventSource"), `${route} stays untouched`);
    }

    // The plain-text 404 (no dist/404.html) is untouched too.
    const missing = await fetch(`${base}/missing`);
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), "404 Not Found");
  });
});

test("injection: chunked writes splice once; status and stored headers survive", async () => {
  const root = await makeFixture({
    "dist/index.html": "<html><body>static</body></html>\n",
  });
  const original = "<html><body><p>chunked</body></html>";
  const writer: Middleware = (req, res, next) => {
    const pathname = new URL(req.url ?? "/", "http://t").pathname;
    if (pathname === "/split") {
      // Content-Length promises the pre-injection size: the flush must
      // recompute it or fetch would truncate/hang on the response.
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(Buffer.byteLength(original)),
        "x-origin": "writer",
      });
      res.write("<html><bo");
      res.write("dy><p>chunked</bo");
      res.write("dy></html>");
      res.end();
      return;
    }
    if (pathname === "/nolen") {
      // No Content-Length was promised: the response stays chunked.
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.write("<body>implicit ");
      res.end("chunked</body>");
      return;
    }
    if (pathname === "/stored") {
      // Headers live only in the setHeader store, never in writeHead args.
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("x-stored", "yes");
      res.setHeader("content-length", String(Buffer.byteLength(original)));
      res.writeHead(200);
      res.write(original.slice(0, 20));
      res.end(original.slice(20));
      return;
    }
    next();
  };
  const router = [...(await reloadMiddleware()), writer];
  await withServer(root, router, async (base) => {
    const split = await fetch(`${base}/split`);
    assert.equal(split.status, 200);
    assert.equal(split.headers.get("x-origin"), "writer");
    const splitHtml = await split.text();
    assert.equal(
      split.headers.get("content-length"),
      String(Buffer.byteLength(splitHtml, "utf8")),
      "the promised length is recomputed after the splice",
    );
    assert.equal(
      countOf(splitHtml, partial),
      1,
      "a </body> split across three writes still splices once",
    );
    assert.ok(splitHtml.indexOf(partial) < splitHtml.lastIndexOf("</body>"));

    const nolen = await fetch(`${base}/nolen`);
    assert.equal(nolen.status, 404, "a non-200 status survives the splice");
    assert.equal(
      nolen.headers.get("content-length"),
      null,
      "no length is invented when none was promised",
    );
    assert.equal(nolen.headers.get("transfer-encoding"), "chunked");
    const nolenHtml = await nolen.text();
    assert.equal(countOf(nolenHtml, partial), 1);

    const stored = await fetch(`${base}/stored`);
    assert.equal(stored.headers.get("x-stored"), "yes");
    const storedHtml = await stored.text();
    assert.equal(
      stored.headers.get("content-length"),
      String(Buffer.byteLength(storedHtml, "utf8")),
    );
    assert.equal(countOf(storedHtml, partial), 1);

    // Paths the writer ignores still fall through to the static handler.
    const fallthrough = await fetch(`${base}/`);
    assert.equal(fallthrough.status, 200);
    assert.equal(countOf(await fallthrough.text(), partial), 1);
  });
});

test("broadcast: ok rebuilds reach every client once; failures and closed clients stay silent", async () => {
  const root = await makeFixture(PROJECT);
  // T010 resolves templates/ against the cwd — same as kiln build in
  // normal use — so the whole watcher cycle runs inside the fixture.
  const previous = process.cwd();
  process.chdir(root);
  try {
    await capture(() => build({ cwd: root })); // seed dist/
    const router = await reloadMiddleware();
    await withServer(root, router, async (base) => {
      const attempts: boolean[] = [];
      const off = onAfterRebuild((result) => attempts.push(result.ok));
      const handle = startWatching(await loadConfig(root));
      try {
        const sseA = await openSse(base);
        const sseB = await openSse(base);
        try {
          await waitFor(
            () => sseA.text().includes(": ping") && sseB.text().includes(": ping"),
            3000,
            "both initial pings",
          );
          assert.ok(!sseA.text().includes("event: reload"));

          // One edit → one ok rebuild → one event on BOTH clients.
          const { stdout } = await capture(async () => {
            await editContent(root, "edited once");
            await waitFor(
              () => countOf(sseA.text(), "event: reload") >= 1,
              15000,
              "the reload event on client A",
            );
            await waitFor(
              () => countOf(sseB.text(), "event: reload") >= 1,
              15000,
              "the reload event on client B",
            );
            await sleep(600); // several debounce windows: no double-fire
          });
          assert.match(stdout, /rebuild in \d+ms/, "after the rebuild line");
          assert.equal(countOf(sseA.text(), "event: reload"), 1);
          assert.equal(countOf(sseB.text(), "event: reload"), 1);
          assert.match(
            sseA.text(),
            /event: reload\ndata:\n\n/,
            "the named event carries an empty payload",
          );

          // One capture spans the failed attempt, the fix, and the third
          // edit — it keeps the watcher's build reports out of the test log
          // (assertions throw straight through it; restore is in `finally`).
          await capture(async () => {
            // A broken template → failed rebuild → no event at all.
            await writeFile(
              path.join(root, "templates", "post.html"),
              "{{ broken",
            );
            await waitFor(
              () => attempts.length >= 2,
              15000,
              "the failed attempt",
            );
            assert.equal(attempts[0], true, "the first edit went green");
            assert.equal(attempts[1], false, "the broken template really failed");
            await sleep(600);
            assert.equal(
              countOf(sseA.text(), "event: reload"),
              1,
              "a failed rebuild broadcasts nothing",
            );

            // Fixing the template is itself a save → the next rebuild goes out.
            await writeFile(path.join(root, "templates", "post.html"), LAYOUT);
            await waitFor(
              () => attempts.length >= 3 && attempts[2] === true,
              15000,
              "the green rebuild",
            );
            await waitFor(
              () => countOf(sseA.text(), "event: reload") >= 2,
              5000,
              "the reload event after the fix",
            );
            assert.equal(countOf(sseB.text(), "event: reload"), 2);

            // B's connection goes away: it leaves the broadcast set (no
            // further frames reach it) while A keeps receiving and the
            // server keeps serving.
            await sseB.cancel();
            await sleep(300); // let the close reach the server
            await editContent(root, "client A only");
            await waitFor(
              () => attempts.length >= 4 && attempts[3] === true,
              15000,
              "the third rebuild",
            );
            await waitFor(
              () => countOf(sseA.text(), "event: reload") >= 3,
              5000,
              "the third reload event on client A",
            );
            assert.equal(countOf(sseB.text(), "event: reload"), 2);
          });
          const stillServing = await fetch(`${base}/`);
          assert.equal(stillServing.status, 200);
          await stillServing.arrayBuffer();
        } finally {
          await sseA.cancel();
          await sseB.cancel();
        }
      } finally {
        off();
        await handle.close();
      }
    });
  } finally {
    process.chdir(previous);
  }
});

test("client partial: first connect silent; reload reloads; backoff 1→2→4→8→10s", async () => {
  const script = /<script>([\s\S]*)<\/script>/.exec(partial);
  assert.ok(script, "the shipped partial is a bare script block");

  const instances: FakeEventSource[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let reloads = 0;

  class FakeEventSource {
    readonly url: string;
    closed = false;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private readonly listeners = new Map<string, () => void>();
    constructor(url: string) {
      this.url = url;
      instances.push(this);
    }
    addEventListener(type: string, listener: () => void): void {
      this.listeners.set(type, listener);
    }
    close(): void {
      this.closed = true;
    }
    /** Test hooks: drive what a browser would fire. */
    fireOpen(): void {
      this.onopen?.();
    }
    fireError(): void {
      this.onerror?.();
    }
    fireReload(): void {
      this.listeners.get("reload")?.();
    }
  }

  const context = createContext({
    EventSource: FakeEventSource,
    location: { reload: () => (reloads += 1) },
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length;
    },
  });
  runInContext(script[1], context);

  // Initial connect: constructed, silent.
  assert.equal(instances.length, 1, "the script opens one EventSource");
  assert.equal(instances[0].url, "/__reload");
  assert.equal(reloads, 0, "the first connection must not reload");
  instances[0].fireOpen();
  assert.equal(reloads, 0, "a successful open must not reload");

  // A restart-style outage: errors chain reconnects, still no reload.
  const waits: number[] = [];
  instances[0].fireError();
  assert.ok(instances[0].closed, "onerror closes the source before retrying");
  while (waits.length < 7) {
    const timer = timers.shift();
    assert.ok(timer, `backoff step ${waits.length + 1} was scheduled`);
    waits.push(timer.ms);
    timer.fn();
    assert.equal(instances.length, waits.length + 1, "each step reconnects");
    assert.equal(reloads, 0, "reconnects alone must never reload");
    instances[instances.length - 1].fireError();
  }
  assert.deepEqual(
    waits,
    [1000, 2000, 4000, 8000, 10000, 10000, 10000],
    "1s → 2s → 4s → 8s → capped at 10s",
  );

  // The ladder's pending wait sits at the cap; consuming it yields a fresh
  // source, and a successful open there resets the delay for the next outage.
  const pending = timers.shift();
  assert.ok(pending, "the ladder left a reconnect scheduled");
  assert.equal(pending.ms, 10000, "the wait stays capped at 10s");
  pending.fn();
  const fresh = instances[instances.length - 1];
  fresh.fireOpen();
  fresh.fireError();
  const afterReset = timers.shift();
  assert.ok(afterReset, "a reconnect is scheduled after the reset");
  assert.equal(afterReset.ms, 1000, "open resets the delay to 1s");
  afterReset.fn();

  // The named event — the only reload trigger — reloads exactly once.
  instances[instances.length - 1].fireReload();
  assert.equal(reloads, 1, "the reload event reloads the page");
});

test("kiln serve e2e: clean build output, injection, rebuild → reload, quiet restart", async () => {
  const root = await makeFixture(PROJECT);

  // Production output stays free of the client.
  const built = spawnSync(process.execPath, [CLI, "build"], {
    cwd: root,
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(built.status, 0, built.stderr);
  const onDisk = await readFile(path.join(root, "dist", "index.html"), "utf8");
  assert.ok(!onDisk.includes("EventSource"), "no client in dist/index.html");
  assert.ok(!onDisk.includes("__reload"), "no endpoint reference on disk");

  const port = await freePort();
  const serving = await startServe(root, port);
  try {
    // The served page carries the client exactly once, assets do not.
    const home = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.equal(countOf(html, partial), 1, "injected exactly once");
    assert.ok(html.indexOf(partial) < html.lastIndexOf("</body>"));
    const css = await fetch(`http://127.0.0.1:${port}/app.css`);
    assert.equal(css.status, 200);
    assert.ok(!(await css.text()).includes("EventSource"));
    const json = await fetch(`http://127.0.0.1:${port}/data.json`);
    assert.equal(json.headers.get("content-type"), "application/json");
    assert.ok(!(await json.text()).includes("EventSource"));

    // Touching a content file pushes `event: reload` after the rebuild.
    const sse = await openSse(`http://127.0.0.1:${port}`);
    try {
      await waitFor(() => sse.text().includes(": ping"), 3000, "the initial ping");
      assert.ok(!sse.text().includes("event: reload"), "first connect silent");
      await editContent(root, "served over SSE");
      await waitFor(
        () => /rebuild in \d+ms/.test(serving.stdout),
        15000,
        "the rebuild line on stdout",
      );
      await waitFor(
        () => countOf(sse.text(), "event: reload") >= 1,
        5000,
        "the reload event on the stream",
      );
    } finally {
      await sse.cancel();
    }

    // Kill serve under the open page: the stream ends, nothing reloads.
    await serving.stop();
    const died = await Promise.race([
      sse.closed.then(() => true),
      sleep(6000).then(() => false),
    ]);
    assert.ok(died, "the stream ends when serve dies");
    assert.equal(countOf(sse.text(), "event: reload"), 1);

    // Restart on the same port: a reconnect stays silent until the next
    // rebuild actually completes.
    const serving2 = await startServe(root, port);
    try {
      const sse2 = await openSse(`http://127.0.0.1:${port}`);
      try {
        await waitFor(
          () => sse2.text().includes(": ping"),
          3000,
          "the reconnect ping",
        );
        await sleep(600); // debounce + rebuild windows: no spontaneous event
        assert.ok(
          !sse2.text().includes("event: reload"),
          "a reconnect never reloads on its own",
        );
        await editContent(root, "after the restart");
        await waitFor(
          () => /rebuild in \d+ms/.test(serving2.stdout),
          15000,
          "the post-restart rebuild line",
        );
        await waitFor(
          () => countOf(sse2.text(), "event: reload") >= 1,
          5000,
          "the post-restart reload event",
        );
      } finally {
        await sse2.cancel();
      }
    } finally {
      await serving2.stop();
    }
  } finally {
    await serving.stop();
  }
});

test("kiln serve e2e: a broken template sends no reload; fixing it does", async () => {
  const root = await makeFixture(PROJECT);
  const built = spawnSync(process.execPath, [CLI, "build"], {
    cwd: root,
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(built.status, 0, built.stderr);

  const port = await freePort();
  const serving = await startServe(root, port);
  try {
    const sse = await openSse(`http://127.0.0.1:${port}`);
    try {
      await waitFor(() => sse.text().includes(": ping"), 3000, "the initial ping");

      // Break the template and save: the rebuild fails, nothing goes out.
      await writeFile(path.join(root, "templates", "post.html"), "{{ broken");
      await waitFor(
        () => /rebuild failed in \d+ms/.test(serving.stderr),
        15000,
        "the failed rebuild line on stderr",
      );
      await sleep(700); // the event, if any, would already have arrived
      assert.equal(
        countOf(sse.text(), "event: reload"),
        0,
        "a failed rebuild sends no reload event",
      );

      // Fixing it is the next save: green rebuild → the event lands.
      await writeFile(path.join(root, "templates", "post.html"), LAYOUT);
      await waitFor(
        () => /rebuild in \d+ms/.test(serving.stdout),
        15000,
        "the green rebuild line",
      );
      await waitFor(
        () => countOf(sse.text(), "event: reload") >= 1,
        5000,
        "the reload event after the fix",
      );
    } finally {
      await sse.cancel();
    }
  } finally {
    await serving.stop();
  }
});
