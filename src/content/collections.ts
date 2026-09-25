/**
 * Content collections — organize a discovered {@link Site} into deterministic
 * `posts` and `pages` collections (newest first) plus the pure query helpers
 * that templates (T009 defaults), the orchestrator (T012), and Wave-3
 * features reuse instead of re-deriving ordering rules.
 *
 * Pure data functions: no I/O, no config, no clock. Inputs are never mutated
 * — every output is a new array of the same {@link Page} objects, so pages
 * appended by features after discovery participate identically to discovered
 * files. Drafts and future-dated posts are always included; visibility
 * policy is T013's.
 */
import type { Page, Site } from "./document.ts";

/** The collections a {@link Site} partitions into, each sorted newest-first. */
export interface Collections {
  posts: Page[];
  pages: Page[];
}

/**
 * Partition `site.pages` into `posts` and `pages` and sort both with
 * {@link sortByDate}.
 *
 * Membership is read from frontmatter `data.collection` (T007 stamps it at
 * discovery): exactly `"posts"` or `"pages"` when present — anything else
 * rejects with `<path>: "collection" must be "posts" or "pages" (got <value>)`
 * — and `pages` when absent (home pages, feature-appended archives/loops).
 * Only membership is validated here; `draft` and `tags` are checked by the
 * helpers that read them (`isDraft`, `byTag`, `allTags`).
 */
export function computeCollections(site: Site): Collections {
  const posts: Page[] = [];
  const pages: Page[] = [];
  for (const page of site.pages) {
    if (collectionOf(page) === "posts") {
      posts.push(page);
    } else {
      pages.push(page);
    }
  }
  return { posts: sortByDate(posts), pages: sortByDate(pages) };
}

/**
 * Descending by `data.date` (newest first); ties break ascending by
 * `page.path`, so the output is fully deterministic whatever order the input
 * arrived in. A missing or unparseable date counts as oldest (epoch) — T004
 * already rejects invalid dates at parse time, this guard covers
 * feature-appended objects and never throws.
 */
export function sortByDate(pages: Page[]): Page[] {
  return [...pages].sort((a, b) => {
    const at = pageTime(a);
    const bt = pageTime(b);
    if (at !== bt) return bt - at; // newest first
    return compareCodepoints(a.path, b.path);
  });
}

/**
 * Pages whose `data.tags` include `tag`, in input order. Matching is exact
 * and case-sensitive after trimming whitespace from both sides of each tag.
 * Rejects when any page's `data.tags` violates the tag rules.
 */
export function byTag(pages: Page[], tag: string): Page[] {
  const wanted = tag.trim();
  return pages.filter(
    (page) => readTags(page)?.some((candidate) => candidate.trim() === wanted) ?? false,
  );
}

/**
 * Every tag across `pages`, trimmed, without duplicates, in first-seen order
 * over the input sequence. Each result round-trips through {@link byTag}.
 * Rejects when any page's `data.tags` violates the tag rules.
 */
export function allTags(pages: Page[]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const page of pages) {
    for (const tag of readTags(page) ?? []) {
      const trimmed = tag.trim();
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      tags.push(trimmed);
    }
  }
  return tags;
}

/**
 * `data.draft === true` — boolean `true` only; absent or `false` is not a
 * draft. A present-but-not-a-boolean value rejects with
 * `<path>: "draft" must be a boolean (got <type>)`.
 */
export function isDraft(page: Page): boolean {
  const value = page.data.draft;
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new Error(
      `${page.path}: "draft" must be a boolean (got ${describeType(value)})`,
    );
  }
  return value;
}

/** `pages` in input order minus every draft (validating each `data.draft`). */
export function withoutDrafts(pages: Page[]): Page[] {
  return pages.filter((page) => !isDraft(page));
}

/** `page.data.collection` as a member of {@link Collections}; absent → `'pages'`. */
function collectionOf(page: Page): "posts" | "pages" {
  const value = page.data.collection;
  if (value === undefined) return "pages";
  if (value === "posts" || value === "pages") return value;
  throw new Error(
    `${page.path}: "collection" must be "posts" or "pages" (got ${describeValue(value)})`,
  );
}

/** Epoch milliseconds of `data.date`; missing/unparseable → `0` (epoch = oldest). */
function pageTime(page: Page): number {
  const value = page.data.date;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 0 : value.getTime();
  }
  if (typeof value === "string") {
    const time = Date.parse(value);
    return Number.isNaN(time) ? 0 : time;
  }
  return 0;
}

/**
 * `page.data.tags` after validation — `undefined` when absent. Present must
 * be an array of strings, otherwise `<path>: "tags" must be an array of
 * strings (got <type>)` (`tags: "news"` is the classic slip).
 */
function readTags(page: Page): string[] | undefined {
  const value = page.data.tags;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(
      `${page.path}: "tags" must be an array of strings (got ${describeType(value)})`,
    );
  }
  const tags: string[] = [];
  for (const tag of value) {
    if (typeof tag !== "string") {
      throw new Error(
        `${page.path}: "tags" must be an array of strings (got ${describeType(tag)})`,
      );
    }
    tags.push(tag);
  }
  return tags;
}

/**
 * The offending `collection` value for error messages: JSON so strings come
 * back quoted (`"zine"`), falling back to a type name for symbols, functions,
 * and cyclic objects JSON cannot represent.
 */
function describeValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? describeType(value);
  } catch {
    return describeType(value);
  }
}

/** Type name for error messages, mirroring `src/config.ts` and T004. */
function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Ascending Unicode codepoint order — the same rule discovery sorts
 * `site.pages` with, so date ties keep the discovered (path-ascending)
 * relative order. Plain `<` compares UTF-16 code units, which disagree with
 * codepoint order where surrogate pairs meet the U+E000–U+FFFF range.
 */
function compareCodepoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i++) {
    const x = left[i].codePointAt(0) ?? 0;
    const y = right[i].codePointAt(0) ?? 0;
    if (x !== y) return x - y;
  }
  return left.length - right.length;
}
