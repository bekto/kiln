/**
 * T017 acceptance — heading anchors, `page.toc`, the `toc.html` partial,
 * and `features.toc.depth` validation.
 *
 * Two layers: direct `renderDocument` runs (the feature wired in exactly as
 * T012 wires it, against the shipped `templates/`), and full `build()`
 * runs in a temp project for config plumbing, exit codes, and rebuild
 * stability. No test spawns the CLI: `test/cli.test.ts` owns the process
 * boundary, so `kiln build`'s `run` is imported directly with
 * `process.exitCode` restored after every inspection (same approach as
 * `test/build.test.ts`).
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FeatureContext } from "../src/feature.ts";
import { run as runBuildCommand } from "../src/commands/build.ts";
import type { MarkdownExtension } from "../src/content/markdown.ts";
import type { Page, Site } from "../src/content/document.ts";
import toc from "../src/features/toc.ts";
import { build } from "../src/pipeline/build.ts";
import { loadTemplates } from "../src/render/templates.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(TEST_DIR);

/** A fixture page; frontmatter data and markdown body are per-test. */
function page(content: string, url = "/posts/hi/"): Page {
  return { path: "/content/posts/hi.md", data: {}, content, url };
}

/**
 * The `FeatureContext` shape `src/pipeline/features.ts` builds (own slice,
 * `features.toc: ` rethrow prefix), fed the raw `features.toc` value under
 * test. The real loader's prefixing is proven end-to-end by the build test.
 */
function context(raw: unknown): FeatureContext {
  return {
    name: "toc",
    flags: { drafts: false, future: false, noCache: false },
    options<T>(validate: (value: unknown) => T): T {
      try {
        return validate(raw);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`features.toc: ${reason}`);
      }
    },
  };
}

/** The feature registered the way T012 collects `extendMarkdown` hooks. */
function extension(raw?: unknown): MarkdownExtension {
  return (md) => {
    assert.ok(toc.extendMarkdown !== undefined);
    toc.extendMarkdown(md, context(raw));
  };
}

/** Render one fixture page through the shipped layouts + the toc feature. */
async function render(content: string, raw?: unknown): Promise<{ html: string; page: Page }> {
  const subject = page(content);
  const templates = await loadTemplates();
  const html = await templates.renderDocument(subject, {
    url: subject.url,
    site: { title: "Kiln Test" },
    extensions: [extension(raw)],
  });
  return { html, page: subject };
}

/** The `<nav>…</nav>` slice with inter-tag whitespace removed, or null. */
function nav(html: string): string | null {
  const start = html.indexOf("<nav");
  if (start === -1) return null;
  const end = html.indexOf("</nav>", start);
  assert.notEqual(end, -1, "nav opened but never closed");
  return html.slice(start, end + "</nav>".length).replace(/>\s+</g, "><");
}

/** Run `fn` with stdout/stderr captured so reports can be asserted verbatim. */
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
    return { value: await fn(), stdout: out.join("") + err.join("") };
  } finally {
    process.stdout.write = previousOut;
    process.stderr.write = previousErr;
  }
}

/** Invoke `kiln build`'s `run` in-process with streams + exitCode captured. */
async function runCommand(args: string[]): Promise<{ stdout: string; exitCode: number | string | undefined }> {
  const previousExit = process.exitCode;
  process.exitCode = undefined;
  try {
    const captured = await capture(() => runBuildCommand(args));
    return { stdout: captured.stdout, exitCode: process.exitCode };
  } finally {
    process.exitCode = previousExit;
  }
}

/**
 * Materialize a project in the OS temp dir, chdir into it (T012 resolves
 * `templates/` against the cwd), run `fn`, then restore the cwd and clean up
 * — even when `fn` throws. The shipped `base.html`/`post.html` are copied in
 * so `injectBody` is the real T012 seam, overridable by `files`.
 */
async function withProject<T>(
  files: Record<string, string>,
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "kiln-toc-"));
  try {
    // Copy the repo's whole templates/ tree (layouts + partials), so the
    // fixture renders against the shipped seam — `injectBody` partials
    // included — and stays robust as sibling features add their own.
    const shipped: Record<string, string> = {};
    for (const dir of ["", "partials"]) {
      const from = path.join(REPO, "templates", dir);
      const entries = await readdir(from, { withFileTypes: true }).catch(
        () => [],
      );
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const name = dir === "" ? entry.name : `${dir}/${entry.name}`;
        shipped[`templates/${name}`] = await readFile(
          path.join(from, entry.name),
          "utf8",
        );
      }
    }
    for (const [name, source] of Object.entries({ ...shipped, ...files })) {
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

/** The two-page content fixture every build test starts from. */
const CONTENT: Record<string, string> = {
  "content/posts/dup.md":
    "---\ntitle: Dup\n---\n## Setup\n\nfirst\n\n## Setup\n\nsecond\n",
  "content/posts/other.md": "---\ntitle: Other\n---\n## Setup\n",
  "content/posts/levels.md":
    "---\ntitle: Levels\n---\n# Head\n\n## Sub\n\n### Subsub\n\n#### Deep\n",
};

test("ids: duplicates on one page get -2/-3; a fresh render resets the counter", async () => {
  const { html, page: subject } = await render(
    "## Setup\n\na\n\n## Setup\n\nb\n\n## Setup\n\n",
  );
  assert.ok(html.includes('id="setup"'), "first keeps the bare slug");
  assert.ok(html.includes('id="setup-2"'), "second is suffixed");
  assert.ok(html.includes('id="setup-3"'), "third is suffixed");
  assert.doesNotMatch(html, /id="setup-4"/);

  // Re-rendering the same page must not accumulate suffixes: ids come from
  // a per-invocation set, never module state.
  const templates = await loadTemplates();
  const again = await templates.renderDocument(subject, {
    url: subject.url,
    site: { title: "Kiln Test" },
    extensions: [extension()],
  });
  assert.ok(again.includes('id="setup-2"'));
  assert.doesNotMatch(again, /id="setup-4"/);
  assert.deepEqual(subject.data.injectBody, ["toc.html"], "no duplicate injection");
});

test("the same heading on two pages keeps the bare slug on both", async () => {
  const templates = await loadTemplates();
  const htmls = await Promise.all(
    ["/posts/one/", "/posts/two/"].map((url) =>
      templates.renderDocument(page("## Setup\n\nx\n", url), {
        url,
        site: {},
        extensions: [extension()],
      }),
    ),
  );
  for (const html of htmls) {
    assert.ok(html.includes('id="setup"'));
    assert.doesNotMatch(html, /id="setup-2"/);
  }
});

test("page.toc drives a <nav>: entries link to #id, h1–h3 listed, h4 anchored but omitted", async () => {
  const { html, page: subject } = await render(
    "# Title\n\n## Setup\n\n### Details\n\n#### Deep\n\n## Setup\n\n",
  );
  assert.deepEqual(subject.data.toc, [
    { level: 1, text: "Title", id: "title", url: "/posts/hi/#title" },
    { level: 2, text: "Setup", id: "setup", url: "/posts/hi/#setup" },
    { level: 3, text: "Details", id: "details", url: "/posts/hi/#details" },
    { level: 2, text: "Setup", id: "setup-2", url: "/posts/hi/#setup-2" },
  ]);

  const toc = nav(html);
  assert.ok(toc !== null, "non-empty toc injects the partial");
  assert.ok(toc.includes('<a href="/posts/hi/#title">Title</a>'));
  assert.ok(toc.includes('<a href="/posts/hi/#setup">Setup</a>'));
  assert.ok(toc.includes('<a href="/posts/hi/#details">Details</a>'));
  assert.ok(toc.includes('<a href="/posts/hi/#setup-2">Setup</a>'));
  // Depth 3: the h4 keeps its anchor but never appears in the TOC.
  assert.ok(html.includes('id="deep"'), "anchors ignore toc depth");
  assert.ok(!toc.includes("#deep"), "h4 omitted from the toc");
});

test("inline markup and unicode headings slug T005-style, in ids and toc urls", async () => {
  const { html, page: subject } = await render(
    "## Use `kiln build`\n\n## [Guide](https://x.test) *fast*\n\n## 設定\n\n",
  );
  assert.ok(html.includes('id="use-kiln-build"'));
  assert.ok(html.includes('id="guide-fast"'));
  assert.ok(html.includes('id="設定"'));
  const ids = (subject.data.toc as { id: string }[]).map((entry) => entry.id);
  assert.deepEqual(ids, ["use-kiln-build", "guide-fast", "設定"]);
  const urls = (subject.data.toc as { url: string }[]).map((entry) => entry.url);
  assert.deepEqual(urls, [
    "/posts/hi/#use-kiln-build",
    "/posts/hi/#guide-fast",
    "/posts/hi/#設定",
  ]);
});

test("empty and image-only headings fall back to section, deduped", async () => {
  const { html, page: subject } = await render(
    "##\n\nnothing\n\n## ![alt](pic.png)\n\nalso nothing\n\n##\n\n",
  );
  assert.ok(html.includes('id="section"'));
  assert.ok(html.includes('id="section-2"'));
  assert.ok(html.includes('id="section-3"'));
  const ids = (subject.data.toc as { id: string }[]).map((entry) => entry.id);
  assert.deepEqual(ids, ["section", "section-2", "section-3"]);
});

test("a page with no headings: no toc data, no injection, no <nav>", async () => {
  const { html, page: subject } = await render("Just a paragraph.\n");
  assert.equal(subject.data.toc, undefined);
  assert.equal(subject.data.injectBody, undefined);
  assert.equal(nav(html), null);
  assert.ok(!html.includes('class="toc"'));
});

test("the partial nests levels: h1 > h2 > h3 > h2 renders sibling subtrees", async () => {
  const { html } = await render("# A\n\n## B\n\n### C\n\n## D\n");
  assert.equal(
    nav(html),
    '<nav class="toc"><ul><li><a href="/posts/hi/#a">A</a>' +
      '<ul><li><a href="/posts/hi/#b">B</a>' +
      '<ul><li><a href="/posts/hi/#c">C</a></li></ul></li></ul>' +
      '<ul><li><a href="/posts/hi/#d">D</a></li></ul>' +
      "</li></ul></nav>",
  );
});

test("features.toc.depth: 2 lists h1–h2 only; anchors still cover h3", async () => {
  const { html, page: subject } = await render(
    "## Sub\n\n### Subsub\n\n#### Deep\n",
    { depth: 2 },
  );
  const ids = (subject.data.toc as { id: string }[]).map((entry) => entry.id);
  assert.deepEqual(ids, ["sub"]);
  const toc = nav(html);
  assert.ok(toc !== null && toc.includes("#sub"));
  assert.ok(toc !== null && !toc.includes("#subsub"));
  assert.ok(html.includes('id="subsub"'));
  assert.ok(html.includes('id="deep"'));
});

test("onSite rejects out-of-range depths and accepts absent/2/3", async () => {
  const onSite = toc.onSite;
  assert.ok(onSite !== undefined);
  const site: Site = { pages: [], data: {} };
  for (const raw of [1, 4, 2.5, "three", { depth: 1 }, { depth: 4 }, { depth: 2.5 }, { depth: "three" }, "3"]) {
    await assert.rejects(
      async () => {
        await onSite(site, context(raw));
      },
      /features\.toc: /,
      `depth ${JSON.stringify(raw)} must fail`,
    );
  }
  for (const raw of [undefined, {}, { depth: 2 }, { depth: 3 }]) {
    await onSite(site, context(raw));
  }
});

test("build: bad features.toc.depth records features.toc and the command exits 1", async () => {
  for (const depth of [1, 4, 2.5, "three"]) {
    const config = `export default { features: { toc: { depth: ${JSON.stringify(depth)} } } };\n`;
    await withProject({ ...CONTENT, "kiln.config.ts": config }, async () => {
      const { value: report, stdout } = await capture(() => build());
      const mine = report.featureErrors.filter(
        (entry) => entry.feature === "src/features/toc.ts",
      );
      assert.equal(mine.length, 1, JSON.stringify(report.featureErrors));
      assert.match(mine[0].message, /features\.toc: depth must be an integer in 2\.\.3/);

      const failed = await runCommand([]);
      assert.equal(failed.exitCode, 1, `depth ${depth} must exit 1`);
      assert.match(failed.stdout, /features\.toc/);
    });
  }
});

test("build: default depth emits unique ids + nav into dist; a rebuild is identical", async () => {
  await withProject(CONTENT, async (root) => {
    const { value: report } = await capture(() =>
      build({ flags: { drafts: false, future: false, noCache: true } }),
    );
    assert.deepEqual(
      report.featureErrors.filter((entry) => entry.feature === "src/features/toc.ts"),
      [],
    );

    const dup = await readFile(path.join(root, "dist", "posts", "dup", "index.html"), "utf8");
    assert.ok(dup.includes('id="setup"'));
    assert.ok(dup.includes('id="setup-2"'));
    assert.ok(dup.includes('<nav class="toc">'));
    assert.ok(dup.includes('<a href="/posts/dup/#setup">Setup</a>'));

    const other = await readFile(path.join(root, "dist", "posts", "other", "index.html"), "utf8");
    assert.ok(other.includes('id="setup"'));
    assert.ok(!other.includes('id="setup-2"'));

    const levels = await readFile(path.join(root, "dist", "posts", "levels", "index.html"), "utf8");
    assert.ok(levels.includes('id="deep"'), "h4 anchored at default depth");
    assert.ok(levels.includes('href="/posts/levels/#subsub"'), "h3 listed at depth 3");
    assert.ok(!levels.includes('href="/posts/levels/#deep"'), "h4 not listed");

    // Watch-mode precondition: a second build in the same process re-renders
    // from scratch and must not accumulate suffixes or injections.
    const { value: again } = await capture(() =>
      build({ flags: { drafts: false, future: false, noCache: true } }),
    );
    assert.deepEqual(
      again.featureErrors.filter((entry) => entry.feature === "src/features/toc.ts"),
      [],
    );
    const dupAgain = await readFile(path.join(root, "dist", "posts", "dup", "index.html"), "utf8");
    assert.equal(dupAgain, dup, "rebuild output must be byte-identical");
  });
});

test("build: features.toc.depth 2 reaches the renderer through the config seam", async () => {
  const config = "export default { features: { toc: { depth: 2 } } };\n";
  await withProject({ ...CONTENT, "kiln.config.ts": config }, async (root) => {
    const { value: report } = await capture(() => build());
    assert.deepEqual(
      report.featureErrors.filter((entry) => entry.feature === "src/features/toc.ts"),
      [],
    );
    const levels = await readFile(path.join(root, "dist", "posts", "levels", "index.html"), "utf8");
    assert.ok(levels.includes('id="subsub"'), "h3 still gets an anchor");
    assert.ok(levels.includes('<a href="/posts/levels/#sub">Sub</a>'));
    assert.ok(!levels.includes('href="/posts/levels/#subsub"'), "h3 hidden at depth 2");
    assert.ok(!levels.includes('href="/posts/levels/#deep"'));
  });
});
