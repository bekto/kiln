/**
 * T023 — client-side search: the index emitter and script shipper.
 *
 * Hook split, per the ticket:
 * - `onSite` runs after T013's visibility filter (`publish.ts` sorts
 *   first), builds one entry per published document, publishes the
 *   resolved index URL as `site.data.searchIndexPath` (the partial
 *   renders `data-index` from `site.searchIndexPath` through T012's
 *   siteContext — the only top-level channel a feature has), and writes
 *   the entries to `dist/<indexPath>`. `indexPath` is
 *   `features.search.indexPath` — a string, default `search-index.json`,
 *   resolved relative to `dist/` (never absolute, never `..`, or the
 *   build fails with an error naming `features.search.indexPath`, via
 *   `ctx.options`' `features.search: ` prefix).
 * - `onBuildEnd` copies `assets/search.js` byte-for-byte to
 *   `dist/assets/search.js`.
 *
 * Entries are exactly `{title, url, excerpt, tags}` in that order —
 * plain text with HTML tag runs stripped, never the document body:
 * `title`/`excerpt` come from frontmatter (T020 publishes its generated
 * excerpt onto the document), `url` is the emitted site-absolute path,
 * `tags` is the trimmed string array (possibly empty). An empty site
 * yields `[]`.
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, Site } from "../content/document.ts";
import type { BuildEnd, Feature, FeatureContext } from "../feature.ts";
import { pageOutputFor } from "../render/emit.ts";

/** `features.search.indexPath` when the config slice is absent. */
const DEFAULT_INDEX_PATH = "search-index.json";

/** `assets/search.js`, resolved from this module, not the cwd. */
const SCRIPT_URL = new URL("../../assets/search.js", import.meta.url);

/** HTML tag runs (`<em>`, `</p>`, `<br/>`) — never shipped in the index. */
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/g;

/** One index entry: exactly these fields, in this order. */
interface SearchEntry {
  title: string;
  url: string;
  excerpt: string;
  tags: string[];
}

/** The validated `features.search` slice. */
interface SearchOptions {
  indexPath: string;
}

/** Type name for error messages, mirroring `src/config.ts`. */
function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Validator for `config.features.search`: an optional `indexPath` string.
 * Every rejection names `features.search.indexPath` in full so the
 * `ctx.options` prefix plus this text always carries the key path the
 * ticket asks for (e.g. `features.search: features.search.indexPath must
 * be a string (got number)`).
 */
function parseOptions(raw: unknown): SearchOptions {
  if (raw === undefined) return { indexPath: DEFAULT_INDEX_PATH };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `features.search.indexPath: expected an object { indexPath?: string } (got ${describeType(raw)})`,
    );
  }
  const value = (raw as { indexPath?: unknown }).indexPath;
  if (value === undefined) return { indexPath: DEFAULT_INDEX_PATH };
  if (typeof value !== "string") {
    throw new Error(
      `features.search.indexPath must be a string (got ${describeType(value)})`,
    );
  }
  const indexPath = value.trim();
  if (indexPath === "") {
    throw new Error("features.search.indexPath must not be empty");
  }
  if (path.isAbsolute(indexPath) || /^[a-zA-Z]:[\\/]/.test(indexPath)) {
    throw new Error(
      `features.search.indexPath must be relative to dist/ (got "${value}")`,
    );
  }
  if (indexPath.includes("..")) {
    throw new Error(
      `features.search.indexPath must not contain ".." (got "${value}")`,
    );
  }
  return { indexPath };
}

/** `data.tags` as a trimmed string array; anything else → `[]`. */
function tagsFor(value: unknown): string[] {
  const raw = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const tags: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const tag = item.trim();
    if (tag !== "") tags.push(tag);
  }
  return tags;
}

/** One published document → one index entry (key order matters). */
function entryFor(page: Page): SearchEntry {
  const title = typeof page.data.title === "string" ? page.data.title : "";
  const excerpt =
    typeof page.data.excerpt === "string" ? page.data.excerpt : "";
  return {
    title: title.replace(HTML_TAG, " ").replace(/\s+/g, " ").trim(),
    url: pageOutputFor(page).url,
    excerpt: excerpt.replace(HTML_TAG, " ").replace(/\s+/g, " ").trim(),
    tags: tagsFor(page.data.tags),
  };
}

async function onSite(site: Site, ctx: FeatureContext): Promise<void> {
  const { indexPath } = ctx.options(parseOptions);
  const entries = site.pages.map(entryFor);
  site.data.searchIndexPath = `/${indexPath}`;
  const target = path.resolve("dist", indexPath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}

async function onBuildEnd(result: BuildEnd): Promise<void> {
  const target = path.join(result.distDir, "assets", "search.js");
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(fileURLToPath(SCRIPT_URL), target);
}

const search: Feature = { onSite, onBuildEnd };
export default search;
