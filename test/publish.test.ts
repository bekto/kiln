/**
 * T013 acceptance — drafts & scheduled publishing.
 *
 * Unit tests drive the feature's hooks directly (fresh fake contexts;
 * `Date.now` patched synchronously for the clock-bound cases). Pipeline
 * tests materialize a project in the OS temp dir and run `build()` /
 * the build command in-process — never spawning the CLI, which could race
 * test/cli.test.ts's temporary command files (same reasoning as
 * test/build.test.ts).
 *
 * The ordering guarantees pinned here by probe features written into the
 * repo's `src/features/` (removed in `finally`):
 *  1. `data.published` exists (boolean) for every discovered document
 *     before rendering and before any onSite/onBuildEnd;
 *  2. an onBuildEnd reader that filename-sorts BEFORE `publish.ts`
 *     (`__t013_before`) sees only published URLs — all onSite hooks
 *     completed first;
 *  3. a pre-publish onSite still sees hidden documents, flagged
 *     `published === false`, and must skip them;
 *  4. an onSite sorting AFTER `publish.ts` (`zz_t013_after`) sees hidden
 *     documents already removed.
 */
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Document, Page, Site } from "../src/content/document.ts";
import { run as runBuildCommand } from "../src/commands/build.ts";
import type { BuildFlags, FeatureContext } from "../src/feature.ts";
import publish from "../src/features/publish.ts";
import { build } from "../src/pipeline/build.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(TEST_DIR);
const FEATURES_DIR = path.join(REPO, "src", "features");

const DRAFT_URL = "/posts/draft/";
const FUTURE_URL = "/posts/future/";
const PAST_ISO = "2020-01-01T00:00:00Z";
const NOINDEX = '<meta name="robots" content="noindex">';

const onDocument = publish.onDocument!;
const onSite = publish.onSite!;

// ---------------------------------------------------------------------------
// Unit helpers — fake context/documents, no pipeline.
// ---------------------------------------------------------------------------

function ctxFor(flags: Partial<BuildFlags>): FeatureContext {
  return {
    name: "publish",
    flags: { drafts: false, future: false, noCache: false, ...flags },
    options<T>(validate: (raw: unknown) => T): T {
      return validate(undefined);
    },
  };
}

function docFor(filePath: string, data: Record<string, unknown>): Document {
  return { path: filePath, data, content: "" };
}

function pageFor(url: string, published?: boolean): Page {
  const page: Page = { path: `/fixture${url}index.md`, url, data: {}, content: "" };
  if (published !== undefined) page.data.published = published;
  return page;
}

/** Boolean `data.published` after one onDocument pass. */
function publishedOf(doc: Document, ctx: FeatureContext): boolean {
  onDocument(doc, ctx);
  assert.equal(typeof doc.data.published, "boolean");
  return doc.data.published as boolean;
}

// ---------------------------------------------------------------------------
// Pipeline helpers (adapted from test/build.test.ts).
// ---------------------------------------------------------------------------

interface Captured<T> {
  value: T;
  stdout: string;
  stderr: string;
}

/** Run `fn` with stdout/stderr writes captured; streams restored even on throw. */
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
  exitCode: number | string | undefined;
}

/** Invoke `kiln build`'s run in-process with streams + exitCode captured. */
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
 * Materialize a project in the OS temp dir, chdir into it (T010 resolves
 * `templates/` against the cwd), run `fn`, then restore the cwd and clean up
 * — even when `fn` throws.
 */
async function withProject<T>(
  files: Record<string, string>,
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "kiln-publish-"));
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

/**
 * Write probe feature modules into the repo's `src/features/`, run `fn`,
 * then delete them — cleanup runs even when `fn` or an assertion throws.
 * The directory itself survives (the real `publish.ts` lives there).
 */
async function withFeatures<T>(
  files: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  await mkdir(FEATURES_DIR, { recursive: true });
  const targets = Object.keys(files).map((file) => path.join(FEATURES_DIR, file));
  for (const [file, source] of Object.entries(files)) {
    await writeFile(path.join(FEATURES_DIR, file), source);
  }
  try {
    return await fn();
  } finally {
    await Promise.all(targets.map((target) => rm(target, { force: true })));
    if ((await readdir(FEATURES_DIR)).length === 0) {
      await rm(FEATURES_DIR, { recursive: true });
    }
  }
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(() => true, () => false);
}

// ---------------------------------------------------------------------------
// Fixture — real base/post layouts + the real noindex partial from the repo,
// a home template exposing both the site list and `collections.posts`.
// ---------------------------------------------------------------------------

const HOME = [
  '{% extends "base.html" %}',
  "{% block content %}",
  '<ul id="site-pages">{% for p in site.pages %}<li><a href="{{ p.url }}">{% if p.title %}{{ p.title }}{% else %}{{ p.url }}{% endif %}</a></li>{% endfor %}</ul>',
  '<ul id="collection-posts">{% for p in collections.posts %}<li><a href="{{ p.url }}">{% if p.title %}{{ p.title }}{% else %}{{ p.url }}{% endif %}</a></li>{% endfor %}</ul>',
  "{% endblock %}",
].join("\n");

/** Renders T022's `related` list so the plain build can grep it for leaks. */
const POST_WITH_RELATED = [
  '{% extends "base.html" %}',
  "{% block content %}",
  "<article>",
  "{% if page.title %}<h1>{{ page.title }}</h1>{% endif %}",
  "{{ content | safe }}",
  '<ul id="related">{% if related %}{% for r in related %}<li><a href="{{ r.url }}">{{ r.url }}</a></li>{% endfor %}{% endif %}</ul>',
  "</article>",
  "{% endblock %}",
].join("\n");

/**
 * One visible post, one draft, one future-dated post, plus home. The whole
 * repo `templates/` tree is copied so every feature that renders its own
 * partial (feed, search, …) finds it, then `index.html` is overridden with
 * the assertion-friendly home below. All three posts share a tag so T022's
 * related scoring would surface a hidden post if filtering ever leaked; the
 * visible post renders its `related` list through `post-related.html`.
 */
async function fixtureFiles(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
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
  files["templates/post-related.html"] = POST_WITH_RELATED;
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  files["content/index.md"] = "---\ntitle: Home\nlayout: index\n---\nHome.";
  files["content/posts/visible.md"] = `---\ntitle: Visible\ndate: "${PAST_ISO}"\ntags: [news]\nlayout: post-related\n---\nVisible body.`;
  files["content/posts/draft.md"] = `---\ntitle: Draft\ndate: "${PAST_ISO}"\ndraft: true\ntags: [news]\n---\nDraft body.`;
  files["content/posts/future.md"] = `---\ntitle: Future\ndate: "${tomorrow}"\ntags: [news]\n---\nFuture body.`;
  return files;
}

const PLAIN_FLAGS: BuildFlags = { drafts: false, future: false, noCache: true };

// ---------------------------------------------------------------------------
// Unit: visibility resolution (guarantee 1's contract — data.published).
// ---------------------------------------------------------------------------

test("onDocument: data.published — drafts, future dates, and flag overrides", () => {
  const plain = ctxFor({});

  const past = docFor("/site/content/posts/a.md", { date: new Date(PAST_ISO) });
  assert.equal(publishedOf(past, plain), true);

  const noDate = docFor("/site/content/index.md", {});
  assert.equal(publishedOf(noDate, plain), true);

  const draft = docFor("/site/content/posts/b.md", {
    draft: true,
    date: new Date(PAST_ISO),
  });
  assert.equal(publishedOf(draft, plain), false);

  const soon = new Date(Date.now() + 60 * 60 * 1000);
  const future = docFor("/site/content/posts/c.md", { date: soon });
  assert.equal(publishedOf(future, plain), false);

  // --drafts publishes raw drafts, --future publishes future posts.
  const draftShown = docFor("/site/content/posts/d.md", {
    draft: true,
    date: new Date(PAST_ISO),
  });
  assert.equal(publishedOf(draftShown, ctxFor({ drafts: true })), true);

  const futureShown = docFor("/site/content/posts/e.md", { date: soon });
  assert.equal(publishedOf(futureShown, ctxFor({ future: true })), true);

  // draft-only includes drafts but not future; future-only the converse;
  // both flags include both classes.
  const draftFuture = docFor("/site/content/posts/f.md", { draft: true, date: soon });
  assert.equal(publishedOf(draftFuture, ctxFor({ drafts: true })), false);
  assert.equal(
    publishedOf(docFor("/site/content/posts/g.md", { draft: true }), ctxFor({ drafts: true })),
    true,
  );
  const both = docFor("/site/content/posts/h.md", { draft: true, date: soon });
  assert.equal(publishedOf(both, ctxFor({ drafts: true, future: true })), true);
});

test("onDocument: a date exactly equal to the build time counts as published", () => {
  const real = Date.now;
  try {
    const now = 1_700_000_000_000;
    Date.now = () => now;
    const ctx = ctxFor({});
    assert.equal(
      publishedOf(docFor("/site/content/posts/eq.md", { date: new Date(now) }), ctx),
      true,
      "date === build time is published",
    );
    assert.equal(
      publishedOf(docFor("/site/content/posts/ms.md", { date: new Date(now + 1) }), ctx),
      false,
      "date 1ms after build time is hidden",
    );
    assert.equal(
      publishedOf(docFor("/site/content/posts/pre.md", { date: new Date(now - 1) }), ctx),
      true,
      "date 1ms before build time is published",
    );
  } finally {
    Date.now = real;
  }
});

test("clock: one build start per context; a fresh context (next build) recaptures", () => {
  const real = Date.now;
  try {
    // First Date.now() call captures 1000 for this context; later wall-clock
    // jumps within the same build must not move the build start.
    let calls = 0;
    Date.now = () => (calls++ === 0 ? 1000 : 9999);
    const first = ctxFor({});
    const a = docFor("/site/content/posts/a.md", { date: new Date(1500) });
    const b = docFor("/site/content/posts/b.md", { date: new Date(2000) });
    onDocument(a, first);
    onDocument(b, first);
    assert.equal(a.data.published, false, "1500 > start 1000 → hidden");
    assert.equal(
      b.data.published,
      false,
      "second document reuses the captured start, not the wall clock",
    );

    // A fresh context means a new build: the clock recaptures at 5000, so a
    // 3000 date (hidden under a stale 1000 clock) becomes published.
    Date.now = () => 5000;
    const second = ctxFor({});
    const c = docFor("/site/content/posts/c.md", { date: new Date(3000) });
    onDocument(c, second);
    assert.equal(c.data.published, true, "fresh context recaptured the clock");
  } finally {
    Date.now = real;
  }
});

test("onDocument: raw drafts append publish-meta.html to injectHead", () => {
  const plain = ctxFor({});

  const draft = docFor("/site/content/posts/d.md", { draft: true, date: new Date(PAST_ISO) });
  onDocument(draft, plain);
  assert.deepEqual(draft.data.injectHead, ["publish-meta.html"]);

  // Raw draft regardless of flags: --drafts still carries noindex.
  const shown = docFor("/site/content/posts/d2.md", { draft: true });
  onDocument(shown, ctxFor({ drafts: true }));
  assert.deepEqual(shown.data.injectHead, ["publish-meta.html"]);

  // Future-only and plain documents are not drafts: no partial appended.
  const future = docFor("/site/content/posts/f.md", { date: new Date(Date.now() + 1000) });
  onDocument(future, plain);
  assert.equal("injectHead" in future.data, false);
  const visible = docFor("/site/content/posts/v.md", { date: new Date(PAST_ISO) });
  onDocument(visible, plain);
  assert.equal("injectHead" in visible.data, false);

  // Existing head entries are preserved; the partial joins once.
  const pre = docFor("/site/content/posts/d3.md", {
    draft: true,
    injectHead: ["a.html"],
  });
  onDocument(pre, plain);
  assert.deepEqual(pre.data.injectHead, ["a.html", "publish-meta.html"]);
  onDocument(pre, plain); // no duplicate on re-processing
  assert.deepEqual(pre.data.injectHead, ["a.html", "publish-meta.html"]);

  const already = docFor("/site/content/posts/d4.md", {
    draft: true,
    injectHead: ["publish-meta.html"],
  });
  onDocument(already, plain);
  assert.deepEqual(already.data.injectHead, ["publish-meta.html"]);
});

test("onDocument: non-boolean draft rejects naming the document path and draft", () => {
  const bad = docFor("/site/content/posts/bad.md", { draft: "yes" });
  assert.throws(
    () => onDocument(bad, ctxFor({})),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /\/site\/content\/posts\/bad\.md/);
      assert.match(error.message, /"draft" must be a boolean \(got string\)/);
      return true;
    },
  );

  // Boolean false is a valid, published, non-draft document.
  const fine = docFor("/site/content/posts/f.md", { draft: false, date: new Date(PAST_ISO) });
  assert.equal(publishedOf(fine, ctxFor({})), true);
  assert.equal("injectHead" in fine.data, false);
});

test("onSite: removes published === false; keeps published and unflagged pages", () => {
  const site: Site = {
    data: {},
    pages: [
      pageFor("/", true),
      pageFor("/posts/visible/", true),
      pageFor(DRAFT_URL, false),
      pageFor("/appended/"),
      pageFor(FUTURE_URL, false),
    ],
  };
  onSite(site, ctxFor({}));
  assert.deepEqual(
    site.pages.map((page) => page.url),
    ["/", "/posts/visible/", "/appended/"],
  );
});

// ---------------------------------------------------------------------------
// Pipeline: acceptance criteria through real builds.
// ---------------------------------------------------------------------------

test("plain build: draft and future URLs absent from dist and from both home lists", async () => {
  await withProject(await fixtureFiles(), async (root) => {
    const { value: report } = await capture(() => build({ flags: PLAIN_FLAGS }));
    assert.deepEqual(report.featureErrors, []);

    assert.equal(await exists(path.join(root, "dist", "posts", "visible")), true);
    assert.equal(await exists(path.join(root, "dist", "posts", "draft")), false);
    assert.equal(await exists(path.join(root, "dist", "posts", "future")), false);

    const home = await readFile(path.join(root, "dist", "index.html"), "utf8");
    assert.ok(home.includes('href="/posts/visible/"'), "visible post listed");
    assert.doesNotMatch(home, /href="\/posts\/draft\/"/);
    assert.doesNotMatch(home, /href="\/posts\/future\/"/);

    // Related data (T022 renders it on the visible post): no hidden URL.
    const visiblePage = await readFile(
      path.join(root, "dist", "posts", "visible", "index.html"),
      "utf8",
    );
    assert.ok(visiblePage.includes('<ul id="related">'), "related list rendered");
    assert.doesNotMatch(visiblePage, /\/posts\/draft\//);
    assert.doesNotMatch(visiblePage, /\/posts\/future\//);
  });
});

test("kiln build --drafts: draft page exists with noindex meta and appears in collections", async () => {
  await withProject(await fixtureFiles(), async (root) => {
    const { value: report } = await capture(() =>
      build({ flags: { drafts: true, future: false, noCache: true } }),
    );
    assert.deepEqual(report.featureErrors, []);

    const draftPage = await readFile(
      path.join(root, "dist", "posts", "draft", "index.html"),
      "utf8",
    );
    assert.ok(draftPage.includes(NOINDEX), "draft carries the noindex meta");
    assert.ok(draftPage.includes("Draft body."));

    // Future posts stay hidden without --future even when --drafts is on.
    assert.equal(await exists(path.join(root, "dist", "posts", "future")), false);

    const home = await readFile(path.join(root, "dist", "index.html"), "utf8");
    assert.ok(home.includes('href="/posts/draft/"'), "draft listed at home");
    assert.doesNotMatch(home, /href="\/posts\/future\/"/);
  });
});

test("kiln build --future: tomorrow-dated post emitted, draft still excluded", async () => {
  await withProject(await fixtureFiles(), async (root) => {
    const { value: report } = await capture(() =>
      build({ flags: { drafts: false, future: true, noCache: true } }),
    );
    assert.deepEqual(report.featureErrors, []);

    assert.equal(await exists(path.join(root, "dist", "posts", "future")), true);
    assert.equal(await exists(path.join(root, "dist", "posts", "draft")), false);

    const home = await readFile(path.join(root, "dist", "index.html"), "utf8");
    assert.ok(home.includes('href="/posts/future/"'), "future post listed");
    assert.doesNotMatch(home, /href="\/posts\/draft\/"/);
  });
});

test("kiln build --drafts --future: both classes included", async () => {
  await withProject(await fixtureFiles(), async (root) => {
    const { value: report } = await capture(() =>
      build({ flags: { drafts: true, future: true, noCache: true } }),
    );
    assert.deepEqual(report.featureErrors, []);

    const draftPage = await readFile(
      path.join(root, "dist", "posts", "draft", "index.html"),
      "utf8",
    );
    assert.ok(draftPage.includes(NOINDEX));
    assert.equal(await exists(path.join(root, "dist", "posts", "future")), true);

    const home = await readFile(path.join(root, "dist", "index.html"), "utf8");
    assert.ok(home.includes('href="/posts/draft/"'));
    assert.ok(home.includes('href="/posts/future/"'));
  });
});

// ---------------------------------------------------------------------------
// Ordering guarantee probes (T013 requirements 1–4) + sibling-output scan.
// ---------------------------------------------------------------------------

/** Sorts before `publish.ts` and every lowercase feature name. */
const PROBE_BEFORE = [
  'import { writeFile } from "node:fs/promises";',
  'import path from "node:path";',
  'import type { Feature } from "../feature.ts";',
  "",
  "const rendered: { url: string; published: unknown }[] = [];",
  "let flaggedAll = false;",
  "let hiddenSeen = -1;",
  "let onSiteUrls: string[] = [];",
  "",
  "const feature: Feature = {",
  "  extendMarkdown(md) {",
  '    md.core.ruler.push("__t013_before", (state) => {',
  "      const env = (state as unknown as {",
  "        env?: { doc?: { url?: string; data?: Record<string, unknown> } };",
  "      }).env;",
  "      rendered.push({",
  '        url: String(env?.doc?.url ?? ""),',
  "        published: env?.doc?.data?.published,",
  "      });",
  "    });",
  "  },",
  "  onSite(site) {",
  "    flaggedAll = site.pages.every(",
  "      (page) => typeof page.data.published === \"boolean\",",
  "    );",
  "    hiddenSeen = site.pages.filter(",
  "      (page) => page.data.published === false,",
  "    ).length;",
  "    onSiteUrls = site.pages.map((page) => page.url);",
  "  },",
  "  onBuildEnd(result) {",
  "    const payload = {",
  "      rendered: [...rendered],",
  "      flaggedAll,",
  "      hiddenSeen,",
  "      onSiteUrls,",
  "      buildEndUrls: result.site.pages.map((page) => page.url),",
  "    };",
  "    rendered.length = 0;",
  "    return writeFile(",
  '      path.join(result.distDir, "__t013_before.json"),',
  "      JSON.stringify(payload),",
  "    );",
  "  },",
  "};",
  "",
  "export default feature;",
  "",
].join("\n");

/** Sorts after `publish.ts` and every current feature name. */
const PROBE_AFTER = [
  'import { writeFile } from "node:fs/promises";',
  'import path from "node:path";',
  'import type { Feature } from "../feature.ts";',
  "",
  "let onSiteUrls: string[] = [];",
  "",
  "const feature: Feature = {",
  "  onSite(site) {",
  "    onSiteUrls = site.pages.map((page) => page.url);",
  "  },",
  "  onBuildEnd(result) {",
  "    return writeFile(",
  '      path.join(result.distDir, "zz_t013_after.json"),',
  "      JSON.stringify({",
  "        onSiteUrls,",
  "        buildEndUrls: result.site.pages.map((page) => page.url),",
  "      }),",
  "    );",
  "  },",
  "};",
  "",
  "export default feature;",
  "",
].join("\n");

test("ordering guarantee: published before render, filtered before every onBuildEnd", async () => {
  await withProject(await fixtureFiles(), async (root) => {
    await withFeatures(
      { "__t013_before.ts": PROBE_BEFORE, "zz_t013_after.ts": PROBE_AFTER },
      async () => {
        const { value: report } = await capture(() =>
          build({ flags: PLAIN_FLAGS }),
        );
        assert.deepEqual(report.featureErrors, []);

        interface Before {
          rendered: { url: string; published: unknown }[];
          flaggedAll: boolean;
          hiddenSeen: number;
          onSiteUrls: string[];
          buildEndUrls: string[];
        }
        interface After {
          onSiteUrls: string[];
          buildEndUrls: string[];
        }
        const before = JSON.parse(
          await readFile(path.join(root, "dist", "__t013_before.json"), "utf8"),
        ) as Before;
        const after = JSON.parse(
          await readFile(path.join(root, "dist", "zz_t013_after.json"), "utf8"),
        ) as After;

        // 1. Every rendered page already carried `published === true`, and no
        //    hidden URL ever reached the renderer.
        const rendered = before.rendered;
        assert.ok(rendered.length > 0, "pages rendered");
        const visibleEntry = rendered.find((entry) => entry.url === "/posts/visible/");
        assert.ok(visibleEntry, "visible post rendered");
        assert.equal(visibleEntry.published, true, "flag exists before render");
        assert.ok(!rendered.some((entry) => entry.url === DRAFT_URL));
        assert.ok(!rendered.some((entry) => entry.url === FUTURE_URL));

        // 3. The pre-publish onSite sees every document flagged, hidden ones
        //    present but published === false (consumers must skip them).
        assert.equal(before.flaggedAll, true, "published resolved for every doc");
        assert.equal(before.hiddenSeen, 2, "draft + future flagged false pre-filter");
        assert.ok(before.onSiteUrls.includes(DRAFT_URL));
        assert.ok(before.onSiteUrls.includes(FUTURE_URL));

        // 2. Its onBuildEnd — the first build-end hook of this build — already
        //    sees only published URLs: every onSite completed first.
        assert.ok(!before.buildEndUrls.includes(DRAFT_URL));
        assert.ok(!before.buildEndUrls.includes(FUTURE_URL));
        assert.ok(before.buildEndUrls.includes("/posts/visible/"));

        // 4. The post-publish onSite sees hidden documents already removed.
        assert.ok(!after.onSiteUrls.includes(DRAFT_URL));
        assert.ok(!after.onSiteUrls.includes(FUTURE_URL));
        assert.ok(after.onSiteUrls.includes("/posts/visible/"));
        assert.ok(!after.buildEndUrls.includes(DRAFT_URL));
        assert.ok(!after.buildEndUrls.includes(FUTURE_URL));

        // Acceptance: sibling outputs (feed, sitemap, search index) contain
        // neither hidden URL. Every hook succeeded above, so a feature in
        // the tree necessarily wrote its file — assert it, don't skip it.
        const siblings: [feature: string, output: string][] = [
          ["src/features/feed.ts", "feed.xml"],
          ["src/features/sitemap.ts", "sitemap.xml"],
          ["src/features/search.ts", "search-index.json"],
        ];
        for (const [feature, output] of siblings) {
          if (!(await exists(path.join(REPO, feature)))) continue;
          const text = await readFile(path.join(root, "dist", output), "utf8");
          assert.ok(
            !text.includes(DRAFT_URL),
            `${output} must not leak the draft URL`,
          );
          assert.ok(
            !text.includes(FUTURE_URL),
            `${output} must not leak the future URL`,
          );
        }
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Acceptance: invalid draft fails the build, exit 1.
// ---------------------------------------------------------------------------

test('draft: "yes" fails the build naming path and field, exit code 1', async () => {
  const files = {
    "content/index.md": "---\ntitle: Home\n---\nHome.",
    "content/posts/bad.md": '---\ntitle: Bad\ndraft: "yes"\n---\nBad body.',
  };
  await withProject(files, async (root) => {
    const { stdout, stderr, exitCode } = await runCommand([]);
    assert.equal(exitCode, 1, "command exit code");
    assert.equal(stderr, "");
    assert.match(stdout, /feature errors: 1/);
    assert.match(stdout, /src\/features\/publish\.ts \(onDocument\)/);
    const badPath = path.join(root, "content", "posts", "bad.md");
    assert.ok(
      stdout.includes(`${badPath}: "draft" must be a boolean (got string)`),
      `report names the path and field: ${stdout}`,
    );
    // The build stopped before emit: nothing from this build was written.
    assert.equal(await exists(path.join(root, "dist", "posts", "bad")), false);
  });
});
