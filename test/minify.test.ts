/**
 * T030 acceptance — HTML minification through the real pipeline (temp-dir
 * fixture builds; the repo `templates/` tree is copied so every sibling
 * partial resolves, then `templates/index.html` is overlaid with a fixture
 * exercising comments, inter-tag whitespace runs, entities, `<pre>`/`<code>`
 * code blocks with `hljs` markup, and inline `<style>`/`<script>`).
 *
 * Two direct `onBuildEnd` invocations cover what a build cannot observe:
 * the absent-key no-op (sha256 + mtimeNs of every dist file unchanged) and
 * empty/whitespace-only pages. Those drive the real feature through
 * `discoverFeatures`, so `ctx.options` prefixing is production code too.
 * Feature failures are asserted on the recorded report / CLI exit code —
 * `build()` records them and never throws (T012 contract).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { run as runBuildCommand } from "../src/commands/build.ts";
import type { Site } from "../src/content/document.ts";
import type { BuildEnd } from "../src/feature.ts";
import { build } from "../src/pipeline/build.ts";
import { discoverFeatures } from "../src/pipeline/features.ts";
import type { BuildReport } from "../src/pipeline/report.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(TEST_DIR);

const FLAGS = { drafts: false, future: false, noCache: true };

/** Fixture files: strings and one binary sentinel (logo bytes). */
type Files = Record<string, string | Uint8Array>;

/** A four-byte PNG magic sentinel — byte-identity is all we assert. */
const LOGO_PNG = Buffer.from("89504e470d0a1a0a", "hex");

/** Run `fn` with stdout captured (build and command print their reports). */
async function capture<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; stdout: string }> {
  const out: string[] = [];
  const previous = process.stdout.write;
  process.stdout.write = ((chunk: unknown): boolean => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { value: await fn(), stdout: out.join("") };
  } finally {
    process.stdout.write = previous;
  }
}

/**
 * The assertion-friendly fixture page: an HTML comment, inter-tag
 * whitespace runs, entities (`&amp;amp;` must never double-escape), an
 * inline `<code>a    b</code>`, a `<pre><code class="language-ts hljs">`
 * block with token spans and interior runs, plus inline style/script whose
 * bytes only change behind `minifyCSS` / `minifyJS`.
 */
const HOME = [
  '{% extends "base.html" %}',
  "{% block content %}",
  "<!-- fixture comment: minify removes me -->",
  "<h1>Kiln   minify   fixture</h1>",
  "<p>Entities &amp; intact: &amp;amp; and &nbsp;blank&nbsp; and &lt;angle&gt;</p>",
  "<p>Run <code>a    b</code> inline.</p>",
  '<pre><code class="language-ts hljs"><span class="hljs-keyword">const</span>  x   =  1;',
  '<span class="hljs-comment">// two spaces</span>',
  "</code></pre>",
  "<style>body {  color:  #123; }</style>",
  '<script>document.title  =  "minified";</script>',
  "{% endblock %}",
].join("\n");

/**
 * Fixture files: repo `templates/` (so every sibling partial resolves), the
 * overlay page, a dated post (its frontmatter `date` pins feed `<updated>`
 * and sitemap `<lastmod>`, keeping non-HTML outputs deterministic across
 * consecutive builds), static assets, and a config with `site.url`.
 */
async function fixture(
  extra: Files,
  features?: Record<string, unknown>,
): Promise<Files> {
  const config =
    features === undefined
      ? 'export default { site: { title: "Minify", url: "https://example.com" } };\n'
      : `export default { site: { title: "Minify", url: "https://example.com" }, features: ${JSON.stringify(features)} };\n`;
  const files: Files = {
    "kiln.config.ts": config,
    "content/index.md": "---\ntitle: Home\nlayout: index\n---\nHome.",
    "content/posts/hello.md":
      "---\ntitle: Hello\ndate: 2026-01-15\n---\nHello body.\n",
    "public/assets/app.js": 'console.log( "static" );\n',
    "public/assets/logo.png": LOGO_PNG,
    ...extra,
  };
  const entries = await readdir(path.join(REPO, "templates"), {
    recursive: true,
  });
  for (const rel of entries) {
    const absolute = path.join(REPO, "templates", rel);
    if ((await stat(absolute)).isFile()) {
      files[path.join("templates", rel)] = await readFile(absolute, "utf8");
    }
  }
  files["templates/index.html"] = HOME;
  return files;
}

/**
 * Materialize a project in the OS temp dir, chdir into it (T010 resolves
 * `templates/` against the cwd), run `fn`, then restore the cwd and clean
 * up — even when `fn` throws.
 */
async function withProject<T>(
  files: Files,
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "kiln-minify-"));
  try {
    for (const [name, source] of Object.entries(files)) {
      const target = path.join(root, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, source);
    }
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

/** One `kiln build` inside the current project, report + stdout captured. */
async function buildHere(
  flags = FLAGS,
): Promise<{ report: BuildReport; stdout: string }> {
  const captured = await capture(() => build({ flags }));
  return { report: captured.value, stdout: captured.stdout };
}

/** Invoke `kiln build`'s `run` in-process with stdout + exit code captured. */
async function runCommand(
  args: string[],
): Promise<{ stdout: string; exitCode: number | string | undefined }> {
  const previousExit = process.exitCode;
  process.exitCode = undefined;
  try {
    const captured = await capture(() => runBuildCommand(args));
    return { stdout: captured.stdout, exitCode: process.exitCode };
  } finally {
    process.exitCode = previousExit;
  }
}

/** A built page under the project's `dist/`. */
const readDist = (root: string, rel: string): Promise<string> =>
  readFile(path.join(root, "dist", rel), "utf8");

/** One regex match's text — the template-vs-dist extraction seam. */
function pick(pattern: RegExp, html: string): string {
  const match = pattern.exec(html);
  assert.ok(match, `${pattern} matched nothing in:\n${html.slice(0, 400)}`);
  return match[0];
}

/** Every file under `dist/`, as sorted POSIX-relative paths. */
async function distFiles(root: string): Promise<string[]> {
  const entries = await readdir(path.join(root, "dist"), { recursive: true });
  const files: string[] = [];
  for (const rel of entries) {
    const info = await stat(path.join(root, "dist", rel));
    if (info.isFile()) files.push(rel);
  }
  return files.sort();
}

const sha256 = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/** sha256 of every dist file — non-HTML byte-identity, build determinism. */
async function distHashes(root: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const rel of await distFiles(root)) {
    hashes.set(rel, sha256(await readFile(path.join(root, "dist", rel))));
  }
  return hashes;
}

/** Bytes + mtime (ns) per dist file — detects any rewrite, same bytes or not. */
async function distState(
  root: string,
): Promise<Map<string, { hex: string; mtimeNs: bigint }>> {
  const state = new Map<string, { hex: string; mtimeNs: bigint }>();
  for (const rel of await distFiles(root)) {
    const file = path.join(root, "dist", rel);
    const info = await stat(file, { bigint: true });
    state.set(rel, { hex: sha256(await readFile(file)), mtimeNs: info.mtimeNs });
  }
  return state;
}

/**
 * Drive the real minify feature's `onBuildEnd` with a real discovered
 * context (`ctx.options` prefixing included) over a hand-built `BuildEnd`.
 */
async function invokeMinify(
  featureOptions: Record<string, unknown>,
  buildEnd: BuildEnd,
): Promise<void> {
  const entries = await discoverFeatures({ flags: FLAGS, featureOptions });
  const entry = entries.find((candidate) => candidate.name === "minify");
  assert.ok(entry !== undefined, "src/features/minify.ts discovered");
  assert.ok(entry.feature.onBuildEnd !== undefined, "onBuildEnd present");
  await entry.feature.onBuildEnd(buildEnd, entry.ctx);
}

const site: Site = { pages: [], data: {} };

test("features.minify absent: fixture HTML keeps comments/whitespace; onBuildEnd rewrites nothing (sha256 + mtime)", async () => {
  const files = await fixture({});
  await withProject(files, async (root) => {
    const { report } = await buildHere();
    assert.deepEqual(report.featureErrors, []);

    // Unminified build: the comment and the whitespace runs are still there.
    const html = await readDist(root, "index.html");
    assert.match(html, /<!-- fixture comment: minify removes me -->/);
    assert.match(html, /\n/);
    assert.match(html, /Kiln   minify   fixture/);

    // The feature itself, through the real ctx, with the key absent: every
    // dist file — HTML or not — is byte-identical and its mtime untouched.
    const before = await distState(root);
    await invokeMinify(
      {},
      {
        distDir: path.join(root, "dist"),
        site,
        emitted: report.emitted,
        skipped: report.skipped,
      },
    );
    assert.deepEqual(await distState(root), before);
  });
});

test("features.minify: {} — comments removed, whitespace runs collapsed, doctype/entities intact, exit 0", async () => {
  const files = await fixture({}, { minify: {} });
  await withProject(files, async (root) => {
    const { report } = await buildHere();
    assert.deepEqual(report.featureErrors, []);

    const html = await readDist(root, "index.html");
    assert.doesNotMatch(html, /<!--/); // removeComments defaults on
    // Outside the shielded elements (code plus the default-untouched
    // style/script bodies), every whitespace run is collapsed. Placeholder
    // each block as one non-whitespace token so adjacent single spaces
    // around separate blocks don't merge into a false run.
    const shell = html
      .replace(/<pre[\s\S]*?<\/pre>/g, "\0")
      .replace(/<code>[\s\S]*?<\/code>/g, "\0")
      .replace(/<style>[\s\S]*?<\/style>/g, "\0")
      .replace(/<script>[\s\S]*?<\/script>/g, "\0");
    assert.doesNotMatch(shell, /\s{2,}/);
    assert.doesNotMatch(shell.trimEnd(), /\n/);
    // Doctype preserved; entities never double-escaped, &nbsp; intact.
    assert.ok(html.startsWith("<!doctype html>"), html.slice(0, 80));
    assert.ok(html.includes("&amp;amp;"), html);
    assert.ok(!html.includes("&amp;amp;amp;"), html);
    assert.ok(html.includes("&nbsp;blank&nbsp;"), html);

    const succeeded = await runCommand([]);
    assert.ok(!succeeded.exitCode, String(succeeded.exitCode));
    assert.ok(!succeeded.stdout.includes("feature errors"), succeeded.stdout);
  });
});

test("pre/code invariant: inner HTML byte-equal to the template; hljs classes and token spans survive", async () => {
  const files = await fixture({}, { minify: {} });
  await withProject(files, async (root) => {
    const { report } = await buildHere();
    assert.deepEqual(report.featureErrors, []);
    const html = await readDist(root, "index.html");

    const pattern = /<pre[\s\S]*?<\/pre>/;
    assert.equal(pick(pattern, html), pick(pattern, HOME));

    const inline = /<code>[\s\S]*?<\/code>/;
    assert.equal(pick(inline, html), pick(inline, HOME));

    assert.ok(html.includes('<code class="language-ts hljs">'), html);
    assert.ok(html.includes('<span class="hljs-keyword">'), html);
    assert.ok(html.includes('<span class="hljs-comment">'), html);
  });
});

test("minifyCSS/minifyJS: inline style/script byte-identical at their defaults, shorter behind the flag", async () => {
  const style = /<style>[\s\S]*?<\/style>/;
  const script = /<script>[\s\S]*?<\/script>/;

  await withProject(await fixture({}, { minify: {} }), async (root) => {
    const { report } = await buildHere();
    assert.deepEqual(report.featureErrors, []);
    const html = await readDist(root, "index.html");
    assert.equal(pick(style, html), pick(style, HOME));
    assert.equal(pick(script, html), pick(script, HOME));
  });

  const files = await fixture(
    {},
    { minify: { minifyCSS: true, minifyJS: true } },
  );
  await withProject(files, async (root) => {
    const { report } = await buildHere();
    assert.deepEqual(report.featureErrors, []);
    const html = await readDist(root, "index.html");
    assert.ok(
      pick(style, html).length < pick(style, HOME).length,
      pick(style, html),
    );
    assert.ok(
      pick(script, html).length < pick(script, HOME).length,
      pick(script, html),
    );
    assert.match(html, /<style>body\{color:#123\}<\/style>/);
  });
});

test("non-HTML outputs — feed, sitemap, search index, assets, image byte-identical to an unminified build", async () => {
  const unminified = await fixture({});
  const minified = await fixture({}, { minify: {} });

  await withProject(unminified, async (plainRoot) => {
    const plain = await buildHere();
    assert.deepEqual(plain.report.featureErrors, []);
    await withProject(minified, async (minifyRoot) => {
      const fast = await buildHere();
      assert.deepEqual(fast.report.featureErrors, []);

      const before = await distHashes(plainRoot);
      const after = await distHashes(minifyRoot);
      for (const name of [
        "feed.xml",
        "sitemap.xml",
        "search-index.json",
        path.join("assets", "search.js"),
        path.join("assets", "app.js"),
        path.join("assets", "logo.png"),
      ]) {
        assert.ok(before.has(name), `${name} missing from unminified build`);
        assert.equal(after.get(name), before.get(name), name);
      }
      // Every non-HTML byte matches across the two builds…
      const nonHtml = [...before]
        .filter(([rel]) => !rel.endsWith(".html"))
        .sort();
      assert.deepEqual(
        [...after].filter(([rel]) => !rel.endsWith(".html")).sort(),
        nonHtml,
      );
      // …while the HTML really did change: minification ran.
      assert.notEqual(after.get("index.html"), before.get("index.html"));
      assert.match(await readDist(plainRoot, "index.html"), /<!-- fixture/);
    });
  });
});

test("invalid features.minify values fail the build naming the exact key; exit 1 each time", async () => {
  const cases: { raw: unknown; key: string }[] = [
    { raw: "on", key: "features.minify" },
    { raw: 42, key: "features.minify" },
    { raw: null, key: "features.minify" },
    { raw: [], key: "features.minify" },
    { raw: { minifyCSS: 1 }, key: "features.minify.minifyCSS" },
    {
      raw: { collapseWhitespace: "yes" },
      key: "features.minify.collapseWhitespace",
    },
  ];
  for (const { raw, key } of cases) {
    const files = await fixture({}, { minify: raw });
    await withProject(files, async (root) => {
      const { report } = await buildHere();
      assert.equal(
        report.featureErrors.length,
        1,
        JSON.stringify(report.featureErrors),
      );
      const error = report.featureErrors[0];
      assert.equal(error.feature, "src/features/minify.ts");
      assert.equal(error.hook, "onBuildEnd");
      assert.ok(error.message.startsWith("features.minify:"), error.message);
      assert.ok(error.message.includes(key), error.message);

      const failed = await runCommand([]);
      assert.equal(failed.exitCode, 1);
      assert.ok(failed.stdout.includes(key), failed.stdout);
    });
  }
});

test("two consecutive minified builds are byte-identical; cache-skipped pages are still minified", async () => {
  const files = await fixture({}, { minify: {} });
  const cached = { ...FLAGS, noCache: false };
  await withProject(files, async (root) => {
    const first = await buildHere(cached);
    assert.deepEqual(first.report.featureErrors, []);
    const before = await distHashes(root);

    // Sabotage a page the second build will cache-skip: only the minifier's
    // own onBuildEnd pass can restore the bytes.
    const target = path.join(root, "dist", "index.html");
    const original = await readFile(target, "utf8");
    assert.ok(original.includes("<h1>"));
    await writeFile(
      target,
      original.replace("<h1>", "<!-- sabotage -->\n  <h1>"),
    );

    const second = await buildHere(cached);
    assert.deepEqual(second.report.featureErrors, []);
    assert.ok(
      second.report.skipped.some((page) => page.file === "index.html"),
      JSON.stringify(second.report.skipped),
    );
    assert.deepEqual(await distHashes(root), before);
    assert.doesNotMatch(await readFile(target, "utf8"), /sabotage/);
  });
});

test("a minifier failure on unexpected input fails the build naming the output file; exit 1", async () => {
  const files = await fixture({}, { minify: {} });
  // Raw `<>` reaches the minifier verbatim (nunjucks passes template text
  // through) and makes html-minifier-terser's parser reject.
  files["templates/index.html"] = [
    '{% extends "base.html" %}',
    "{% block content %}",
    "<p>ok</p>",
    "<>",
    "{% endblock %}",
  ].join("\n");
  await withProject(files, async (root) => {
    const { report } = await buildHere();
    assert.equal(
      report.featureErrors.length,
      1,
      JSON.stringify(report.featureErrors),
    );
    const error = report.featureErrors[0];
    assert.equal(error.feature, "src/features/minify.ts");
    assert.equal(error.hook, "onBuildEnd");
    assert.ok(error.message.startsWith("kiln: failed to minify index.html:"), error.message);
    assert.ok(error.message.includes("Parse Error"), error.message);

    const failed = await runCommand([]);
    assert.equal(failed.exitCode, 1);
    assert.ok(failed.stdout.includes("index.html"), failed.stdout);
  });
});

test("onBuildEnd: empty and whitespace-only pages pass through without error; non-HTML never opened", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kiln-minify-dist-"));
  try {
    const dist = path.join(root, "dist");
    const empties: Files = {
      "empty.html": "",
      "blank.html": "   \n\t ",
      "page.html":
        '<!doctype html>\n<html>\n<body>\n<!-- gone -->\n<p>Some   text</p>\n<pre>  keep  </pre>\n</body>\n</html>\n',
      "feed.xml": '<?xml version="1.0"?>\n<feed>sentinel</feed>\n',
      "app.js": 'console.log( "sentinel" );\n',
      "logo.png": LOGO_PNG,
    };
    for (const [name, source] of Object.entries(empties)) {
      await mkdir(path.join(dist, path.dirname(name)), { recursive: true });
      await writeFile(path.join(dist, name), source);
    }
    const untouched = new Map<string, { hex: string; mtimeNs: bigint }>();
    for (const name of ["feed.xml", "app.js", "logo.png"]) {
      const file = path.join(dist, name);
      const info = await stat(file, { bigint: true });
      untouched.set(name, {
        hex: sha256(await readFile(file)),
        mtimeNs: info.mtimeNs,
      });
    }

    await invokeMinify(
      { minify: {} },
      {
        distDir: dist,
        site,
        emitted: Object.keys(empties).map((file) => ({ url: `/${file}`, file })),
        skipped: [],
      },
    );

    // Empty passes through byte-identical; whitespace-only collapses to
    // empty — neither errors.
    assert.equal(await readFile(path.join(dist, "empty.html"), "utf8"), "");
    assert.equal(await readFile(path.join(dist, "blank.html"), "utf8"), "");

    const page = await readFile(path.join(dist, "page.html"), "utf8");
    assert.doesNotMatch(page, /<!--/);
    assert.match(page, /<p>Some text<\/p>/);
    assert.match(page, /<pre>  keep  <\/pre>/);

    for (const [name, expected] of untouched) {
      const file = path.join(dist, name);
      const info = await stat(file, { bigint: true });
      assert.deepEqual(
        { hex: sha256(await readFile(file)), mtimeNs: info.mtimeNs },
        expected,
        name,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
