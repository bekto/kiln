/**
 * T016 acceptance — fence highlighting, the `hljs.getLanguage` allowlist
 * fallback, theme emission to `dist/assets/hljs.css`, and
 * `features.highlight.theme` validation.
 *
 * Unit tests drive the feature's `extendMarkdown` through T006's
 * `renderMarkdown` seam (exactly how build applies it); the build tests use
 * a temp project like `test/build.test.ts`, with command runs in-process
 * (never spawning the CLI, which could race `test/cli.test.ts`'s discovery).
 */
import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import hljs from "highlight.js";
import { run as runBuildCommand } from "../src/commands/build.ts";
import { renderMarkdown } from "../src/content/markdown.ts";
import type { MarkdownExtension } from "../src/content/markdown.ts";
import type { FeatureContext } from "../src/feature.ts";
import highlight from "../src/features/highlight.ts";
import { build } from "../src/pipeline/build.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(TEST_DIR);

/** Minimal strict layout: doctype, site title, and the markdown body. */
const LAYOUT =
  '<!doctype html>\n<html lang="en"><head><title>{{ site.title }}</title></head>' +
  "<body>{{ content | safe }}</body></html>\n";

/** Render markdown exactly as a build would, with the feature applied. */
function render(source: string, config?: unknown): string {
  const ctx: FeatureContext = {
    name: "highlight",
    flags: { drafts: false, future: false, noCache: false },
    options<T>(validate: (value: unknown) => T): T {
      return validate(config);
    },
  };
  const extension: MarkdownExtension = (md) => {
    highlight.extendMarkdown?.(md, ctx);
  };
  return renderMarkdown(source, { extensions: [extension] });
}

test("ts fence: hljs token spans, hljs/language-ts classes, ts label", () => {
  const html = render("```ts\nconst x = 1;\n```");
  assert.match(html, /<span class="hljs-keyword">const<\/span>/, html);
  assert.match(html, /<code class="hljs language-ts">/, html);
  assert.match(html, /<span class="hljs-langlabel">ts<\/span>/, html);
  assert.ok(html.includes("</code></pre>"), html);
});

test("info string: label and class take the first token only", () => {
  const html = render("```ts title=x.ts\nconst x = 1;\n```");
  assert.match(html, /<span class="hljs-langlabel">ts<\/span>/, html);
  assert.match(html, /<code class="hljs language-ts">/, html);
  assert.ok(!html.includes("title=x.ts"), html);
});

test("unknownlang fence: escaped plain code, no token spans, no crash", () => {
  const html = render("```unknownlang\na < b && c > d;\n```");
  assert.ok(html.includes('<code class="hljs language-unknownlang">'), html);
  assert.ok(html.includes("a &lt; b &amp;&amp; c &gt; d;"), html);
  assert.ok(html.includes('<span class="hljs-langlabel">unknownlang</span>'), html);
  assert.doesNotMatch(html, /hljs-keyword/, html);
});

test("fence with no language: unhighlighted but valid HTML", () => {
  const html = render("```\nplain < text\n```");
  assert.ok(html.includes('<pre><code class="hljs">'), html);
  assert.ok(html.includes("plain &lt; text"), html);
  assert.ok(html.includes("</code></pre>"), html);
  assert.doesNotMatch(html, /language-/, html);
  assert.doesNotMatch(html, /hljs-langlabel/, html);
});

test("allowlist: js, ts, json, bash, html, css, python all highlight", () => {
  const samples: Record<string, string> = {
    js: "const x = 1;",
    ts: "const x = 1;",
    json: '{"a": 1}',
    bash: 'echo "hi"',
    html: '<p class="x">hi</p>',
    css: "body { color: red; }",
    python: "def f(): pass",
  };
  for (const [lang, code] of Object.entries(samples)) {
    assert.ok(hljs.getLanguage(lang) !== undefined, `registered: ${lang}`);
    const html = render(`\`\`\`${lang}\n${code}\n\`\`\``);
    assert.ok(
      html.includes(`<code class="hljs language-${lang}">`),
      `${lang}: ${html}`,
    );
    assert.match(html, /<span class="hljs-[a-z]/, `${lang}: ${html}`);
  }
});

/**
 * A fixture project: layout + one index page carrying `body`; `features`
 * optionally adds a kiln.config.ts whose `features` map holds that value.
 */
function project(body: string, features?: string): Record<string, string> {
  const files: Record<string, string> = {
    "templates/post.html": LAYOUT,
    "content/index.md": ["---", "title: Home", "---", "", body, ""].join("\n"),
  };
  if (features !== undefined) {
    files["kiln.config.ts"] = `export default { features: ${features} };\n`;
  }
  return files;
}

const WITH_CODE = ["```ts", "const x = 1;", "```"].join("\n");
const UNKNOWNLANG = ["```unknownlang", "a < b && c > d;", "```"].join("\n");

/**
 * Materialize a project in the OS temp dir, chdir into it (T010 resolves
 * `templates/` against the cwd), run `fn`, then restore the cwd and clean up
 * — even when `fn` throws.
 */
async function withProject<T>(
  files: Record<string, string>,
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "kiln-highlight-"));
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

/** Run `fn` with stdout/stderr captured so printed reports stay off-runner. */
async function capture<T>(fn: () => Promise<T>): Promise<{ value: T; stdout: string }> {
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
    return { value: await fn(), stdout: out.join("") };
  } finally {
    process.stdout.write = previousOut;
    process.stderr.write = previousErr;
  }
}

interface CommandRun {
  stdout: string;
  /** The `process.exitCode` this invocation left behind (`undefined` = 0). */
  exitCode: number | string | undefined;
}

/** Invoke `kiln build`'s `run` in-process with streams + exitCode captured. */
async function runCommand(args: string[]): Promise<CommandRun> {
  const previousExit = process.exitCode;
  process.exitCode = undefined;
  try {
    const captured = await capture(() => runBuildCommand(args));
    return { stdout: captured.stdout, exitCode: process.exitCode };
  } finally {
    process.exitCode = previousExit;
  }
}

test("build with code: dist/assets/hljs.css (default github-dark) + hljs page HTML", async () => {
  await withProject(project(WITH_CODE), async (root) => {
    const { value: report } = await capture(() => build());
    assert.deepEqual(report.featureErrors, []);

    const css = await readFile(
      path.join(root, "dist", "assets", "hljs.css"),
      "utf8",
    );
    assert.match(css, /Theme: GitHub Dark/);

    const html = await readFile(path.join(root, "dist", "index.html"), "utf8");
    assert.match(html, /<span class="hljs-keyword">const<\/span>/, html);
    assert.match(html, /<code class="hljs language-ts">/, html);
    assert.match(html, /<span class="hljs-langlabel">ts<\/span>/, html);
  });
});

test("build with no highlighted block: hljs.css absent, stale file removed", async () => {
  await withProject(project(WITH_CODE), async (root) => {
    const cssFile = path.join(root, "dist", "assets", "hljs.css");
    const first = await capture(() => build());
    assert.deepEqual(first.value.featureErrors, []);
    await access(cssFile); // precondition: the coded build shipped it

    await writeFile(
      path.join(root, "content", "index.md"),
      ["---", "title: Home", "---", "", "Just prose, no fences.", ""].join("\n"),
    );
    const second = await capture(() => build());
    assert.deepEqual(second.value.featureErrors, []);
    await assert.rejects(access(cssFile), { code: "ENOENT" });
  });
});

test("unknownlang build: exit 0, escaped code in the page, no theme file", async () => {
  await withProject(project(UNKNOWNLANG), async (root) => {
    const run = await runCommand([]);
    assert.equal(run.exitCode, undefined);

    const html = await readFile(path.join(root, "dist", "index.html"), "utf8");
    assert.ok(html.includes("a &lt; b &amp;&amp; c &gt; d;"), html);
    assert.ok(html.includes('class="hljs language-unknownlang"'), html);
    assert.doesNotMatch(html, /hljs-keyword/, html);

    // Unknown-only content never counts as highlighted.
    await assert.rejects(
      access(path.join(root, "dist", "assets", "hljs.css")),
      { code: "ENOENT" },
    );
  });
});

test("bogus features.highlight.theme fails the build naming the key", async () => {
  const config = '{ highlight: { theme: "bogus" } }';
  await withProject(project(WITH_CODE, config), async () => {
    const run = await runCommand([]);
    assert.equal(run.exitCode, 1);
    assert.match(run.stdout, /src\/features\/highlight\.ts \(onSite\): /);
    assert.match(run.stdout, /features\.highlight\.theme/);
    assert.match(run.stdout, /bogus/);
  });
});

test("non-string features.highlight.theme fails naming the key", async () => {
  const config = "{ highlight: { theme: 42 } }";
  await withProject(project(WITH_CODE, config), async () => {
    const { value: report } = await capture(() => build());
    assert.equal(report.featureErrors.length, 1);
    const failure = report.featureErrors[0];
    assert.equal(failure.feature, "src/features/highlight.ts");
    assert.equal(failure.hook, "onSite");
    assert.match(failure.message, /features\.highlight\.theme/);
    assert.match(failure.message, /string/);
  });
});

test("features.highlight.theme selects which style ships", async () => {
  const config = '{ highlight: { theme: "atom-one-dark" } }';
  await withProject(project(WITH_CODE, config), async (root) => {
    const { value: report } = await capture(() => build());
    assert.deepEqual(report.featureErrors, []);

    const shipped = await readFile(
      path.join(root, "dist", "assets", "hljs.css"),
      "utf8",
    );
    const expected = await readFile(
      path.join(REPO, "node_modules", "highlight.js", "styles", "atom-one-dark.min.css"),
      "utf8",
    );
    assert.equal(shipped, expected);
  });
});
