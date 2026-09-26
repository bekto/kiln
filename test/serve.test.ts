/**
 * T026 acceptance — `kiln serve` and the `createServer(router)` seam.
 *
 * Every live bind is ephemeral: in-process servers listen on port 0 and
 * spawned commands get a port carved out by a throwaway listener first, so
 * this file never collides with a sibling test or a dev server. Static-file
 * behavior (MIME, routes, 404, traversal, seam) runs in-process against
 * `createServer` directly — the exact handler `run()` wires up; command
 * wiring (port precedence, EADDRINUSE, missing dist, route scan, no-watch)
 * runs against the real CLI in child processes, which also contains the
 * side effects of any `src/server/*.ts` module a later wave adds.
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
import { loadConfig } from "../src/config.ts";
import { run as runServe } from "../src/commands/serve.ts";
import { createServer } from "../src/server/static.ts";
import type { Middleware } from "../src/server/static.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(TEST_DIR);
const CLI = path.join(REPO, "src", "cli.ts");

const tempRoots: string[] = [];

/** Materialize a fixture project from a `path → bytes` map. */
async function makeFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "kiln-serve-"));
  tempRoots.push(root);
  for (const [name, source] of Object.entries(files)) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  return root;
}

after(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** A built-site fixture: pages, assets of every mapped type, a pretty URL. */
const DIST: Record<string, string> = {
  "dist/index.html": "<!doctype html>\n<title>Home</title>\n<p>home body</p>\n",
  "dist/posts/index.html": "<!doctype html>\n<p>posts index</p>\n",
  "dist/about.html": "<!doctype html>\n<p>about page</p>\n",
  "dist/style.css": "body { color: #111; }\n",
  "dist/app.js": "console.log('app');\n",
  "dist/data.json": '{"ok":true}\n',
  "dist/logo.svg": '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
  "dist/font.woff2": "wOF2fake",
  "dist/pic.png": "PNGfake",
  "dist/photo.jpg": "JPGfake",
  "dist/photo.jpeg": "JPEGfake",
  "dist/mystery.bin": "rawbytes",
};

/** A fixture with content/ next to dist/ — for the "no rebuild" proof. */
const SITE: Record<string, string> = {
  ...DIST,
  "content/hello.md": "---\ntitle: Hello\n---\nOriginal body.\n",
};

/**
 * Run `fn` against an in-process static server bound to an ephemeral port,
 * always closing the listener and its keep-alive sockets afterwards. The
 * fixture is laid out `<root>/dist/…` — that built directory is what
 * `kiln serve` passes as config outDir.
 */
async function withStatic<T>(
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

/**
 * Send a request line the WHATWG URL parser would rewrite away: fetch()
 * collapses `..` (raw and `%2e%2e`) before anything hits the wire, so the
 * traversal acceptance criteria need a raw socket to prove what the server
 * itself does with the literal path.
 */
async function rawRequest(
  port: number,
  rawPath: string,
): Promise<{ status: number; body: string }> {
  const socket = net.connect(port, "127.0.0.1");
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  await once(socket, "connect");
  socket.write(
    `GET ${rawPath} HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n`,
  );
  await once(socket, "close");
  const raw = Buffer.concat(chunks).toString("latin1");
  const split = raw.indexOf("\r\n\r\n");
  return {
    status: Number(raw.slice(0, split).split(" ")[1]),
    body: raw.slice(split + 4),
  };
}

interface Captured {
  stdout: string;
  stderr: string;
}

/** Capture the streams `run()` writes to, restoring them even on throw. */
async function capture(fn: () => Promise<void>): Promise<Captured> {
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
    await fn();
    return { stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = previousOut;
    process.stderr.write = previousErr;
  }
}

interface CommandRun {
  stdout: string;
  stderr: string;
  exitCode: number | string | undefined;
}

/** Invoke `kiln serve`'s `run` in-process, capturing streams + exitCode. */
async function runCommand(args: string[]): Promise<CommandRun> {
  const previousExit = process.exitCode;
  process.exitCode = undefined;
  try {
    const captured = await capture(() => runServe(args));
    return {
      stdout: captured.stdout,
      stderr: captured.stderr,
      exitCode: process.exitCode,
    };
  } finally {
    process.exitCode = previousExit;
  }
}

interface ServeChild {
  stdout: string;
  stderr: string;
  stop: () => Promise<void>;
}

/**
 * Spawn the real CLI (`kiln serve <args>`) in `cwd` and wait until it
 * answers on `readyPort` (the port the run is expected to bind — via
 * `--port` in `args` or via the fixture's config). Returns live
 * stdout/stderr accessors plus a `stop()` that kills and reaps the child.
 * The exit promise is created at spawn so `stop()` can never hang on a
 * child that already died.
 */
async function startServe(
  cwd: string,
  args: readonly string[],
  readyPort: number,
): Promise<ServeChild> {
  const child = spawn(process.execPath, [CLI, "serve", ...args], {
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
  // The guard marks rejections handled for paths that never await it; the
  // awaiting paths still see the original rejection.
  void exited.catch(() => undefined);

  const deadline = Date.now() + 8000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `serve exited before ready; stdout=${stdout} stderr=${stderr}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${readyPort}/`);
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

test("GET / and /posts/ serve index.html; HEAD returns headers only", async () => {
  const root = await makeFixture(DIST);
  await withStatic(root, [], async (base) => {
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.equal(home.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(await home.text(), DIST["dist/index.html"]);

    const posts = await fetch(`${base}/posts/`);
    assert.equal(posts.status, 200);
    assert.equal(posts.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(await posts.text(), DIST["dist/posts/index.html"]);

    // curl -sI parity: headers, no body.
    const head = await fetch(`${base}/`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(await head.text(), "");
  });
});

test("MIME map: every mapped extension exact; unknown → octet-stream", async () => {
  const root = await makeFixture(DIST);
  const expected: Record<string, string> = {
    "/style.css": "text/css; charset=utf-8",
    "/app.js": "text/javascript; charset=utf-8",
    "/data.json": "application/json",
    "/logo.svg": "image/svg+xml",
    "/font.woff2": "font/woff2",
    "/pic.png": "image/png",
    "/photo.jpg": "image/jpeg",
    "/photo.jpeg": "image/jpeg",
    "/mystery.bin": "application/octet-stream",
  };
  await withStatic(root, [], async (base) => {
    for (const [route, type] of Object.entries(expected)) {
      const response = await fetch(`${base}${route}`);
      assert.equal(response.status, 200, route);
      assert.equal(response.headers.get("content-type"), type, route);
      await response.arrayBuffer();
    }
  });
});

test("routes: /posts redirects 301 (query kept); /about serves about.html", async () => {
  const root = await makeFixture(DIST);
  await withStatic(root, [], async (base) => {
    const redirect = await fetch(`${base}/posts`, { redirect: "manual" });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get("location"), "/posts/");
    await redirect.arrayBuffer();

    const withQuery = await fetch(`${base}/posts?x=1`, { redirect: "manual" });
    assert.equal(withQuery.status, 301);
    assert.equal(withQuery.headers.get("location"), "/posts/?x=1");
    await withQuery.arrayBuffer();

    const pretty = await fetch(`${base}/about`);
    assert.equal(pretty.status, 200);
    assert.equal(pretty.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(await pretty.text(), DIST["dist/about.html"]);
  });
});

test("404: plain body without dist/404.html; custom page once it exists", async () => {
  const root = await makeFixture(DIST);
  await withStatic(root, [], async (base) => {
    const plain = await fetch(`${base}/nope`);
    assert.equal(plain.status, 404);
    assert.equal(plain.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(await plain.text(), "404 Not Found");

    const head = await fetch(`${base}/nope`, { method: "HEAD" });
    assert.equal(head.status, 404);
    assert.equal(await head.text(), "");

    // Adding the page is picked up per request — no restart involved.
    await writeFile(
      path.join(root, "dist", "404.html"),
      "<!doctype html>\n<p>custom not found</p>\n",
    );
    const custom = await fetch(`${base}/nope`);
    assert.equal(custom.status, 404);
    assert.equal(custom.headers.get("content-type"), "text/html; charset=utf-8");
    assert.match(await custom.text(), /custom not found/);

    // An existing page is unaffected by the 404 page.
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    await home.arrayBuffer();
  });
});

test("traversal: /../../etc/passwd and %2e%2e variants → 404, no external bytes", async () => {
  const root = await makeFixture(DIST);
  // A secret OUTSIDE the served root — if containment ever leaks, this is
  // what a `..` climb would reach.
  await writeFile(path.join(root, "secret.txt"), "SECRET-TOKEN");
  await withStatic(root, [], async (base) => {
    const port = Number(new URL(base).port);
    for (const attack of [
      "/../../etc/passwd",
      "/%2e%2e/%2e%2e/etc/passwd",
      "/..%2f..%2fetc/passwd",
      "/../secret.txt",
      "/%2e%2e/secret.txt",
      "/..%2fsecret.txt",
    ]) {
      const { status, body } = await rawRequest(port, attack);
      assert.equal(status, 404, attack);
      assert.doesNotMatch(body, /root:/, attack);
      assert.doesNotMatch(body, /SECRET-TOKEN/, attack);
    }
  });
});

test("seam: a router middleware answers its route; static serves the rest", async () => {
  const root = await makeFixture(DIST);
  const probe: Middleware = (req, res, next) => {
    if (new URL(req.url ?? "/", "http://t").pathname === "/__mw") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("middleware wins");
      return;
    }
    next();
  };
  await withStatic(root, [probe], async (base) => {
    const mware = await fetch(`${base}/__mw`);
    assert.equal(mware.status, 200);
    assert.equal(await mware.text(), "middleware wins");

    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.equal(await home.text(), DIST["dist/index.html"]);

    const missing = await fetch(`${base}/nope`);
    assert.equal(missing.status, 404);
    await missing.arrayBuffer();
  });
});

test("scan: a middleware registered in src/server/ is served by kiln serve", async () => {
  const root = await makeFixture(DIST);
  const probeFile = path.join(REPO, "src", "server", "__scan_probe.ts");
  try {
    await writeFile(
      probeFile,
      `import type { Middleware } from "./static.ts";
export const middleware: Middleware[] = [
  (req, res, next) => {
    if (new URL(req.url ?? "/", "http://t").pathname === "/__scan_probe") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("scan probe wins");
      return;
    }
    next();
  },
];
`,
    );
    const port = await freePort();
    // The full pipeline: serve.ts's src/server/ scan → createServer router →
    // the probe answers instead of the static handler (which would 404).
    const serving = await startServe(root, ["--port", String(port)], port);
    try {
      const probe = await fetch(`http://127.0.0.1:${port}/__scan_probe`);
      assert.equal(probe.status, 200);
      assert.equal(await probe.text(), "scan probe wins");

      // Static fallthrough still works through the full router. Non-HTML on
      // purpose: any future HTML-injection middleware leaves JSON untouched.
      const json = await fetch(`http://127.0.0.1:${port}/data.json`);
      assert.equal(json.status, 200);
      assert.equal(json.headers.get("content-type"), "application/json");
      assert.equal(await json.text(), DIST["dist/data.json"]);
    } finally {
      await serving.stop();
    }
  } finally {
    await rm(probeFile, { force: true });
  }
});

test("scan: a module without a middleware export is ignored", async () => {
  const root = await makeFixture(DIST);
  const bareFile = path.join(REPO, "src", "server", "__scan_bare.ts");
  try {
    await writeFile(bareFile, `export const somethingElse = 1;\n`);
    // If the scan threw on the bare module, the child would exit before
    // answering and startServe would fail with its stderr.
    const port = await freePort();
    const serving = await startServe(root, ["--port", String(port)], port);
    try {
      const home = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(home.status, 200);
      await home.arrayBuffer();
    } finally {
      await serving.stop();
    }
  } finally {
    await rm(bareFile, { force: true });
  }
});

test("usage: bad --port values and unknown tokens exit 2 naming --port", async () => {
  for (const args of [
    ["--port", "abc"],
    ["--port"],
    ["--port", "0"],
    ["--port", "65536"],
    ["--port", "1.5"],
  ]) {
    const run = await runCommand(args);
    assert.equal(run.exitCode, 2, args.join(" "));
    assert.match(run.stderr, /^kiln: serve:/);
    assert.match(run.stderr, /--port/);
    assert.match(run.stderr, /usage: kiln serve/);
    assert.equal(run.stdout, "");
  }

  for (const args of [["--bogus"], ["5000"]]) {
    const run = await runCommand(args);
    assert.equal(run.exitCode, 2, args.join(" "));
    assert.match(run.stderr, /^kiln: serve:/);
    assert.match(run.stderr, /usage: kiln serve/);
  }
});

test("serve: config port is used and printed; --port overrides it", async () => {
  const configPort = await freePort();
  const overridePort = await freePort();
  const root = await makeFixture({
    ...DIST,
    "kiln.config.ts": `export default { port: ${configPort} };\n`,
  });

  // No --port token → the config key decides the bind, observable via the
  // printed line AND a working fetch.
  const configFile = await startServe(root, [], configPort);
  try {
    assert.match(
      configFile.stdout,
      new RegExp(`^serving dist/ at http://localhost:${configPort}$`, "m"),
    );
    const served = await fetch(`http://127.0.0.1:${configPort}/`);
    assert.equal(served.status, 200);
    await served.arrayBuffer();
  } finally {
    await configFile.stop();
  }

  // --port beats the config key: the override answers, the config one stays
  // dark (its child is already stopped, nothing rebinds it).
  const overridden = await startServe(root, ["--port", String(overridePort)], overridePort);
  try {
    assert.match(
      overridden.stdout,
      new RegExp(`^serving dist/ at http://localhost:${overridePort}$`, "m"),
    );
    const moved = await fetch(`http://127.0.0.1:${overridePort}/`);
    assert.equal(moved.status, 200);
    await moved.arrayBuffer();
    await assert.rejects(fetch(`http://127.0.0.1:${configPort}/`));
  } finally {
    await overridden.stop();
  }
});

test("serve: default port is T003's config default (4173), no --port needed", async () => {
  // The suite never binds 4173 (ephemeral-only policy): the default is a
  // composition — loadConfig() yields 4173 with no config file (T003's
  // contract, pinned in config.test.ts), and the test above proves serve
  // listens on exactly config.port when --port is absent.
  const root = await makeFixture({ "dist/index.html": DIST["dist/index.html"] });
  const config = await loadConfig(root);
  assert.equal(config.port, 4173);
});

test("serve: EADDRINUSE exits 1 with the actionable port message, no stack", async () => {
  // Dist-only fixture: no watch roots, so even a future server-module scan
  // that starts a watcher throws it off cleanly and the child always exits.
  const root = await makeFixture(DIST);
  // Bind first and hold: the spawned CLI must fail against a live listener.
  const blocker = net.createServer();
  const listening = once(blocker, "listening");
  blocker.listen(0);
  await listening;
  const port = (blocker.address() as AddressInfo).port;
  try {
    const result = spawnSync(
      process.execPath,
      [CLI, "serve", "--port", String(port)],
      { cwd: root, encoding: "utf8", timeout: 15000 },
    );
    assert.equal(result.status, 1);
    // Unanchored: a future server module may print a warning first.
    assert.match(
      result.stderr,
      new RegExp(
        `port ${port} is already in use — pick another with kiln serve --port ${port + 1}`,
      ),
    );
    assert.doesNotMatch(result.stdout, /serving/, "never bound");
    assert.doesNotMatch(result.stderr, /EADDRINUSE/, "no raw errno");
    assert.doesNotMatch(result.stderr, /\n\s+at /, "no stack trace");
  } finally {
    const closed = once(blocker, "close");
    blocker.close();
    await closed;
  }
});

test("serve: without dist/ exits 1 telling the user to run kiln build", async () => {
  const root = await makeFixture({ "content/hello.md": SITE["content/hello.md"] });
  const result = spawnSync(process.execPath, [CLI, "serve"], {
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /kiln: /);
  assert.match(result.stderr, /kiln build/);
  assert.doesNotMatch(result.stderr, /\n\s+at /, "no stack trace");
});

test("serve: editing content/ triggers no rebuild and no response change", async () => {
  const port = await freePort();
  const root = await makeFixture(SITE);
  const serving = await startServe(root, ["--port", String(port)], port);
  try {
    const before = await fetch(`http://127.0.0.1:${port}/`);
    const beforeBody = await before.text();

    await writeFile(
      path.join(root, "content", "hello.md"),
      "---\ntitle: Hello\n---\nEdited body — must not propagate.\n",
    );
    await sleep(300); // well past watch.debounceMs's default 100 ms window

    const afterEdit = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(afterEdit.status, 200);
    assert.equal(await afterEdit.text(), beforeBody, "served bytes unchanged");
    // T026 itself never watches: no rebuild line on stdout. (A later wave's
    // watcher failing a rebuild would print to stderr, not here.)
    assert.doesNotMatch(serving.stdout, /rebuild/);
    const emitted = await readFile(
      path.join(root, "dist", "index.html"),
      "utf8",
    );
    assert.equal(emitted, DIST["dist/index.html"], "dist untouched");
  } finally {
    await serving.stop();
  }
});
