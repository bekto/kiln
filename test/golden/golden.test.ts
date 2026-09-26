/**
 * T033 — golden-site snapshot tests.
 *
 * `test/golden/site/` is a committed fixture exercising Wave 3 end to end
 * (highlight, taxonomy + pagination, drafts, future posts, unicode paths,
 * search index, feed, sitemap). The suite copies it into a fresh temp
 * directory and spawns `node src/cli.ts build` there (one shared build for
 * the snapshot + semantic tests, a second for the determinism check), so
 * the committed fixture tree is never mutated and no `dist/` ever appears
 * under `test/golden/site/`.
 *
 * The produced `dist/` tree is compared against `test/golden/expected/`
 * (committed files, byte-wise, no snapshot library):
 *
 * - Tree: sorted relative paths (default string sort — UTF-16 code-unit
 *   order) must match; mismatches fail with the ticket's `golden mismatch`
 *   block listing every `+`/`-`/`~` path.
 * - Contents: every expected file byte-compared against its produced
 *   counterpart.
 * - `dist/assets/*.js` is never stored under `expected/` — `node --test`
 *   executes `.js` files under `test/` — so those files are byte-compared
 *   against their source in the repo (`dist/assets/search.js` ←
 *   `assets/search.js`, T023's copy contract).
 * - `dist/.kiln-cache.json` (T029) is excluded from the tree: its global
 *   hash embeds the absolute temp project paths (config minus
 *   root/port/watch still carries absolute contentDir/outDir), so its bytes
 *   differ per temp copy. The build cache is W4 and an explicit T033
 *   non-goal; every other produced byte is snapshotted.
 *
 * Refresh is explicit only: `UPDATE_GOLDEN=1 npm test --
 * test/golden/golden.test.ts` rewrites `expected/` from a fresh temp build
 * (stale files deleted). Failures never refresh.
 *
 * Semantic assertions beyond the snapshot: feed well-formedness/links,
 * sitemap resolution against the tree, zero draft/future leakage anywhere
 * in `dist/`, the unicode post path, highlighted code spans, pagination
 * overflow pages, and two-build determinism.
 */
import assert from "node:assert/strict";
import { execFile, type ExecFileException } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** Promise form of `execFile`; non-zero exits reject with the capture. */
const execFileAsync = promisify(execFile);

const GOLDEN_DIR = path.dirname(fileURLToPath(import.meta.url)); // test/golden
const REPO = path.dirname(path.dirname(GOLDEN_DIR));
const SITE_DIR = path.join(GOLDEN_DIR, "site");
const EXPECTED_DIR = path.join(GOLDEN_DIR, "expected");
const CLI = path.join(REPO, "src", "cli.ts");
const ASSETS_DIR = path.join(REPO, "assets");

/** The fixture's absolute site URL — every feed/sitemap link resolves on it. */
const SITE_URL = "https://golden.example.com";
/** Slugs that must never surface anywhere in `dist/`. */
const HIDDEN_SLUGS = ["drafted", "future"];
/** T029's runtime cache file — the one dist file excluded from snapshots. */
const CACHE_FILE = ".kiln-cache.json";
/** Fixture files `node --test` would execute (only `kiln.config.ts` + this runner). */
const RUNNABLE = /\.(?:js|mjs|cjs)$/;

const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === "1";

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/**
 * Every file under `root` as POSIX-relative paths, sorted with the default
 * string sort (UTF-16 code-unit order — deterministic across runs).
 */
async function walk(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (rel: string): Promise<void> => {
    const entries = await readdir(path.join(root, rel), { withFileTypes: true });
    for (const entry of entries) {
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  await visit("");
  return files.sort();
}

/** The produced snapshot-eligible files: all of `dist/` minus the cache file. */
async function distFiles(dist: string): Promise<string[]> {
  return (await walk(dist)).filter((rel) => rel !== CACHE_FILE);
}

/**
 * Repo asset sources that dist must carry byte-for-byte: `assets/*.js` →
 * `assets/<name>` (T023's copy contract). These files live in the repo, so
 * they are compared against their source instead of a committed expected
 * copy — storing them under `test/golden/` would make `node --test` run
 * them.
 */
async function assetSources(): Promise<string[]> {
  const files = await walk(ASSETS_DIR);
  return files
    .filter((rel) => rel.endsWith(".js"))
    .map((rel) => `assets/${rel}`)
    .sort();
}

// ---------------------------------------------------------------------------
// Build harness
// ---------------------------------------------------------------------------

interface GoldenBuild {
  /** Temp dir holding the copied fixture project (removed at suite end). */
  root: string;
  /** The build output: `<root>/project/dist`. */
  dist: string;
}

const tempRoots: string[] = [];

after(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

/**
 * Run `node src/cli.ts build` with cwd = the temp project copy. Resolves on
 * exit 0; any non-zero exit fails immediately with the CLI's captured
 * stderr/stdout so no snapshot diff can ever mask a failed build.
 */
async function runBuild(cwd: string): Promise<void> {
  try {
    await execFileAsync(process.execPath, [CLI, "build"], { cwd });
  } catch (error) {
    const failure = error as ExecFileException & {
      stdout?: string;
      stderr?: string;
    };
    assert.fail(
      `golden build failed (exit ${failure.code ?? "null"})\n` +
        `--- stderr ---\n${failure.stderr ?? ""}` +
        `--- stdout ---\n${failure.stdout ?? ""}`,
    );
  }
}

/** Copy the committed fixture into a temp dir and build it once. */
async function buildSite(): Promise<GoldenBuild> {
  const root = await mkdtemp(path.join(tmpdir(), "kiln-golden-"));
  tempRoots.push(root);
  const project = path.join(root, "project");
  await cp(SITE_DIR, project, { recursive: true });

  await runBuild(project);
  // The committed fixture tree must stay pristine — builds happen in temp.
  await access(path.join(SITE_DIR, "dist")).then(
    () => assert.fail("build wrote dist/ into the committed fixture tree"),
    () => undefined,
  );
  return { root, dist: path.join(project, "dist") };
}

/** One shared build for the snapshot + semantic tests (read-only for all). */
let sharedBuild: Promise<GoldenBuild> | undefined;
function getBuild(): Promise<GoldenBuild> {
  sharedBuild ??= buildSite();
  return sharedBuild;
}

// ---------------------------------------------------------------------------
// Mismatch reporting
// ---------------------------------------------------------------------------

interface Mismatch {
  sign: "+" | "-" | "~";
  rel: string;
}

/** The ticket's structural block body: one aligned row per mismatch. */
function formatRows(
  mismatches: Mismatch[],
  reasons: Record<Mismatch["sign"], string>,
): string {
  const order: Record<Mismatch["sign"], number> = { "+": 0, "-": 1, "~": 2 };
  const sorted = [...mismatches].sort(
    (a, b) =>
      order[a.sign] - order[b.sign] ||
      (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0),
  );
  const width = Math.max(...sorted.map((m) => m.rel.length));
  return sorted
    .map((m) => `  ${m.sign} ${m.rel.padEnd(width)}  (${reasons[m.sign]})`)
    .join("\n");
}

/** The full `golden mismatch` failure message, refresh hint included. */
function snapshotBlock(mismatches: Mismatch[]): string {
  const rows = formatRows(mismatches, {
    "+": "in dist, not in expected",
    "-": "in expected, not in dist",
    "~": "content differs",
  });
  return (
    `golden mismatch:\n${rows}\n` +
    `run UPDATE_GOLDEN=1 npm test -- test/golden/golden.test.ts to refresh`
  );
}

// ---------------------------------------------------------------------------
// XML + URL helpers (no dependencies)
// ---------------------------------------------------------------------------

interface XmlScan {
  /** Name of the root element. */
  root: string;
}

/**
 * Minimal tag-balance scanner: throws on the first structural problem
 * (unterminated tag/comment, mismatched close, unclosed element at EOF,
 * content outside the root), otherwise names the root element. Attribute
 * values are safe to slice at `>` because the renderer escapes `<`/`>` in
 * attributes (autoescape; sitemap escapes explicitly).
 */
function scanXml(xml: string): XmlScan {
  const stack: string[] = [];
  let root = "";
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) break;
    i = lt + 1;
    if (xml[i] === "?") {
      const end = xml.indexOf("?>", i);
      if (end === -1) throw new Error("unterminated processing instruction");
      i = end + 2;
      continue;
    }
    if (xml[i] === "!") {
      if (xml.startsWith("!--", i)) {
        const end = xml.indexOf("-->", i + 3);
        if (end === -1) throw new Error("unterminated comment");
        i = end + 3;
        continue;
      }
      const end = xml.indexOf(">", i);
      if (end === -1) throw new Error("unterminated declaration");
      i = end + 1;
      continue;
    }
    const gt = xml.indexOf(">", i);
    if (gt === -1) throw new Error("unterminated tag");
    const body = xml.slice(i, gt);
    i = gt + 1;
    if (body.startsWith("/")) {
      const name = body.slice(1).trim();
      const open = stack.pop();
      if (open !== name) {
        throw new Error(`</${name}> closes <${open ?? "nothing"}>`);
      }
      continue;
    }
    const selfClosing = body.endsWith("/");
    const raw = (selfClosing ? body.slice(0, -1) : body).trim();
    const name = raw.split(/\s/, 1)[0];
    if (!/^[A-Za-z_][\w:.-]*$/.test(name)) {
      throw new Error(`malformed tag <${body}>`);
    }
    if (stack.length === 0 && root !== "") {
      throw new Error(`<${name}> appears outside root <${root}>`);
    }
    if (stack.length === 0 && root === "") root = name;
    if (!selfClosing) stack.push(name);
  }
  if (stack.length > 0) throw new Error(`unclosed element <${stack.at(-1)} >`);
  if (root === "") throw new Error("no root element");
  return { root };
}

/** `href`/`<loc>` → the dist-relative file it must resolve to. */
function distRelForUrl(href: string): string {
  const url = new URL(href);
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  return rel === "" || rel.endsWith("/") ? `${rel}index.html` : rel;
}

/**
 * Assert `href` (an absolute site URL) resolves to a file inside `dist/`.
 * The walk checks each path segment against its parent's exact directory
 * listing, so resolution is case-sensitive even on a case-insensitive host.
 */
async function assertResolvesToDistFile(
  dist: string,
  href: string,
  label: string,
): Promise<void> {
  const url = new URL(href);
  assert.equal(url.origin, new URL(SITE_URL).origin, `${label}: bad origin`);
  const rel = distRelForUrl(href);
  let parent = dist;
  for (const segment of rel.split("/")) {
    const names = await readdir(parent);
    if (!names.includes(segment)) {
      assert.fail(
        `${label}: ${href} does not resolve — dist/${rel} missing ` +
          `(case-sensitive walk stopped at "${segment}")`,
      );
    }
    parent = path.join(parent, segment);
  }
  const bytes = await readFile(parent);
  assert.ok(bytes.length > 0, `${label}: dist/${rel} is empty`);
}

/** No hidden slug (`drafted`, `future`) may appear in `text`. */
function assertNoHiddenSlugs(what: string, text: string): void {
  for (const slug of HIDDEN_SLUGS) {
    assert.ok(
      !text.includes(slug),
      `${what}: hidden slug "${slug}" leaked into dist`,
    );
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("fixture tree: no runnable files, kiln.config.ts is the only extra .ts", async () => {
  const files = await walk(GOLDEN_DIR);
  const runnable = files.filter((rel) => RUNNABLE.test(rel));
  assert.deepEqual(
    runnable,
    [],
    "node --test would execute these under test/golden/",
  );
  const sources = files.filter((rel) => rel.endsWith(".ts"));
  assert.deepEqual(
    sources,
    ["golden.test.ts", "site/kiln.config.ts"],
    "unexpected .ts file under test/golden/",
  );
});

/**
 * The snapshot gate: tree equality (sorted relative paths, UTF-16
 * code-unit order) plus byte-comparison of every produced file against its
 * expected copy — or, for `assets/*.js`, against the repo source it was
 * copied from (T023's copy contract; those files live outside
 * `test/golden/` because `node --test` executes runnable files there).
 */
async function compareSnapshot(
  dist: string,
  sourceList: string[],
): Promise<void> {
  const expectedList = await walk(EXPECTED_DIR);
  // expected/ must never hold runnable files (node --test executes them).
  const runnable = expectedList.filter((rel) => RUNNABLE.test(rel));
  assert.deepEqual(runnable, [], "expected/ must not contain runnable files");

  const distList = await distFiles(dist);
  const sources = new Set(sourceList);
  const wanted = new Set([...expectedList, ...sourceList]);
  const mismatches: Mismatch[] = [];
  for (const rel of distList) {
    if (!wanted.has(rel)) mismatches.push({ sign: "+", rel });
  }
  for (const rel of wanted) {
    if (!distList.includes(rel)) mismatches.push({ sign: "-", rel });
  }
  for (const rel of distList) {
    if (!wanted.has(rel)) continue;
    const producedBytes = await readFile(path.join(dist, rel));
    const sourcePath = sources.has(rel)
      ? path.join(ASSETS_DIR, rel.slice("assets/".length))
      : path.join(EXPECTED_DIR, rel);
    const expectedBytes = await readFile(sourcePath);
    if (Buffer.compare(producedBytes, expectedBytes) !== 0) {
      mismatches.push({ sign: "~", rel });
    }
  }
  if (mismatches.length > 0) assert.fail(snapshotBlock(mismatches));
}

test("snapshot: produced dist matches the committed expected tree", async (t) => {
  const { dist } = await getBuild();
  const sourceList = await assetSources();

  if (UPDATE_GOLDEN) {
    // Explicit refresh only: rewrite expected/ from this fresh temp build,
    // stale files deleted, never storing files `node --test` would execute
    // (runnable files and the repo-sourced assets are compared, not stored).
    await rm(EXPECTED_DIR, { recursive: true, force: true });
    const sources = new Set(sourceList);
    let count = 0;
    for (const rel of await distFiles(dist)) {
      if (sources.has(rel) || RUNNABLE.test(rel)) continue;
      const target = path.join(EXPECTED_DIR, rel);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await readFile(path.join(dist, rel)));
      count += 1;
    }
    t.diagnostic(`UPDATE_GOLDEN: wrote ${count} expected files`);
  }

  // Trivially green right after a refresh; the real gate on plain runs.
  await compareSnapshot(dist, sourceList);
});

test("feed: well-formed <feed>, 5 entries, links resolve, no hidden slugs", async () => {
  const { dist } = await getBuild();
  const xml = await readFile(path.join(dist, "feed.xml"), "utf8");
  let scan: XmlScan;
  try {
    scan = scanXml(xml);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    assert.fail(`feed.xml is not well-formed: ${reason}`);
  }
  assert.equal(scan.root, "feed", "feed.xml root element must be <feed>");
  assert.ok(
    xml.includes('xmlns="http://www.w3.org/2005/Atom"'),
    "feed.xml must declare the Atom namespace",
  );
  assertNoHiddenSlugs("feed.xml", xml);

  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  assert.equal(entries.length, 5, "feed must carry exactly 5 <entry>");
  for (const entry of entries) {
    const link = /<link rel="alternate" href="([^"]+)"\s*\/>/.exec(entry);
    assert.ok(link, "feed entry has no alternate link");
    await assertResolvesToDistFile(dist, link[1], "feed entry link");
  }
});

test("sitemap: every <loc> resolves case-sensitively and matches the tree", async () => {
  const { dist } = await getBuild();
  const xml = await readFile(path.join(dist, "sitemap.xml"), "utf8");
  let scan: XmlScan;
  try {
    scan = scanXml(xml);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    assert.fail(`sitemap.xml is not well-formed: ${reason}`);
  }
  assert.equal(scan.root, "urlset", "sitemap.xml root element must be <urlset>");
  assertNoHiddenSlugs("sitemap.xml", xml);

  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(locs.length > 0, "sitemap must carry at least one <loc>");
  const resolved = new Set<string>();
  for (const loc of locs) {
    await assertResolvesToDistFile(dist, loc, "sitemap <loc>");
    resolved.add(distRelForUrl(loc));
  }
  // The exact URL set is the tree: every emitted .html, nothing else.
  const htmlFiles = (await walk(dist)).filter((rel) => rel.endsWith(".html"));
  assert.deepEqual(
    [...resolved].sort(),
    htmlFiles.sort(),
    "sitemap URLs must match the dist HTML tree",
  );
});

test("no draft or future leakage anywhere in dist", async () => {
  const { dist } = await getBuild();
  const files = await walk(dist);
  const hits: string[] = [];
  for (const rel of files) {
    for (const slug of HIDDEN_SLUGS) {
      if (rel.includes(slug)) hits.push(`${rel}: path contains "${slug}"`);
    }
    const bytes = await readFile(path.join(dist, rel));
    for (const slug of HIDDEN_SLUGS) {
      if (bytes.includes(slug)) hits.push(`${rel}: contains "${slug}"`);
    }
  }
  assert.deepEqual(
    hits,
    [],
    `hidden slugs leaked into dist:\n${hits.join("\n")}`,
  );
});

test("unicode post emitted at dist/posts/hello-世界/index.html", async () => {
  const { dist } = await getBuild();
  const rel = path.join("posts", "hello-世界", "index.html");
  let html: string;
  try {
    html = await readFile(path.join(dist, rel), "utf8");
  } catch {
    assert.fail(`unicode post page missing: dist/${rel}`);
  }
  assert.ok(html.includes("你好，世界！ 🎉"), "unicode title not rendered");
});

test("first post renders highlighted token spans (T016)", async () => {
  const { dist } = await getBuild();
  const html = await readFile(
    path.join(dist, "posts", "first", "index.html"),
    "utf8",
  );
  assert.match(
    html,
    /<span class="hljs-[a-z0-9_-]+">/,
    "no hljs token span in the first post's HTML",
  );
});

test("pagination emits a list page beyond /index.html", async () => {
  const { dist } = await getBuild();
  const rel = path.join("page", "2", "index.html");
  let bytes: Buffer;
  try {
    bytes = await readFile(path.join(dist, rel));
  } catch {
    assert.fail(`pagination overflow missing: dist/${rel}`);
  }
  assert.ok(bytes.length > 0, `dist/${rel} is empty`);
});

test("determinism: a second build yields a byte-identical tree", async () => {
  const first = await getBuild();
  const second = await buildSite();
  const firstList = await distFiles(first.dist);
  const secondList = await distFiles(second.dist);
  const inFirst = new Set(firstList);
  const inSecond = new Set(secondList);

  const mismatches: Mismatch[] = [];
  for (const rel of secondList) {
    if (!inFirst.has(rel)) mismatches.push({ sign: "+", rel });
  }
  for (const rel of firstList) {
    if (!inSecond.has(rel)) mismatches.push({ sign: "-", rel });
  }
  for (const rel of firstList) {
    if (!inSecond.has(rel)) continue;
    const a = await readFile(path.join(first.dist, rel));
    const b = await readFile(path.join(second.dist, rel));
    if (Buffer.compare(a, b) !== 0) mismatches.push({ sign: "~", rel });
  }
  if (mismatches.length > 0) {
    assert.fail(
      `golden determinism mismatch (second build differs):\n` +
        formatRows(mismatches, {
          "+": "only in the first build",
          "-": "only in the second build",
          "~": "bytes differ between builds",
        }),
    );
  }
});
