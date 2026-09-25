/**
 * T019 acceptance — `dist/sitemap.xml`.
 *
 * Unit level (direct `onBuildEnd` invocation, independent of feature
 * discovery): the `<loc>` set is the `.html` subset of `emitted` resolved
 * against `site.url` (origin + path, no `//`, unicode percent-encoded),
 * sorted lexicographically, `<lastmod>` mapped from each source page's
 * frontmatter `date`, non-HTML emissions and `sitemap.xml` itself excluded,
 * and every bad/missing `site.url` rejected naming the key.
 *
 * Build level (real `build()` runs in a temp project): the sitemap equals
 * what T010 actually emitted on disk, drafts stay out until `--drafts`, and
 * an unusable `site.url` fails the build with exit 1.
 */
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
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
import type { Page, Site } from "../src/content/document.ts";
import type { BuildEnd, FeatureContext } from "../src/feature.ts";
import sitemap from "../src/features/sitemap.ts";
import { build } from "../src/pipeline/build.ts";
import type { EmittedPage } from "../src/render/emit.ts";

/**
 * Fixtures build through the repo's real `templates/` (symlinked into each
 * temp project — `emitPages` resolves `templates/` against the cwd, not the
 * config), so every sibling feature's partial (`feed.xml`,
 * `publish-meta.html`, …) resolves during these in-process builds — a
 * minimal per-fixture layout would fail a sibling's hook before the
 * sitemap's `onBuildEnd` ever runs.
 */
const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TEMPLATES_DIR = path.join(REPO, "templates");

const SITEMAP_NS = "http://www.sitemaps.org/schemas/sitemap/0.9";

/** The sitemap feature reads no options and no flags. */
const CTX: FeatureContext = {
  name: "sitemap",
  flags: { drafts: false, future: false, noCache: false },
  options: (validate) => validate(undefined),
};

/** A {@link BuildEnd} stub for direct hook invocation. */
function buildEnd(
  distDir: string,
  site: Site,
  emitted: EmittedPage[],
): BuildEnd {
  return { distDir, site, emitted, skipped: [] };
}

/** A page with an explicit URL — `pageOutputFor` uses `url` verbatim. */
function page(url: string, data: Record<string, unknown> = {}): Page {
  return { path: "content/page.md", data, content: "", url };
}

/** Run `fn` in a throwaway directory, removed even when `fn` throws. */
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "kiln-sitemap-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface Captured<T> {
  value: T;
  stdout: string;
  stderr: string;
}

/**
 * Run `fn` with `process.stdout`/`process.stderr` writes captured (withheld
 * from the runner's stream) so printed reports can be asserted verbatim;
 * the original streams are restored even when `fn` throws.
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
 * restore the cwd and clean up — even when `fn` throws.
 */
async function withProject<T>(
  files: Record<string, string>,
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "kiln-sitemap-"));
  try {
    for (const [name, source] of Object.entries(files)) {
      const target = path.join(root, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, source);
    }
    // The repo's templates + partials as the project's `templates/` —
    // sibling features' partials must resolve during these builds.
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

/** Every `<loc>` value, in document order. */
function locsOf(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1]);
}

/** `<loc>` → `<lastmod>` (`undefined` when the entry has no such element). */
function lastmodsOf(xml: string): Map<string, string | undefined> {
  const found = new Map<string, string | undefined>();
  const pattern =
    /<url>\s*<loc>([^<]*)<\/loc>(?:\s*<lastmod>([^<]*)<\/lastmod>)?\s*<\/url>/g;
  for (const match of xml.matchAll(pattern)) {
    found.set(match[1], match[2]);
  }
  return found;
}

/** Absolute paths of every `.html` file under `dir` (recursive). */
async function htmlFilesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await htmlFilesUnder(full)));
    } else if (entry.name.endsWith(".html")) {
      found.push(full);
    }
  }
  return found;
}

test("sitemap: only .html emissions listed; absolute over origin+path; sorted; lastmod rules", async () => {
  await withTempDir(async (dir) => {
    const site: Site = {
      pages: [
        page("/"),
        page("/posts/a/", { date: new Date("2026-01-02") }),
        page("/posts/z/", { date: new Date("2024-03-04T05:06:07Z") }),
      ],
      data: { url: "https://example.com/blog" },
    };
    const emitted: EmittedPage[] = [
      { url: "/posts/z/", file: "posts/z/index.html" },
      { url: "/", file: "index.html" },
      { url: "/feed.xml", file: "feed.xml" },
      { url: "/search-index.json", file: "search-index.json" },
      { url: "/sitemap.xml", file: "sitemap.xml" },
      { url: "/posts/a/", file: "posts/a/index.html" },
    ];
    assert.ok(sitemap.onBuildEnd);
    await sitemap.onBuildEnd(buildEnd(dir, site, emitted), CTX);

    const xml = await readFile(path.join(dir, "sitemap.xml"), "utf8");
    assert.ok(
      xml.startsWith(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="${SITEMAP_NS}">`,
      ),
    );
    assert.ok(xml.endsWith("</urlset>\n"));

    // feed.xml / search-index.json / sitemap.xml itself are not `.html`:
    // the loc set is exactly the three HTML pages, sorted, no `//` at the
    // join despite site.url's own path, each absolute under site.url.
    assert.deepEqual(locsOf(xml), [
      "https://example.com/blog/",
      "https://example.com/blog/posts/a/",
      "https://example.com/blog/posts/z/",
    ]);

    const lastmods = lastmodsOf(xml);
    assert.equal(lastmods.get("https://example.com/blog/"), undefined);
    assert.equal(
      lastmods.get("https://example.com/blog/posts/a/"),
      "2026-01-02",
    );
    assert.equal(
      lastmods.get("https://example.com/blog/posts/z/"),
      "2024-03-04T05:06:07.000Z",
    );
  });
});

test("missing site.url: onBuildEnd rejects naming site.url and writes nothing", async () => {
  await withTempDir(async (dir) => {
    assert.ok(sitemap.onBuildEnd);
    await assert.rejects(
      Promise.resolve(
        sitemap.onBuildEnd(buildEnd(dir, { pages: [], data: {} }, []), CTX),
      ),
      /site\.url/,
    );
    await assert.rejects(readFile(path.join(dir, "sitemap.xml")), {
      code: "ENOENT",
    });
  });
});

test("empty/relative/schemeless site.url variants all reject naming site.url", async () => {
  const variants: unknown[] = [
    "",
    "   ",
    "/blog",
    "blog.example.com",
    "//host",
    "ftp://host/",
    42,
  ];
  await withTempDir(async (dir) => {
    assert.ok(sitemap.onBuildEnd);
    for (const url of variants) {
      await assert.rejects(
        Promise.resolve(
          sitemap.onBuildEnd(
            buildEnd(dir, { pages: [], data: { url } }, []),
            CTX,
          ),
        ),
        (error: unknown) => {
          assert.match(
            (error as Error).message,
            /site\.url/,
            `url=${JSON.stringify(url)}`,
          );
          return true;
        },
      );
    }
    await assert.rejects(readFile(path.join(dir, "sitemap.xml")), {
      code: "ENOENT",
    });
  });
});

test("zero emitted pages: a valid empty urlset is still written", async () => {
  await withTempDir(async (dir) => {
    assert.ok(sitemap.onBuildEnd);
    await sitemap.onBuildEnd(
      buildEnd(dir, { pages: [], data: { url: "https://empty.example" } }, []),
      CTX,
    );
    const xml = await readFile(path.join(dir, "sitemap.xml"), "utf8");
    assert.deepEqual(locsOf(xml), []);
    assert.ok(xml.includes(`<urlset xmlns="${SITEMAP_NS}">`));
    assert.ok(xml.endsWith("</urlset>\n"));
  });
});

const SITE = "https://example.com";

const PROJECT: Record<string, string> = {
  "kiln.config.ts": `export default { site: { title: "Sitemap site", url: "${SITE}" } };\n`,
  "content/index.md": "---\ntitle: Home\n---\nHome.",
  "content/about.md": "---\ntitle: About\n---\nAbout.",
  "content/你好世界.md": "---\ntitle: Ni Hao\n---\n你好。",
  "content/posts/hello.md": "---\ntitle: Hello\ndate: 2026-01-02\n---\nHello.",
  "content/posts/stamp.md":
    "---\ntitle: Stamp\ndate: 2024-06-15T09:45:00Z\n---\nStamp.",
};

test("build: loc set equals the emitted HTML set on disk; sorted, unique, no non-HTML; lastmod", async () => {
  await withProject(PROJECT, async (root) => {
    const { value: report } = await capture(() => build());
    assert.deepEqual(report.featureErrors, []);

    const xml = await readFile(path.join(root, "dist", "sitemap.xml"), "utf8");
    const locs = locsOf(xml);

    // One <url>/<loc> per HTML page actually under dist/ …
    assert.equal((xml.match(/<url>/g) ?? []).length, locs.length);
    assert.equal((xml.match(/<\/url>/g) ?? []).length, locs.length);
    const htmlFiles = await htmlFilesUnder(path.join(root, "dist"));
    assert.ok(htmlFiles.length >= 5, `${htmlFiles.length} html files`);
    assert.equal(locs.length, htmlFiles.length);

    // … and the loc set is identical to T010's emitted-URL set (unicode
    // paths percent-encoded by the URL parser, pinned literally below).
    const expected = report.emitted
      .filter((out) => out.file.endsWith(".html"))
      .map((out) => encodeURI(SITE + out.url))
      .sort();
    assert.deepEqual(locs, expected);

    assert.ok(locs.every((loc) => loc.startsWith(SITE)));
    assert.deepEqual(locs, [...locs].sort());
    assert.equal(new Set(locs).size, locs.length);
    assert.ok(!locs.some((loc) => loc.includes(".xml")));

    // Known pages at their exact T005 URLs — unicode percent-encoded.
    for (const known of [
      `${SITE}/`,
      `${SITE}/about/`,
      `${SITE}/posts/hello/`,
      `${SITE}/posts/stamp/`,
      `${SITE}/%E4%BD%A0%E5%A5%BD%E4%B8%96%E7%95%8C/`,
    ]) {
      assert.ok(locs.includes(known), `missing ${known}`);
    }

    // lastmod: date-only, full timestamp with timezone, and absent.
    const lastmods = lastmodsOf(xml);
    assert.equal(lastmods.get(`${SITE}/posts/hello/`), "2026-01-02");
    assert.equal(
      lastmods.get(`${SITE}/posts/stamp/`),
      "2024-06-15T09:45:00.000Z",
    );
    assert.equal(lastmods.get(`${SITE}/`), undefined);
  });
});

const DRAFT_PROJECT: Record<string, string> = {
  "kiln.config.ts":
    'export default { site: { title: "Draft site", url: "https://drafts.example" } };\n',
  "content/index.md": "---\ntitle: Home\n---\nHome.",
  "content/posts/published.md": "---\ntitle: Published\ndate: 2024-01-01\n---\nOut.",
  "content/posts/draft.md": "---\ntitle: Draft\ndraft: true\n---\nWIP.",
};

test("draft: absent from the default build's sitemap (never emitted); present with --drafts", async () => {
  await withProject(DRAFT_PROJECT, async (root) => {
    const draftLoc = "https://drafts.example/posts/draft/";

    const { value: plain } = await capture(() => build());
    assert.deepEqual(plain.featureErrors, []);

    const plainXml = await readFile(
      path.join(root, "dist", "sitemap.xml"),
      "utf8",
    );
    const plainLocs = locsOf(plainXml);
    assert.ok(!plainLocs.includes(draftLoc), "draft leaked into sitemap");
    assert.ok(plainLocs.includes("https://drafts.example/posts/published/"));
    // The mechanism T019 pins: the draft page never reached emit at all.
    await assert.rejects(
      readFile(path.join(root, "dist", "posts", "draft", "index.html")),
      { code: "ENOENT" },
    );

    const { value: withDrafts } = await capture(() =>
      build({ flags: { drafts: true, future: false, noCache: false } }),
    );
    assert.deepEqual(withDrafts.featureErrors, []);
    assert.ok(
      withDrafts.emitted.some((out) => out.url === "/posts/draft/"),
      "T010 did not emit the draft under --drafts",
    );
    const draftXml = await readFile(
      path.join(root, "dist", "sitemap.xml"),
      "utf8",
    );
    assert.ok(locsOf(draftXml).includes(draftLoc), "draft missing with --drafts");
  });
});

test("unusable site.url (/blog, empty): build error naming site.url, exit 1, no sitemap.xml", async () => {
  for (const url of ["/blog", ""]) {
    const project: Record<string, string> = {
      "kiln.config.ts": `export default { site: { title: "Bad", url: ${JSON.stringify(url)} } };\n`,
      "content/index.md": "---\ntitle: Home\n---\nHome.",
    };
    await withProject(project, async (root) => {
      const run = await runCommand([]);
      assert.equal(run.exitCode, 1, `site.url=${JSON.stringify(url)}`);
      assert.match(run.stdout, /feature errors:/);
      assert.match(run.stdout, /site\.url/);
      await assert.rejects(readFile(path.join(root, "dist", "sitemap.xml")), {
        code: "ENOENT",
      });
    });
  }
});

test("one-page site: valid sitemap listing the home URL, exit 0", async () => {
  const project: Record<string, string> = {
    "kiln.config.ts":
      'export default { site: { title: "Solo", url: "https://single.example" } };\n',
    "content/index.md": "---\ntitle: Home\n---\nHome only.",
  };
  await withProject(project, async (root) => {
    const run = await runCommand([]);
    assert.ok(
      run.exitCode === undefined || run.exitCode === 0,
      `exit ${String(run.exitCode)}`,
    );
    const xml = await readFile(path.join(root, "dist", "sitemap.xml"), "utf8");
    const locs = locsOf(xml);
    assert.ok(locs.includes("https://single.example/"));
    assert.ok(xml.includes(`<urlset xmlns="${SITEMAP_NS}">`));
    assert.equal(
      locs.length,
      (await htmlFilesUnder(path.join(root, "dist"))).length,
    );
  });
});
