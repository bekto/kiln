/**
 * T032 acceptance — the internal link checker.
 *
 * Unit level (direct `onBuildEnd` over hand-built `dist/` trees): the
 * aggregated `source → target (href=…)` report with its ordering and
 * dedup, anchor existence (`id` and `<a name>`, unicode and malformed
 * fragments, same-page fragments, fragments on missing files), external
 * skipping, raw-region stripping, case-sensitive existence, exact-file
 * resolution (incl. the two same-build outputs), relative/query
 * resolution, allow/exclude semantics, and config validation naming the
 * exact keys.
 *
 * Build level (real `build()` runs in a temp project through the repo's
 * own `templates/`): exit 1 with the list on failure, exit 0 with no
 * output for external-only and stripped-sample fixtures, allow+exclude
 * together, config errors naming the keys, and the self-check fixture —
 * only valid links (feed, sitemap, tags, pagination, unicode targets,
 * assets) → exit 0, no output, proving resolution agrees with T010's
 * actual emission.
 */
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { run as runBuildCommand } from "../src/commands/build.ts";
import type { Site } from "../src/content/document.ts";
import type { BuildEnd, FeatureContext } from "../src/feature.ts";
import linkCheck from "../src/features/linkCheck.ts";

/** The repo's real templates — sibling features' partials must resolve. */
const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TEMPLATES_DIR = path.join(REPO, "templates");

/**
 * A `FeatureContext` shaped like T012's `makeContext`: `options()` runs the
 * validator and re-throws failures prefixed `features.linkCheck: `, so unit
 * config tests see the same text the pipeline records.
 */
function ctxFor(raw: unknown): FeatureContext {
  return {
    name: "linkCheck",
    flags: { drafts: false, future: false, noCache: false },
    options<T>(validate: (value: unknown) => T): T {
      try {
        return validate(raw);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`features.linkCheck: ${reason}`, { cause: error });
      }
    },
  };
}

/** A {@link BuildEnd} stub — the checker reads only `distDir`. */
function buildEnd(distDir: string): BuildEnd {
  const site: Site = { pages: [], data: {} };
  return { distDir, site, emitted: [], skipped: [] };
}

/** Write every `name → content` file under `root` (parents created). */
async function writeFiles(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

/** Run `fn` in a throwaway directory, removed even when `fn` throws. */
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "kiln-linkcheck-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Run the hook over a hand-built `dist/` tree; resolve with the thrown
 * message (or `undefined` when the scan is clean).
 */
async function runCheck(
  files: Record<string, string>,
  rawConfig?: unknown,
): Promise<string | undefined> {
  return withTempDir(async (dir) => {
    const distDir = path.join(dir, "dist");
    await writeFiles(distDir, files);
    const hook = linkCheck.onBuildEnd;
    assert.ok(hook, "linkCheck provides onBuildEnd");
    try {
      await hook.call(linkCheck, buildEnd(distDir), ctxFor(rawConfig));
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
}

interface Captured<T> {
  value: T;
  stdout: string;
  stderr: string;
}

/**
 * Run `fn` with `process.stdout`/`process.stderr` writes captured (withheld
 * from the runner's stream); the originals are restored even on throw.
 */
async function capture<T>(fn: () => Promise<T>): Promise<Captured<T>> {
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

interface CommandRun {
  stdout: string;
  stderr: string;
  /** The `process.exitCode` this invocation left behind (`undefined` = 0). */
  exitCode: number | string | undefined;
}

/** Invoke `kiln build`'s `run` in-process with streams + exitCode captured. */
async function runCommand(args: string[]): Promise<CommandRun> {
  const previousExit = process.exitCode;
  process.exitCode = undefined;
  try {
    const captured = await capture(() => runBuildCommand(args));
    return {
      stdout: captured.stdout,
      stderr: captured.stderr,
      exitCode: process.exitCode,
    };
  } finally {
    process.exitCode = previousExit;
  }
}

/**
 * Materialize a project in the OS temp dir, chdir into it (the build
 * command resolves config and templates against the cwd), run `fn`, then
 * restore the cwd and clean up — even when `fn` throws. The repo's
 * `templates/` are symlinked in so every sibling feature's partial
 * resolves during these in-process builds.
 */
async function withProject<T>(
  files: Record<string, string>,
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "kiln-linkcheck-"));
  try {
    await writeFiles(root, files);
    await symlink(TEMPLATES_DIR, path.join(root, "templates"), "dir");
    const previous = process.cwd();
    process.chdir(root);
    try {
      return await fn(root);
    } finally {
      process.chdir(previous);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** stdout + stderr — the report block moved streams across T031. */
function combined(run: CommandRun): string {
  return run.stdout + run.stderr;
}

// ---------------------------------------------------------------------------
// Unit level — the aggregated report.
// ---------------------------------------------------------------------------

test("linkCheck: three broken links on two pages, all listed, source-ordered, deduped", async () => {
  const message = await runCheck({
    "index.html": '<a href="/gone/">g</a>',
    "posts/hello/index.html":
      '<a href="/missing/">m</a><a href="/missing/?x=1">dup</a><a href="/about/#nope">n</a>',
    "about/index.html": '<p id="real"></p>',
  });
  assert.equal(
    message,
    [
      "3 broken internal links:",
      "  1. / → /gone/ (href=\"/gone/\")",
      "  2. /posts/hello/ → /missing/ (href=\"/missing/\")",
      "  3. /posts/hello/ → /about/#nope (href=\"/about/#nope\")",
    ].join("\n"),
  );
});

test("linkCheck: anchors — id, <a name>, same-page fragment, fragment on missing file", async () => {
  const message = await runCheck({
    "good/index.html": '<h2 id="real-id"></h2><a name="legacy"></a>',
    "posts/a/index.html":
      '<p id="local"></p>' +
      '<a href="/good/#real-id">ok</a>' +
      '<a href="/good/#legacy">ok</a>' +
      '<a href="/good/#no-such-id">bad</a>' +
      '<a href="#local">ok</a>' +
      '<a href="#nope">bad</a>' +
      '<a href="/nope/#frag">bad</a>',
  });
  assert.equal(
    message,
    [
      "3 broken internal links:",
      "  1. /posts/a/ → /good/#no-such-id (href=\"/good/#no-such-id\")",
      "  2. /posts/a/ → /posts/a/#nope (href=\"#nope\")",
      // A fragment on a nonexistent file reports the file, not the fragment.
      "  3. /posts/a/ → /nope/ (href=\"/nope/#frag\")",
    ].join("\n"),
  );
});

test("linkCheck: fragments decode (unicode passes, malformed compares literally)", async () => {
  const message = await runCheck({
    "good/index.html": '<h2 id="設定"></h2>',
    "index.html":
      '<a href="/good/#%E8%A8%AD%E5%AE%9A">ok</a>' +
      '<a href="/good/#設定">ok</a>' +
      '<a href="/good/#%ZZ">bad</a>',
  });
  assert.equal(
    message,
    ['1 broken internal link:', "  1. / → /good/#%ZZ (href=\"/good/#%ZZ\")"].join(
      "\n",
    ),
  );
});

test("linkCheck: external references are never checked (offline by construction)", async () => {
  const message = await runCheck({
    "index.html":
      '<a href="https://example.com/nope">1</a>' +
      '<a href="http://example.com/nope">2</a>' +
      '<a href="//cdn.example/x">3</a>' +
      '<a href="mailto:x@y">4</a>' +
      '<a href="tel:+1555">5</a>' +
      '<a href="javascript:void(0)">6</a>' +
      '<a href="data:text/plain,hi">7</a>' +
      '<a href="ftp://host/x">8</a>' +
      '<img src="data:image/png;base64,AAAA" alt="9">',
  });
  assert.equal(message, undefined);
});

test("linkCheck: comments, <pre>, <code> and <script> produce no phantom links", async () => {
  const message = await runCheck({
    "index.html": [
      '<!-- <a href="/in-comment/">c</a> -->',
      "<pre><code>&lt;a href=\"/in-pre/\"&gt;</code></pre>",
      '<code>href="/fake/"</code>',
      '<script>el.href = "/in-script/";</script>',
      '<a href="/present/">real</a>',
    ].join("\n"),
  });
  assert.equal(
    message,
    [
      "1 broken internal link:",
      "  1. / → /present/ (href=\"/present/\")",
    ].join("\n"),
  );
});

test("linkCheck: case-sensitive existence — /About/ broken, /about (extensionless) fine", async () => {
  const message = await runCheck({
    "index.html": '<a href="/about">ok</a><a href="/About/">bad</a>',
    "about/index.html": "<p>About.</p>",
  });
  assert.equal(
    message,
    [
      "1 broken internal link:",
      "  1. / → /About/ (href=\"/About/\")",
    ].join("\n"),
  );
});

test("linkCheck: relative resolution, query stripping, and bare segments", async () => {
  const message = await runCheck({
    "guide/intro/index.html":
      '<a href="../setup/">1</a>' +
      '<a href="./">2</a>' +
      '<a href="sub">3</a>' +
      '<a href="?page=2">4</a>',
  });
  assert.equal(
    message,
    [
      "2 broken internal links:",
      '  1. /guide/intro/ → /guide/setup/ (href="../setup/")',
      '  2. /guide/intro/ → /guide/intro/sub (href="sub")',
    ].join("\n"),
  );
});

test("linkCheck: exact-file targets are existence-checked (feed present, typo broken)", async () => {
  const message = await runCheck({
    "index.html":
      '<a href="/feed.xml">1</a>' +
      '<a href="/missing.xml">2</a>' +
      '<a href="/sitemap.xml">3</a>' +
      '<a href="/assets/search.js">4</a>',
    "feed.xml": "<feed></feed>",
  });
  assert.equal(
    message,
    [
      "1 broken internal link:",
      "  1. / → /missing.xml (href=\"/missing.xml\")",
    ].join("\n"),
  );
});

test("linkCheck: allow excuses targets, exclude skips links (raw href or source URL)", async () => {
  const files = {
    "index.html":
      '<a href="/gone/x">1</a><a href="/other/">2</a><a href="/legacy/thing">3</a>',
    "legacy/page/index.html": '<a href="/totally-broken/">4</a>',
  };

  const forgiven = await runCheck(files, {
    allow: ["/gone/**"],
    exclude: ["/legacy/**"],
  });
  assert.equal(
    forgiven,
    [
      "1 broken internal link:",
      "  1. / → /other/ (href=\"/other/\")",
    ].join("\n"),
  );

  // Without the config both mechanisms are off: the same targets report.
  const reported = await runCheck(files);
  assert.equal(
    reported,
    [
      "4 broken internal links:",
      "  1. / → /gone/x (href=\"/gone/x\")",
      "  2. / → /other/ (href=\"/other/\")",
      "  3. / → /legacy/thing (href=\"/legacy/thing\")",
      "  4. /legacy/page/ → /totally-broken/ (href=\"/totally-broken/\")",
    ].join("\n"),
  );
});

test("linkCheck: bad config names the exact features.linkCheck.* key", async () => {
  const badAllow = await runCheck({ "index.html": "<p>x</p>" }, { allow: "nope" });
  assert.ok(
    badAllow?.includes("features.linkCheck.allow"),
    `allow string: ${String(badAllow)}`,
  );
  const badAllowElement = await runCheck(
    { "index.html": "<p>x</p>" },
    { allow: [42] },
  );
  assert.ok(
    badAllowElement?.includes("features.linkCheck.allow"),
    `allow element: ${String(badAllowElement)}`,
  );
  const badExclude = await runCheck(
    { "index.html": "<p>x</p>" },
    { exclude: [42] },
  );
  assert.ok(
    badExclude?.includes("features.linkCheck.exclude"),
    `exclude element: ${String(badExclude)}`,
  );
});

test("linkCheck: empty dist, linkless page, and non-HTML outputs are no-ops", async () => {
  assert.equal(await runCheck({}), undefined);
  assert.equal(await runCheck({ "index.html": "<p>no links</p>" }), undefined);
  assert.equal(
    await runCheck({ "feed.xml": '<a href="/broken/">x</a>' }),
    undefined,
    "non-HTML outputs are never scanned",
  );
});

// ---------------------------------------------------------------------------
// Build level — real builds, exit codes, config, and the self-check fixture.
// ---------------------------------------------------------------------------

const SITE_URL = "https://links.example";

function config(extra = ""): string {
  return `export default { site: { title: "Links", url: "${SITE_URL}" }${extra} };\n`;
}

test("build: a page linking /missing/ fails with the list, exit 1", async () => {
  const project = {
    "kiln.config.ts": config(),
    "content/index.md": "---\ntitle: Home\n---\nHome.",
    "content/posts/hello.md":
      "---\ntitle: Hello\ndate: 2026-01-01\n---\nSee [missing](/missing/).",
  };
  await withProject(project, async (root) => {
    const run = await runCommand([]);
    assert.equal(run.exitCode, 1, "exit code");
    const output = combined(run);
    assert.match(output, /broken internal link/);
    assert.ok(
      output.includes("/posts/hello/ → /missing/ (href=\"/missing/\")"),
      `entry in output: ${output}`,
    );
    void root;
  });
});

test("build: external-only links exit 0 with no output", async () => {
  const project = {
    "kiln.config.ts": config(),
    "content/index.md":
      "---\ntitle: Home\n---\n" +
      "[ext](https://example.com/nope) [mail](mailto:x@y) [cdn](//cdn.example/x)",
  };
  await withProject(project, async () => {
    const run = await runCommand([]);
    assert.ok(
      run.exitCode === undefined || run.exitCode === 0,
      `exit ${String(run.exitCode)}`,
    );
    assert.equal(run.stderr, "");
    assert.ok(!run.stdout.includes("feature errors"), run.stdout);
    assert.ok(!run.stdout.includes("broken internal"), run.stdout);
  });
});

test("build: allow excuses the target, exclude skips the source's links — exit 0", async () => {
  const project = {
    "kiln.config.ts": config(
      `, features: { linkCheck: { allow: ["/gone/**"], exclude: ["/legacy/**"] } }`,
    ),
    "content/index.md":
      "---\ntitle: Home\n---\n[gone](/gone/x) [about](/about/)",
    "content/about.md": "---\ntitle: About\n---\nAbout.",
    "content/legacy/page.md":
      "---\ntitle: Legacy\n---\n[missing](/never-emitted/)",
  };
  await withProject(project, async () => {
    const run = await runCommand([]);
    assert.ok(
      run.exitCode === undefined || run.exitCode === 0,
      `exit ${String(run.exitCode)}: ${combined(run)}`,
    );
    assert.equal(run.stderr, "");
    assert.ok(!run.stdout.includes("feature errors"), run.stdout);
  });
});

test("build: invalid allow/exclude config fails naming the exact key", async () => {
  const cases: [extra: string, key: string][] = [
    [`, features: { linkCheck: { allow: "nope" } }`, "features.linkCheck.allow"],
    [`, features: { linkCheck: { exclude: [42] } }`, "features.linkCheck.exclude"],
  ];
  for (const [extra, key] of cases) {
    const project = {
      "kiln.config.ts": config(extra),
      "content/index.md": "---\ntitle: Home\n---\nHome.",
    };
    await withProject(project, async () => {
      const run = await runCommand([]);
      assert.equal(run.exitCode, 1, `exit for ${key}`);
      assert.ok(
        combined(run).includes(key),
        `${key} named in output: ${combined(run)}`,
      );
    });
  }
});

test("build: an escaped href sample inside a fenced <code> block is not reported", async () => {
  const project = {
    "kiln.config.ts": config(),
    "content/index.md":
      "---\ntitle: Home\n---\n" +
      '```html\n<a href="/fake/">click</a>\n```\n',
  };
  await withProject(project, async () => {
    const run = await runCommand([]);
    assert.ok(
      run.exitCode === undefined || run.exitCode === 0,
      `exit ${String(run.exitCode)}: ${combined(run)}`,
    );
    assert.equal(run.stderr, "");
    assert.ok(!run.stdout.includes("feature errors"), run.stdout);
  });
});

test("build: self-check — a fixture with only valid links exits 0 with no output", async () => {
  const project = {
    "kiln.config.ts": config(", features: { pagination: { pageSize: 2 } }"),
    "content/index.md":
      "---\ntitle: Home\n---\n" +
      "## Section\n" +
      "[feed](/feed.xml) [sitemap](/sitemap.xml) [tags](/tags/kiln/) " +
      "[page 2](/page/2/) [你好](/你好世界/) [about](/about/) " +
      "[logo](/images/logo.png) [search](/assets/search.js) " +
      "[hljs](/assets/hljs.css) [self](#section)",
    "content/about.md": "---\ntitle: About\n---\nAbout.",
    "content/你好世界.md": "---\ntitle: 你好世界\n---\n你好。",
    "content/posts/a.md":
      "---\ntitle: A\ndate: 2026-01-01\ntags: [kiln]\n---\n" +
      "Post A.\n\n```ts\nconst x: number = 1;\n```\n",
    "content/posts/b.md":
      "---\ntitle: B\ndate: 2026-01-02\ntags: [kiln]\n---\nPost B.",
    "content/posts/c.md":
      "---\ntitle: C\ndate: 2026-01-03\ntags: [kiln]\n---\nPost C.",
    "public/images/logo.png": "not-really-a-png",
  };
  await withProject(project, async (root) => {
    const run = await runCommand([]);
    assert.ok(
      run.exitCode === undefined || run.exitCode === 0,
      `exit ${String(run.exitCode)}: ${combined(run)}`,
    );
    assert.equal(run.stderr, "");
    assert.ok(!run.stdout.includes("feature errors"), run.stdout);
    assert.ok(!run.stdout.includes("broken internal"), run.stdout);

    // The targets the self-check exercised really were emitted…
    for (const produced of [
      "feed.xml",
      "sitemap.xml",
      "assets/search.js",
      "assets/hljs.css",
      "tags/kiln/index.html",
      "page/2/index.html",
      "你好世界/index.html",
      "images/logo.png",
    ]) {
      await readFile(path.join(root, "dist", produced), "utf8");
    }
  });
});
