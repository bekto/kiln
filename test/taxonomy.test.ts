/**
 * T014 acceptance — tags & category archives through the real pipeline
 * (temp-dir fixture builds; the repo `templates/` tree is copied so the
 * T014 partial and every sibling feature's partial resolve), plus direct
 * `onDocument`/`onSite` calls for T015's page-1 slicing seam and the
 * `data.published !== false` participation rule. Feature failures are
 * asserted on the recorded report / CLI exit code — `build()` records them
 * and never throws (T012 contract).
 */
import assert from "node:assert/strict";
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
import { build } from "../src/pipeline/build.ts";
import type { BuildReport } from "../src/pipeline/report.ts";
import type { FeatureContext } from "../src/feature.ts";
import type { Page, Site } from "../src/content/document.ts";
import taxonomy from "../src/features/taxonomy.ts";
import { slugify } from "../src/content/slug.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(TEST_DIR);

const FLAGS = { drafts: false, future: false, noCache: true };

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
 * Fixture files: the whole repo `templates/` tree (so feature partials
 * resolve) plus a config with `site.url` (T018/T019 validate it), overlaid
 * with the test's own files.
 */
async function fixture(
  extra: Record<string, string>,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {
    "kiln.config.ts":
      'export default { site: { title: "Taxonomy", url: "https://example.com" } };\n',
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
  return files;
}

/**
 * Materialize a project in the OS temp dir, chdir into it (T010 resolves
 * `templates/` against the cwd), run `fn`, then restore the cwd and clean
 * up — even when `fn` throws.
 */
async function withProject<T>(
  files: Record<string, string>,
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "kiln-taxonomy-"));
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
async function buildHere(): Promise<{ report: BuildReport; stdout: string }> {
  const captured = await capture(() => build({ flags: FLAGS }));
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

/** One fixture post (all under `content/posts/` → posts collection). */
function postFile(
  title: string,
  date: string,
  extraFrontmatter = "",
): string {
  const lines = [`title: ${title}`, `date: ${date}`, extraFrontmatter].filter(
    (line) => line !== "",
  );
  return `---\n${lines.join("\n")}\n---\nBody of ${title}.\n`;
}

test("three posts tagged kilo → archive lists exactly those three newest first; index shows count 3; report lists both", async () => {
  const files = await fixture({
    "content/posts/a.md": postFile("Alpha", "2026-01-01", "tags: [kilo]"),
    "content/posts/b.md": postFile("Bravo", "2026-01-03", "tags: [kilo]"),
    "content/posts/c.md": postFile("Charlie", "2026-01-02", "tags: [kilo]"),
    // Newest post of all, untagged: must not leak into the archive.
    "content/posts/plain.md": postFile("Plain", "2026-01-04"),
  });
  await withProject(files, async (root) => {
    const { report } = await buildHere();
    assert.deepEqual(report.featureErrors, []);

    // Report: both pages emitted with their pretty-path URLs (T014 §append).
    assert.ok(
      report.emitted.some(
        (page) =>
          page.url === "/tags/kilo/" && page.file === "tags/kilo/index.html",
      ),
      JSON.stringify(report.emitted),
    );
    assert.ok(
      report.emitted.some(
        (page) => page.url === "/tags/" && page.file === "tags/index.html",
      ),
      JSON.stringify(report.emitted),
    );

    const archive = await readDist(root, "tags/kilo/index.html");
    assert.match(archive, /^<!doctype html>/m); // reuses T009's index layout chain
    const items = [...archive.matchAll(/<li>[\s\S]*?<\/li>/g)].map(
      (match) => match[0],
    );
    assert.equal(items.length, 3, archive);
    assert.match(items[0], /href="\/posts\/b\/">Bravo</);
    assert.match(items[0], /<time datetime="2026-01-03">2026-01-03<\/time>/);
    assert.match(items[1], /href="\/posts\/c\/">Charlie</);
    assert.match(items[2], /href="\/posts\/a\/">Alpha</);
    assert.doesNotMatch(archive, /Plain/);

    const index = await readDist(root, "tags/index.html");
    assert.match(index, /<a href="\/tags\/kilo\/">kilo<\/a>/);
    assert.match(index, /<span class="count">\(3\)<\/span>/);
    assert.doesNotMatch(index, /Plain/);
  });
});

test("category: news → /categories/news/ archive exists and the index lists it", async () => {
  const files = await fixture({
    "content/posts/n.md": postFile("News post", "2026-02-01", "category: news"),
  });
  await withProject(files, async (root) => {
    const { report } = await buildHere();
    assert.deepEqual(report.featureErrors, []);
    assert.ok(
      report.emitted.some(
        (page) =>
          page.url === "/categories/news/" &&
          page.file === "categories/news/index.html",
      ),
      JSON.stringify(report.emitted),
    );

    const archive = await readDist(root, "categories/news/index.html");
    assert.match(archive, /<h1>news<\/h1>/);
    assert.match(archive, /href="\/posts\/n\/">News post</);

    const index = await readDist(root, "categories/index.html");
    assert.match(index, /<a href="\/categories\/news\/">news<\/a>/);
    assert.match(index, /<span class="count">\(1\)<\/span>/);

    // No tags on the site → no tag index (kinds are independent).
    await assert.rejects(readDist(root, "tags/index.html"), {
      code: "ENOENT",
    });
  });
});

test('tags: [""] fails the build naming the tag and the document; exit 1', async () => {
  const files = await fixture({
    "content/posts/bad.md": '---\ntitle: Bad\ndate: 2026-01-01\ntags: [""]\n---\nBad.',
  });
  await withProject(files, async (root) => {
    const { report } = await buildHere();
    assert.equal(report.featureErrors.length, 1, JSON.stringify(report.featureErrors));
    const error = report.featureErrors[0];
    assert.equal(error.feature, "src/features/taxonomy.ts");
    assert.equal(error.hook, "onDocument");
    assert.ok(
      error.message.includes(path.join(root, "content", "posts", "bad.md")),
      error.message,
    );
    assert.match(error.message, /tags: tag "" must be a non-empty string/);
    assert.equal(report.emitted.length, 0); // stopped before emit

    // The command maps non-empty featureErrors to exit code 1.
    const failed = await runCommand([]);
    assert.equal(failed.exitCode, 1);
    assert.match(
      failed.stdout,
      /src\/features\/taxonomy\.ts \(onDocument\): .*tags: tag "" must be a non-empty string/,
    );
  });
});

test("whitespace-only and non-string tags fail naming the value and the document", async () => {
  for (const [raw, shown] of [
    ['tags: ["   "]', '"   "'],
    ["tags: [42]", "42"],
  ] as const) {
    const files = await fixture({
      "content/posts/bad.md": `---\ntitle: Bad\ndate: 2026-01-01\n${raw}\n---\nBad.`,
    });
    await withProject(files, async (root) => {
      const { report } = await buildHere();
      assert.equal(report.featureErrors.length, 1, JSON.stringify(report.featureErrors));
      const error = report.featureErrors[0];
      assert.equal(error.feature, "src/features/taxonomy.ts");
      assert.equal(error.hook, "onDocument");
      assert.ok(
        error.message.includes(path.join(root, "content", "posts", "bad.md")),
        error.message,
      );
      assert.ok(
        error.message.includes(`tag ${shown} must be a non-empty string`),
        error.message,
      );
    });
  }
});

test("two distinct terms slugifying to one path fail the build naming both", async () => {
  const files = await fixture({
    "content/posts/one.md": postFile("One", "2026-01-01", "tags: [Web dev]"),
    "content/posts/two.md": postFile("Two", "2026-01-02", "tags: [web-dev]"),
  });
  await withProject(files, async (root) => {
    const { report } = await buildHere();
    assert.equal(report.featureErrors.length, 1, JSON.stringify(report.featureErrors));
    const error = report.featureErrors[0];
    assert.equal(error.feature, "src/features/taxonomy.ts");
    assert.equal(error.hook, "onSite");
    assert.match(error.message, /"Web dev"/);
    assert.match(error.message, /"web-dev"/);
    assert.ok(error.message.includes("one.md"), error.message);
    assert.ok(error.message.includes("two.md"), error.message);
    assert.equal(report.emitted.length, 0); // stopped before emit
  });
});

test("a tag carried only by draft posts fails a default build naming the tag; --drafts builds it", async () => {
  const files = await fixture({
    "content/posts/secret.md":
      "---\ntitle: Secret\ndate: 2026-01-01\ndraft: true\ntags: [lonely]\n---\nSecret.",
    "content/posts/plain.md": postFile("Plain", "2026-01-02"),
  });
  await withProject(files, async (root) => {
    const { report } = await buildHere();
    assert.equal(report.featureErrors.length, 1, JSON.stringify(report.featureErrors));
    const error = report.featureErrors[0];
    assert.equal(error.feature, "src/features/taxonomy.ts");
    assert.equal(error.hook, "onSite");
    // The tag exactly as written, plus the source document.
    assert.match(error.message, /tags: "lonely" has no visible posts/);
    assert.ok(
      error.message.includes(path.join(root, "content", "posts", "secret.md")),
      error.message,
    );

    // Same fixture with --drafts: the draft is visible → the archive builds.
    const drafts = await capture(() =>
      build({ flags: { drafts: true, future: false, noCache: true } }),
    );
    assert.deepEqual(drafts.value.featureErrors, []);
    assert.ok(
      drafts.value.emitted.some((page) => page.url === "/tags/lonely/"),
      JSON.stringify(drafts.value.emitted),
    );
    const archive = await readDist(root, "tags/lonely/index.html");
    assert.match(archive, /href="\/posts\/secret\/">Secret</);
  });
});

test("unicode tag: archive URL equals T005's slug output; the index link resolves", async () => {
  const files = await fixture({
    "content/posts/u.md": postFile("Uni", "2026-01-04", "tags: [技術]"),
  });
  await withProject(files, async (root) => {
    const { report } = await buildHere();
    assert.deepEqual(report.featureErrors, []);

    const slug = slugify("技術");
    assert.equal(slug, "技術"); // T005's unicode-safe slugger
    assert.ok(
      report.emitted.some(
        (page) =>
          page.url === `/tags/${slug}/` &&
          page.file === `tags/${slug}/index.html`,
      ),
      JSON.stringify(report.emitted),
    );

    const archive = await readDist(root, `tags/${slug}/index.html`);
    assert.match(archive, /href="\/posts\/u\/">Uni</);

    // The index href is percent-encoded and decodes back to the archive URL.
    const index = await readDist(root, "tags/index.html");
    const href = index.match(/<a href="([^"]+)">技術<\/a>/)?.[1];
    assert.ok(href, index);
    assert.match(href, /%E6%8A%80%E8%A1%93/);
    assert.equal(decodeURIComponent(href), `/tags/${slug}/`);
    // …and the decoded target is exactly the file that was emitted.
    await readDist(root, path.join(decodeURIComponent(href), "index.html").replace(/^\/+/, ""));
  });
});

test("index lists terms sorted by slug for deterministic output", async () => {
  const files = await fixture({
    "content/posts/z.md": postFile("Zed", "2026-03-01", "tags: [zeta]"),
    "content/posts/a.md": postFile("Ay", "2026-01-01", "tags: [alpha]"),
  });
  await withProject(files, async (root) => {
    const { report } = await buildHere();
    assert.deepEqual(report.featureErrors, []);
    const index = await readDist(root, "tags/index.html");
    assert.ok(
      index.indexOf("/tags/alpha/") < index.indexOf("/tags/zeta/"),
      index,
    );
  });
});

test("T015 seam: site.data.pagination.pageSize slices page 1; absent renders the full list", async () => {
  // A fresh context per "build" mirrors T012; options() throwing proves
  // this feature never reads config (no taxonomy config key).
  const makeCtx = (): FeatureContext => ({
    name: "taxonomy",
    flags: { drafts: false, future: false, noCache: false },
    options: () => {
      throw new Error("taxonomy must not read config options");
    },
  });

  const page = (slug: string, title: string, date: string): Page => ({
    path: `/site/content/posts/${slug}.md`,
    url: `/posts/${slug}/`,
    content: "",
    data: {
      title,
      date: new Date(date),
      collection: "posts",
      tags: ["kilo"],
    },
  });

  const run = async (
    pagination?: Record<string, unknown>,
  ): Promise<{ site: Site; archive: Page; index: Page }> => {
    const site: Site = {
      pages: [
        page("old", "Old", "2026-01-01"),
        page("mid", "Mid", "2026-01-02"),
        page("new", "New", "2026-01-03"),
      ],
      data: pagination === undefined ? {} : { pagination },
    };
    const ctx = makeCtx();
    assert.ok(taxonomy.onDocument);
    assert.ok(taxonomy.onSite);
    for (const doc of site.pages) await taxonomy.onDocument(doc, ctx);
    await taxonomy.onSite(site, ctx);

    const archive = site.pages.find((p) => p.url === "/tags/kilo/");
    const index = site.pages.find((p) => p.url === "/tags/");
    assert.ok(archive, "archive page appended");
    assert.ok(index, "index page appended");
    return { site, archive, index };
  };

  // Absent seam → full list, newest first (collection order).
  const full = await run();
  assert.equal(full.site.pages.length, 5); // 3 posts + archive + index
  assert.equal(full.archive.data.permalink, "/tags/kilo/");
  assert.equal(full.archive.data.layout, "taxonomy-list");
  assert.equal(full.archive.path, "taxonomy:/tags/kilo/");
  const fullPosts = full.archive.data.posts as Array<{ title: string }>;
  assert.deepEqual(
    fullPosts.map((entry) => entry.title),
    ["New", "Mid", "Old"],
  );
  // Index counts are totals — slicing never shrinks them.
  const fullEntries = full.index.data.posts as Array<{ count: number }>;
  assert.equal(fullEntries[0].count, 3);

  // Published seam → page 1 renders only the first pageSize entries…
  const sliced = await run({ pageSize: 2 });
  const slicedPosts = sliced.archive.data.posts as Array<{ title: string }>;
  assert.deepEqual(
    slicedPosts.map((entry) => entry.title),
    ["New", "Mid"],
  );
  // …while the index still reports the full count.
  const slicedEntries = sliced.index.data.posts as Array<{ count: number }>;
  assert.equal(slicedEntries[0].count, 3);
});

test("only posts with data.published !== false participate in archives", async () => {
  const makeCtx = (): FeatureContext => ({
    name: "taxonomy",
    flags: { drafts: false, future: false, noCache: false },
    options: () => {
      throw new Error("taxonomy must not read config options");
    },
  });
  const doc = (slug: string, published: boolean): Page => ({
    path: `/site/content/posts/${slug}.md`,
    url: `/posts/${slug}/`,
    content: "",
    data: {
      title: slug,
      date: new Date("2026-01-01"),
      collection: "posts",
      tags: ["shared"],
      published,
    },
  });

  const site: Site = {
    pages: [doc("shown", true), doc("hidden", false)],
    data: {},
  };
  const ctx = makeCtx();
  assert.ok(taxonomy.onDocument);
  assert.ok(taxonomy.onSite);
  for (const page of site.pages) await taxonomy.onDocument(page, ctx);
  await taxonomy.onSite(site, ctx);

  const archive = site.pages.find((p) => p.url === "/tags/shared/");
  assert.ok(archive, "archive page appended");
  const posts = archive.data.posts as Array<{ url: string }>;
  assert.deepEqual(
    posts.map((entry) => entry.url),
    ["/posts/shown/"], // the published=false post stays out — and the term
    // still has a visible carrier, so no zero-post error fires.
  );
});
