/**
 * T015 acceptance — pagination through the real pipeline (temp-dir fixture
 * builds; the repo `templates/` tree is copied so every sibling partial
 * resolves, then `index.html` is overlaid with an assertion-friendly home
 * that renders `page.posts` AND loops `site.pages` — the strict `p.url`
 * render there is the T014 integration guard: an appended page without
 * `url` would crash the build). Feature failures are asserted on the
 * recorded report / CLI exit code — `build()` records them and never
 * throws (T012 contract).
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
 * The assertion-friendly home: renders `page.posts` (the array pagination
 * slices) plus a `site.pages` loop — the latter reproduces T014's strict
 * `p.url` crash unless appended pages carry `url`.
 */
const HOME = [
  '{% extends "base.html" %}',
  "{% block content %}",
  '<h1>{% if page.title %}{{ page.title }}{% elif site.title %}{{ site.title }}{% else %}Kiln site{% endif %}</h1>',
  '<ul id="posts">{% for post in page.posts %}<li><a href="{{ post.url }}">{% if post.title %}{{ post.title }}{% else %}{{ post.url }}{% endif %}</a></li>{% endfor %}</ul>',
  '<ul id="all-pages">{% for p in site.pages %}<li><a href="{{ p.url }}">{% if p.title %}{{ p.title }}{% else %}{{ p.url }}{% endif %}</a></li>{% endfor %}</ul>',
  "{% endblock %}",
].join("\n");

/**
 * Fixture files: the whole repo `templates/` tree (so feature partials
 * resolve) plus a config with `site.url` (T018/T019 validate it), the
 * home document, and the test's own files; `index.html` is overlaid last.
 */
async function fixture(
  extra: Record<string, string>,
  features?: Record<string, unknown>,
): Promise<Record<string, string>> {
  const config =
    features === undefined
      ? 'export default { site: { title: "Pagination", url: "https://example.com" } };\n'
      : `export default { site: { title: "Pagination", url: "https://example.com" }, features: ${JSON.stringify(features)} };\n`;
  const files: Record<string, string> = {
    "kiln.config.ts": config,
    "content/index.md": "---\ntitle: Home\nlayout: index\n---\nHome.",
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
  files: Record<string, string>,
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "kiln-pagination-"));
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

/**
 * One fixture post: `content/posts/pNN.md`, title `Post NN`, dated
 * `2026-01-NN` so the newest-first order is `Post 25` … `Post 01`.
 */
function postFile(n: number, extraFrontmatter = ""): [string, string] {
  const id = String(n).padStart(2, "0");
  const lines = [
    `title: Post ${id}`,
    `date: 2026-01-${id}`,
    extraFrontmatter,
  ].filter((line) => line !== "");
  return [
    `content/posts/p${id}.md`,
    `---\n${lines.join("\n")}\n---\nBody of Post ${id}.\n`,
  ];
}

/** `count` fixture posts (p01 … pNN) as a fixture file map. */
function posts(
  count: number,
  extraFrontmatter = "",
): Record<string, string> {
  const files: Record<string, string> = {};
  for (let n = 1; n <= count; n += 1) {
    const [name, source] = postFile(n, extraFrontmatter);
    files[name] = source;
  }
  return files;
}

/** Items of the home-style post list (`<ul id="posts">`). */
function postItems(html: string): string[] {
  const list = /<ul id="posts">([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? "";
  return [...list.matchAll(/<li>[\s\S]*?<\/li>/g)].map((match) => match[0]);
}

test("25 posts at the default pageSize: three home pages with prev/next; posts never paginate", async () => {
  const files = await fixture(posts(25));
  await withProject(files, async (root) => {
    const { report } = await buildHere();
    assert.deepEqual(report.featureErrors, []);

    // Overflow pages flow through T010's emit with the pretty-path target.
    assert.ok(
      report.emitted.some(
        (page) =>
          page.url === "/page/2/" && page.file === "page/2/index.html",
      ),
      JSON.stringify(report.emitted),
    );
    assert.ok(
      report.emitted.some(
        (page) =>
          page.url === "/page/3/" && page.file === "page/3/index.html",
      ),
      JSON.stringify(report.emitted),
    );

    // Page 1: 10 entries, next → /page/2/, no prev.
    const home = await readDist(root, "index.html");
    const page1 = postItems(home);
    assert.equal(page1.length, 10, home);
    assert.match(page1[0], /href="\/posts\/p25\/">Post 25</);
    assert.match(home, /<a rel="next" href="\/page\/2\/">/);
    assert.doesNotMatch(home, /rel="prev"/);

    // Page 2: entries 11–20, prev is `/` (never /page/1/), next → /page/3/.
    const second = await readDist(root, "page/2/index.html");
    const page2 = postItems(second);
    assert.equal(page2.length, 10, second);
    assert.match(page2[0], /href="\/posts\/p15\/">Post 15</);
    assert.match(second, /<a rel="prev" href="\/">/);
    assert.match(second, /<a rel="next" href="\/page\/3\/">/);
    assert.doesNotMatch(second, /\/page\/1\//);

    // Page 3: the remaining 5, prev → /page/2/, no next (last page).
    const third = await readDist(root, "page/3/index.html");
    const page3 = postItems(third);
    assert.equal(page3.length, 5, third);
    assert.match(page3[0], /href="\/posts\/p05\/">Post 05</);
    assert.match(third, /<a rel="prev" href="\/page\/2\/">/);
    assert.doesNotMatch(third, /rel="next"/);

    // Single-post pages contain no pagination navigation at all.
    const post = await readDist(root, "posts/p01/index.html");
    assert.doesNotMatch(post, /\/page\//);
    assert.doesNotMatch(post, /class="pagination"/);
  });
});

test("exactly pageSize posts → one page: no dist/page/, the partial emits nothing", async () => {
  const files = await fixture(posts(10));
  await withProject(files, async (root) => {
    const { report } = await buildHere();
    assert.deepEqual(report.featureErrors, []);

    await assert.rejects(stat(path.join(root, "dist", "page")), {
      code: "ENOENT",
    });
    const home = await readDist(root, "index.html");
    assert.equal(postItems(home).length, 10, home); // canonical list unchanged
    assert.doesNotMatch(home, /class="pagination"/); // partial emitted nothing
    assert.doesNotMatch(home, /\/page\//);
    assert.ok(
      !report.emitted.some((page) => page.url.startsWith("/page/")),
      JSON.stringify(report.emitted),
    );
  });
});

test("a tag with 12 posts → archive overflow with 2 entries; page 1 renders 10 (pageSize seam)", async () => {
  const files = await fixture(posts(12, "tags: [kilo]"));
  await withProject(files, async (root) => {
    const { report } = await buildHere();
    assert.deepEqual(report.featureErrors, []);
    assert.ok(
      report.emitted.some(
        (page) =>
          page.url === "/tags/kilo/page/2/" &&
          page.file === "tags/kilo/page/2/index.html",
      ),
      JSON.stringify(report.emitted),
    );

    // Page 1 is sliced through the seam (site.data.pagination.pageSize).
    const first = await readDist(root, "tags/kilo/index.html");
    const page1 = [...first.matchAll(/<li>[\s\S]*?<\/li>/g)].map((m) => m[0]);
    assert.equal(page1.length, 10, first);
    assert.match(page1[0], /href="\/posts\/p12\/">Post 12</);

    // Page 2 continues the newest-first sequence with the two oldest.
    const second = await readDist(root, "tags/kilo/page/2/index.html");
    const page2 = [...second.matchAll(/<li>[\s\S]*?<\/li>/g)].map((m) => m[0]);
    assert.equal(page2.length, 2, second);
    assert.match(page2[0], /href="\/posts\/p02\/">Post 02</);
    assert.match(page2[1], /href="\/posts\/p01\/">Post 01</);

    // Archive overflow nav: prev back to the canonical archive (never
    // /page/1/), no next on the last page.
    assert.match(second, /<a rel="prev" href="\/tags\/kilo\/">/);
    assert.doesNotMatch(second, /rel="next"/);
    assert.doesNotMatch(second, /\/page\/1\//);

    // The home list paginates independently (12 posts → 2 pages).
    const home = await readDist(root, "index.html");
    assert.equal(postItems(home).length, 10, home);
    assert.match(home, /<a rel="next" href="\/page\/2\/">/);
  });
});

test("11 posts with 1 draft → one page by default; --drafts creates /page/2/", async () => {
  const files = posts(11);
  files["content/posts/p11.md"] =
    "---\ntitle: Post 11\ndate: 2026-01-11\ndraft: true\n---\nBody of Post 11.\n";
  const project = await fixture(files);
  await withProject(project, async (root) => {
    const plain = await buildHere();
    assert.deepEqual(plain.report.featureErrors, []);
    await assert.rejects(stat(path.join(root, "dist", "page")), {
      code: "ENOENT",
    });
    const home = await readDist(root, "index.html");
    // The draft never occupies a page slot: 10 visible → exactly one page.
    assert.equal(postItems(home).length, 10, home);
    assert.doesNotMatch(home, /Post 11/);

    const drafted = await runCommand(["--drafts"]);
    assert.equal(drafted.exitCode, undefined, drafted.stdout);
    const second = await readDist(root, "page/2/index.html");
    assert.equal(postItems(second).length, 1, second);
    assert.match(second, /Post 11/);
    assert.match(second, /<a rel="prev" href="\/">/);
  });
});

test("features.pagination.pageSize: 0, negative, fractional, or non-number fails naming the key; exit 1", async () => {
  for (const bad of [0, -1, 1.5, "10"]) {
    const files = await fixture(posts(3), { pagination: { pageSize: bad } });
    await withProject(files, async (root) => {
      const { report } = await buildHere();
      assert.equal(
        report.featureErrors.length,
        1,
        JSON.stringify(report.featureErrors),
      );
      const error = report.featureErrors[0];
      assert.equal(error.feature, "src/features/pagination.ts");
      assert.equal(error.hook, "onSite");
      assert.ok(error.message.includes("features.pagination"), error.message);
      assert.ok(error.message.includes("pageSize"), error.message);
      assert.equal(report.emitted.length, 0); // stopped before emit

      const failed = await runCommand([]);
      assert.equal(failed.exitCode, 1);
      assert.ok(failed.stdout.includes("features.pagination"), failed.stdout);
      assert.ok(failed.stdout.includes("pageSize"), failed.stdout);
    });
  }
});

test("an existing document claiming an overflow URL fails the build naming the URL; exit 1", async () => {
  const files = await fixture({
    ...posts(25),
    "content/page/2.md": "---\ntitle: Impostor\n---\nI claim /page/2/.",
  });
  await withProject(files, async (root) => {
    const { report } = await buildHere();
    assert.equal(
      report.featureErrors.length,
      1,
      JSON.stringify(report.featureErrors),
    );
    const error = report.featureErrors[0];
    assert.equal(error.feature, "src/features/pagination.ts");
    assert.equal(error.hook, "onSite");
    assert.ok(error.message.includes("/page/2/"), error.message);
    assert.ok(
      error.message.includes(path.join("content", "page", "2.md")),
      error.message,
    );
    assert.equal(report.emitted.length, 0); // stopped before emit

    const failed = await runCommand([]);
    assert.equal(failed.exitCode, 1);
    assert.match(failed.stdout, /\/page\/2\//);
  });
});

test("features.pagination.pageSize: 3 slices the home list into 3/3/1 pages", async () => {
  const files = await fixture(posts(7), { pagination: { pageSize: 3 } });
  await withProject(files, async (root) => {
    const { report } = await buildHere();
    assert.deepEqual(report.featureErrors, []);

    const home = await readDist(root, "index.html");
    assert.equal(postItems(home).length, 3, home);
    assert.match(home, /<a rel="next" href="\/page\/2\/">/);

    const second = await readDist(root, "page/2/index.html");
    assert.equal(postItems(second).length, 3, second);
    assert.match(second, /<a rel="prev" href="\/">/);
    assert.match(second, /<a rel="next" href="\/page\/3\/">/);

    const third = await readDist(root, "page/3/index.html");
    assert.equal(postItems(third).length, 1, third);
    assert.match(third, /<a rel="prev" href="\/page\/2\/">/);
    assert.doesNotMatch(third, /rel="next"/);
    await assert.rejects(stat(path.join(root, "dist", "page", "4")), {
      code: "ENOENT",
    });
  });
});

test("watch-mode: a second build recomputes the same pages from scratch", async () => {
  const files = await fixture(posts(25));
  await withProject(files, async (root) => {
    const first = await buildHere();
    assert.deepEqual(first.report.featureErrors, []);
    const second = await buildHere();
    assert.deepEqual(second.report.featureErrors, []);
    assert.deepEqual(second.report.emitted, first.report.emitted);
    // Still exactly one overflow set — no doubled or duplicated appends.
    const page2 = await readDist(root, "page/2/index.html");
    assert.equal(postItems(page2).length, 10, page2);
  });
});
