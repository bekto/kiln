/**
 * T023 acceptance — client-side search.
 *
 * Covers the index shape (exactly title/url/excerpt/tags, plain text),
 * `features.search.indexPath` (default, custom, invalid), the byte-exact
 * script copy, the opt-in partial's rendered markup — and, by running
 * assets/search.js itself inside a `node:vm` realm with a minimal DOM,
 * the matcher's ranking, two-token gating, lazy fetch/cache, and every
 * no-results state.
 *
 * Deliberately no full `build()`: `discoverFeatures` loads every file in
 * `src/features/`, and the rest of this batch is landing concurrently;
 * the wave gate runs the whole suite once all tickets have landed.
 * `makeContext` is likewise not exported (same sibling exposure), so
 * `contextFor` mirrors its documented `features.search: <reason>` wrap.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import type { Page, Site } from "../src/content/document.ts";
import type { BuildEnd, FeatureContext } from "../src/feature.ts";
import search from "../src/features/search.ts";
import { loadTemplates } from "../src/render/templates.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(TEST_DIR);
const SCRIPT_FILE = path.join(REPO, "assets", "search.js");
const SCRIPT_SOURCE = await readFile(SCRIPT_FILE, "utf8");

/**
 * A `FeatureContext` shaped like `makeContext` in src/pipeline/features.ts:
 * validator failures rethrow prefixed `features.search: ` (test seam for
 * the contract the real context applies in build).
 */
function contextFor(raw: unknown): FeatureContext {
  return {
    name: "search",
    flags: { drafts: false, future: false, noCache: false },
    options<T>(validate: (value: unknown) => T): T {
      try {
        return validate(raw);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`features.search: ${reason}`, { cause: error });
      }
    },
  };
}

/** One discovered page at a pretty URL (fixture factory). */
function makePage(url: string, data: Record<string, unknown>): Page {
  return { path: `/content${url}index.md`, url, data, content: "" };
}

/** Run `fn` in a fresh temp cwd (onSite writes relative to dist/), then restore. */
async function inTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "kiln-search-"));
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await fn(dir);
  } finally {
    process.chdir(previous);
    await rm(dir, { recursive: true, force: true });
  }
}

test("onSite: dist/search-index.json holds exactly title/url/excerpt/tags as plain text", async () => {
  await inTempDir(async () => {
    const site: Site = {
      data: {},
      pages: [
        makePage("/posts/bold/", {
          title: "The <b>Bold</b>   Post",
          excerpt: "<p>Hello <em>world</em></p>",
          tags: ["News", " go "],
        }),
        makePage("/about/", { title: "About" }),
      ],
    };
    assert.ok(search.onSite);
    await search.onSite(site, contextFor(undefined));

    const entries = JSON.parse(
      await readFile("dist/search-index.json", "utf8"),
    ) as Record<string, unknown>[];
    assert.ok(Array.isArray(entries));
    assert.equal(entries.length, 2);
    assert.deepEqual(Object.keys(entries[0]!), ["title", "url", "excerpt", "tags"]);
    assert.deepEqual(entries[0], {
      title: "The Bold Post",
      url: "/posts/bold/",
      excerpt: "Hello world",
      tags: ["News", "go"],
    });
    assert.deepEqual(entries[1], { title: "About", url: "/about/", excerpt: "", tags: [] });
    for (const entry of entries) {
      assert.doesNotMatch(String(entry.title), /<[a-zA-Z]/);
      assert.doesNotMatch(String(entry.excerpt), /<[a-zA-Z]/);
    }
    assert.equal(site.data.searchIndexPath, "/search-index.json");
  });
});

test("indexPath data/search.json: file at dist/data/search.json, URL published on site data", async () => {
  await inTempDir(async () => {
    const ctx = contextFor({ indexPath: "data/search.json" });
    const site: Site = { data: {}, pages: [makePage("/", { title: "Home" })] };
    assert.ok(search.onSite);
    await search.onSite(site, ctx);

    const entries = JSON.parse(
      await readFile(path.join("dist", "data", "search.json"), "utf8"),
    ) as unknown[];
    assert.equal(entries.length, 1);
    assert.equal(site.data.searchIndexPath, "/data/search.json");
  });
});

test("invalid features.search.indexPath (42, '', ../x, absolute) rejects naming the key", async () => {
  await inTempDir(async () => {
    assert.ok(search.onSite);
    const onSite = search.onSite;
    for (const bad of [42, "", "  ", "../x", "/abs/x.json"]) {
      const site: Site = { data: {}, pages: [] };
      await assert.rejects(
        async () => onSite(site, contextFor({ indexPath: bad })),
        /features\.search\.indexPath/,
      );
      assert.equal(site.data.searchIndexPath, undefined); // rejected before any effect
    }
  });
});

test("empty site: dist/search-index.json contains []", async () => {
  await inTempDir(async () => {
    const site: Site = { data: {}, pages: [] };
    assert.ok(search.onSite);
    await search.onSite(site, contextFor(undefined));
    const parsed: unknown = JSON.parse(await readFile("dist/search-index.json", "utf8"));
    assert.deepEqual(parsed, []);
    assert.equal(site.data.searchIndexPath, "/search-index.json");
  });
});

test("onBuildEnd: assets/search.js copied byte-for-byte to dist/assets/search.js", async () => {
  await inTempDir(async (dir) => {
    const buildEnd: BuildEnd = {
      distDir: path.join(dir, "dist"),
      site: { data: {}, pages: [] },
      emitted: [],
      skipped: [],
    };
    assert.ok(search.onBuildEnd);
    await search.onBuildEnd(buildEnd, contextFor(undefined));

    const source = await readFile(SCRIPT_FILE);
    const copied = await readFile(path.join(dir, "dist", "assets", "search.js"));
    assert.equal(Buffer.compare(source, copied), 0);
  });
});

test("partial: data-index from site.searchIndexPath with default fallback, script hook present", async () => {
  const templates = await loadTemplates(path.join(REPO, "templates"));
  const custom = await templates.render("search.html", {
    site: { basePath: "", searchIndexPath: "/data/search.json" },
  });
  assert.match(custom, /data-index="\/data\/search\.json"/);

  const fallback = await templates.render("search.html", {
    site: { basePath: "" },
  });
  assert.match(fallback, /data-index="\/search-index\.json"/);

  for (const markup of [custom, fallback]) {
    assert.match(markup, /class="kiln-search"/);
    assert.match(markup, /class="kiln-search-input"/);
    assert.match(markup, /class="kiln-search-results"/);
    assert.match(markup, /class="kiln-search-empty"/);
    assert.match(markup, />No results</);
    assert.match(markup, /<script src="\/assets\/search\.js" defer><\/script>/);
  }

  // Subpath hosting: both the index URL and the script src carry the base
  // prefix (site.basePath, defaulted by renderDocument in real builds).
  const prefixed = await templates.render("search.html", {
    site: { basePath: "/sub", searchIndexPath: "/data/search.json" },
  });
  assert.match(prefixed, /data-index="\/sub\/data\/search\.json"/);
  assert.match(prefixed, /<script src="\/sub\/assets\/search\.js" defer><\/script>/);
});

test("script source: node --check passes and carries no import/require", () => {
  execFileSync(process.execPath, ["--check", SCRIPT_FILE], { stdio: "pipe" });
  assert.doesNotMatch(SCRIPT_SOURCE, /\b(?:import|require)\b/);
});

// --- browser script behavior, run from assets/search.js in a vm realm ---

/** Minimal DOM covering exactly what assets/search.js touches. */
class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attrs: Record<string, string> = {};
  readonly listeners: Record<string, Array<() => void>> = {};
  hidden = false;
  value = "";
  private text = "";

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    this.text = value;
    this.children.length = 0;
  }
  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  getAttribute(name: string): string | null {
    return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null;
  }
  addEventListener(type: string, listener: () => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  dispatch(type: string): void {
    for (const listener of this.listeners[type] ?? []) listener();
  }
  querySelector(selector: string): FakeElement | null {
    const wanted = selector.startsWith(".") ? selector.slice(1) : "";
    const queue = [...this.children];
    while (queue.length > 0) {
      const element = queue.shift()!;
      const classes = (element.attrs["class"] ?? "").split(/\s+/);
      if (wanted !== "" && classes.includes(wanted)) return element;
      queue.unshift(...element.children);
    }
    return null;
  }
}

interface BootOptions {
  index?: unknown[];
  fetchFails?: boolean; // fetch returns a rejected promise
  fetchThrows?: boolean; // fetch throws synchronously
  responseNotOk?: boolean; // fetch resolves with ok:false
  indexPath?: string | null; // data-index value; null → attribute absent
}

interface Boot {
  list: FakeElement;
  empty: FakeElement;
  fetchUrls: string[];
  type(value: string): void;
  resultTitles(): string[];
}

/** Build the partial's DOM shape, then evaluate the real search.js over it. */
function boot(options: BootOptions = {}): Boot {
  const root = new FakeElement();
  root.setAttribute("class", "kiln-search");
  if (options.indexPath !== null) {
    root.setAttribute("data-index", options.indexPath ?? "/search-index.json");
  }
  const input = new FakeElement();
  input.setAttribute("class", "kiln-search-input");
  const list = new FakeElement();
  list.setAttribute("class", "kiln-search-results");
  list.hidden = true;
  const empty = new FakeElement();
  empty.setAttribute("class", "kiln-search-empty");
  empty.textContent = "No results"; // the partial's empty-state text
  empty.hidden = true;
  root.appendChild(input);
  root.appendChild(list);
  root.appendChild(empty);

  const fetchUrls: string[] = [];
  const fetchImpl = (url: string): Promise<unknown> => {
    fetchUrls.push(url);
    if (options.fetchThrows === true) throw new Error("sync fetch failure");
    if (options.fetchFails === true) return Promise.reject(new Error("fetch failed"));
    if (options.responseNotOk === true) {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });
    }
    const payload = options.index ?? [];
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
  };
  vm.runInNewContext(
    SCRIPT_SOURCE,
    {
      document: {
        readyState: "complete",
        querySelectorAll: (selector: string) => (selector === ".kiln-search" ? [root] : []),
        createElement: () => new FakeElement(),
        addEventListener: () => {},
      },
      fetch: fetchImpl,
    },
    { filename: "search.js" },
  );

  return {
    list,
    empty,
    fetchUrls,
    type(value: string) {
      input.value = value;
      input.dispatch("input");
    },
    resultTitles() {
      return list.children.map((item) => item.children[0]!.textContent);
    },
  };
}

/** Drain the microtask queue so the lazy fetch chain has settled. */
async function settle(): Promise<void> {
  await delay(0);
}

test("script: ranking — title hit (3) above tag hit (2) above excerpt hit (1), case-insensitive", async () => {
  const harness = boot({
    index: [
      { title: "sunset ridge", url: "/p/one/", excerpt: "", tags: [] },
      { title: "other post", url: "/p/two/", excerpt: "", tags: ["Ridge"] },
      { title: "third post", url: "/p/three/", excerpt: "a wild ridge appears", tags: [] },
    ],
  });
  harness.type("RIDGE");
  await settle();
  assert.deepEqual(harness.resultTitles(), ["sunset ridge", "other post", "third post"]);
  assert.equal(harness.list.hidden, false);
  assert.equal(harness.empty.hidden, true);
  assert.deepEqual(harness.fetchUrls, ["/search-index.json"]);
});

test("script: two-token query matches only entries containing both tokens", async () => {
  const harness = boot({
    index: [
      { title: "Alpha zebra run", url: "/p/a/", excerpt: "", tags: [] },
      { title: "Zebra", url: "/p/b/", excerpt: "run fast", tags: [] },
      { title: "Run", url: "/p/c/", excerpt: "zebra time", tags: [] },
      { title: "Zebra only", url: "/p/d/", excerpt: "no second token", tags: [] },
    ],
  });
  harness.type("zebra run");
  await settle();
  assert.deepEqual(harness.resultTitles(), ["Alpha zebra run", "Run", "Zebra"]);
});

test("script: equal scores sort by title ascending", async () => {
  const harness = boot({
    index: [
      { title: "zulu post", url: "/p/z/", excerpt: "", tags: [] },
      { title: "alpha post", url: "/p/a/", excerpt: "", tags: [] },
    ],
  });
  harness.type("post");
  await settle();
  assert.deepEqual(harness.resultTitles(), ["alpha post", "zulu post"]);
});

test("script: index fetched lazily on the first query, then cached at the data-index URL", async () => {
  const harness = boot({ index: [], indexPath: "/data/search.json" });
  assert.equal(harness.fetchUrls.length, 0); // nothing fetched at load
  harness.type("anything");
  await settle();
  assert.deepEqual(harness.fetchUrls, ["/data/search.json"]);
  harness.type("another");
  await settle();
  assert.equal(harness.fetchUrls.length, 1);
});

test("script: missing data-index attribute falls back to /search-index.json", async () => {
  const harness = boot({
    index: [{ title: "hello world", url: "/h/", excerpt: "", tags: [] }],
    indexPath: null,
  });
  harness.type("hello");
  await settle();
  assert.deepEqual(harness.fetchUrls, ["/search-index.json"]);
  assert.deepEqual(harness.resultTitles(), ["hello world"]);
});

test("script: empty index → visible No results, no throw", async () => {
  const harness = boot({ index: [] });
  harness.type("anything");
  await settle();
  assert.equal(harness.empty.hidden, false);
  assert.match(harness.empty.textContent, /No results/);
  assert.equal(harness.list.hidden, true);
  assert.equal(harness.list.textContent, "");
});

test("script: zero matches → visible No results", async () => {
  const harness = boot({ index: [{ title: "hello", url: "/h/", excerpt: "", tags: [] }] });
  harness.type("qqqzzz");
  await settle();
  assert.equal(harness.empty.hidden, false);
  assert.equal(harness.list.textContent, "");
});

test("script: failed fetch (rejected, sync-throw, or HTTP error) → No results, no uncaught error", async () => {
  for (const failure of [{ fetchFails: true }, { fetchThrows: true }, { responseNotOk: true }]) {
    const harness = boot(failure);
    harness.type("query"); // an uncaught throw here fails the test
    await settle();
    assert.equal(harness.empty.hidden, false);
    assert.equal(harness.list.hidden, true);
  }
});

test("script: empty query clears the results", async () => {
  const harness = boot({ index: [{ title: "hello world", url: "/h/", excerpt: "", tags: [] }] });
  harness.type("hello");
  await settle();
  assert.deepEqual(harness.resultTitles(), ["hello world"]);
  harness.type("");
  await settle();
  assert.equal(harness.list.textContent, "");
  assert.equal(harness.list.hidden, true);
  assert.equal(harness.empty.hidden, true);
});
