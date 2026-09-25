/**
 * Tags & category archives (T014) — every tag and category carried by
 * visible posts gets an archive page at `/tags/<slug>/` or
 * `/categories/<slug>/`, plus `/tags/` and `/categories/` index pages
 * listing each term with its count; all of it rendered through T009's
 * layouts via the one new partial `templates/partials/taxonomy-list.html`.
 *
 * Hook split:
 * - `onDocument` validates this feature's own frontmatter fields — `tags`
 *   (array of strings) and `category` (single string) — unconditionally, so
 *   an empty/non-string term fails the build naming the document, and it
 *   records every document's terms before any `onSite` runs. The record
 *   matters because publish.ts (T013) removes hidden documents from
 *   `site.pages` in its `onSite`, which filename-sorts before this file —
 *   without it, a term carried only by hidden posts would be invisible
 *   here and its "no visible posts" error could never name its source.
 *   The record rebuilds whenever the context identity changes (T012 hands
 *   every build a fresh context), so watch-mode rebuilds never inherit the
 *   previous run's documents.
 * - `onSite` appends the archive and index pages as Page-shaped entries
 *   `{ path, url, content, data: { permalink, layout, title, posts } }` —
 *   `path` is a unique synthetic identifier (`taxonomy:<url>`), `url`
 *   mirrors the permalink in its final T005 form (the value `pageOutputFor`
 *   derives at emit, set eagerly because template views render `p.url`
 *   strictly before emit), so `pageOutputFor` pairs it with the same
 *   pretty-path target at emit.
 *
 * Visibility follows the ticket: only posts with `data.published !== false`
 * participate (T013 resolves that flag in `onDocument`, before any
 * `onSite`), and — mirroring T022's self-contained reading — the
 * draft/future rule is re-derived from this feature's own `ctx.flags`, so
 * the archives behave identically before publish.ts lands. Terms match
 * exactly after trimming (T008's tag rule), slug with T005's unicode-safe
 * `slugify`, and rendered hrefs are percent-encoded (`encodeURI`)
 * consistently with T005's path→URL mapping.
 *
 * Validation (recorded by the pipeline as feature errors, never thrown
 * from `build()`): non-array `tags`; an empty/whitespace-only or
 * non-string tag; a non-string/empty `category`; two distinct terms
 * colliding on one slug (both terms named, both documents named); and a
 * term whose archive would hold zero visible posts (the term named exactly
 * as written plus its source document).
 *
 * Page-1 slicing seam for T015: `pagination.ts` filename-sorts before this
 * file, so its `onSite` publishes `site.data.pagination = { pageSize }`
 * first; an archive with more visible posts than `pageSize` then renders
 * only the first `pageSize` entries (overflow pages are T015's job).
 * Absent — T014 standalone — the full list renders. The partial always
 * renders `page.posts`. No config key: taxonomy is always on.
 */
import type { BuildFlags, Feature, FeatureContext } from "../feature.ts";
import type { Document, Page, Site } from "../content/document.ts";
import { sortByDate } from "../content/collections.ts";
import { slugify } from "../content/slug.ts";

/** One taxonomy kind: frontmatter field, URL base, index page title. */
interface Kind {
  readonly field: "tags" | "category";
  /** Pretty-URL base including slashes, e.g. `"/tags/"`. */
  readonly base: string;
  readonly indexTitle: string;
}

const KINDS: readonly Kind[] = [
  { field: "tags", base: "/tags/", indexTitle: "Tags" },
  { field: "category", base: "/categories/", indexTitle: "Categories" },
];

/** A document's terms. */
interface Terms {
  readonly tags: string[];
  /** Raw (untrimmed) value; `undefined` when the field is absent. */
  readonly category?: string;
}

/** A document's terms plus where they were written. */
interface TermSource extends Terms {
  readonly path: string;
}

/** One term's visible carriers, in discovery order (sorted at append time). */
interface TermGroup {
  readonly term: string;
  readonly carriers: Page[];
}

/** Index entry as the partial renders it: term, link, visible count. */
interface IndexEntry {
  title: string;
  url: string;
  count: number;
}

/**
 * Every document's terms for the current build, in document order.
 * Rebuilt when the context identity changes — T012 creates fresh contexts
 * per build, so a rebuild never inherits the previous run's documents.
 */
let sources: TermSource[] = [];
let sourcesCtx: FeatureContext | undefined;

const feature: Feature = {
  onDocument(doc, ctx) {
    // Start a fresh term record when T012 hands this build a new context,
    // so a watch-mode rebuild never inherits the previous run's documents.
    if (sourcesCtx !== ctx) {
      sources = [];
      sourcesCtx = ctx;
    }
    sources.push({
      path: doc.path,
      tags: readTags(doc),
      category: readCategory(doc),
    });
  },

  onSite(site, ctx) {
    if (sourcesCtx !== ctx) {
      sources = [];
      sourcesCtx = ctx;
    }
    const buildStart = Date.now();

    // Visible posts only: T013's resolved flag, plus the same flag-driven
    // draft/future rule publish.ts applies so behavior matches with or
    // without that feature present.
    const visiblePages = site.pages.filter((page) =>
      visible(page, ctx.flags, buildStart),
    );

    // Output-space conflicts first (every document counts, even ones whose
    // archives would later fail the zero-post check), then per-kind work:
    // zero-post validation, then the appended pages.
    assertNoSlugCollisions();
    const pageSize = pageSizeOf(site);
    for (const kind of KINDS) {
      const groups = groupsFor(visiblePages, kind);
      assertNoEmptyTerms(kind, groups);
      appendKind(site, kind, groups, pageSize);
    }
  },
};

export default feature;

/**
 * `data.tags` — absent contributes nothing; present must be an array whose
 * entries are non-empty strings after trimming, otherwise
 * `<path>: tags: tag <value> must be a non-empty string`. A non-array
 * mirrors T008's message: `<path>: "tags" must be an array of strings …`.
 */
function readTags(doc: Document): string[] {
  const value = doc.data.tags;
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(
      `${doc.path}: "tags" must be an array of strings (got ${describeType(value)})`,
    );
  }
  const tags: string[] = [];
  for (const tag of value) {
    if (typeof tag !== "string" || tag.trim() === "") {
      throw new Error(
        `${doc.path}: tags: tag ${describeValue(tag)} must be a non-empty string`,
      );
    }
    tags.push(tag);
  }
  return tags;
}

/** `data.category` — absent/null contributes nothing; else one non-empty string. */
function readCategory(doc: Document): string | undefined {
  const value = doc.data.category;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `${doc.path}: category must be a non-empty string (got ${describeValue(value)})`,
    );
  }
  return value;
}

/**
 * T013's visibility rule read through this feature's own flags — the same
 * self-contained reading `src/features/related.ts` uses — plus the
 * ticket's `data.published !== false` filter (publish.ts resolves that
 * flag in `onDocument`, before any `onSite`). A non-boolean `draft` is
 * publish.ts's validation, not ours.
 */
function visible(page: Page, flags: BuildFlags, buildStart: number): boolean {
  if (page.data.published === false) return false;
  if (page.data.draft === true && !flags.drafts) return false;
  if (epochMs(page) > buildStart && !flags.future) return false;
  return true;
}

/**
 * Epoch milliseconds of `data.date`; missing/invalid → 0 (oldest), the
 * same fallback `sortByDate` applies. T004 hands real documents a `Date`;
 * the other branches guard feature-appended pages.
 */
function epochMs(page: Page): number {
  const value = page.data.date;
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === "string" || typeof value === "number"
        ? new Date(value).getTime()
        : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

/** The raw terms of `terms` for `kind`, as an array. */
function pickTerms(kind: Kind, terms: Terms): string[] {
  if (kind.field === "tags") return terms.tags;
  return terms.category === undefined ? [] : [terms.category];
}

/**
 * Two distinct terms (T008: exact after trimming) slugifying to one path —
 * e.g. `Web dev` and `web-dev` → `web-dev` — fail the build with an error
 * naming both terms and both source documents. The same term carried by
 * several documents is not a collision.
 */
function assertNoSlugCollisions(): void {
  for (const kind of KINDS) {
    const seen = new Map<string, { raw: string; path: string }>();
    for (const source of sources) {
      for (const raw of pickTerms(kind, source)) {
        const term = raw.trim();
        const slug = slugify(term);
        const first = seen.get(slug);
        if (first === undefined) {
          seen.set(slug, { raw, path: source.path });
          continue;
        }
        if (first.raw.trim() === term) continue;
        throw new Error(
          `${kind.field}: ${JSON.stringify(first.raw)} (${first.path}) and ` +
            `${JSON.stringify(raw)} (${source.path}) both slugify to "${slug}"`,
        );
      }
    }
  }
}

/** Group every visible carrier by trimmed term, first-seen order. */
function groupsFor(visible: Page[], kind: Kind): TermGroup[] {
  const groups = new Map<string, TermGroup>();
  for (const page of visible) {
    const seen = new Set<string>();
    for (const raw of pickTerms(kind, {
      tags: readTags(page),
      category: readCategory(page),
    })) {
      const term = raw.trim();
      if (seen.has(term)) continue;
      seen.add(term);
      const group = groups.get(term);
      if (group === undefined) groups.set(term, { term, carriers: [page] });
      else group.carriers.push(page);
    }
  }
  return [...groups.values()];
}

/**
 * A term no visible post carries — e.g. its only posts are drafts — fails
 * the build with an error naming the term exactly as written in
 * frontmatter and the document that wrote it.
 */
function assertNoEmptyTerms(kind: Kind, groups: TermGroup[]): void {
  const nonEmpty = new Set(groups.map((group) => group.term));
  const reported = new Set<string>();
  for (const source of sources) {
    for (const raw of pickTerms(kind, source)) {
      const term = raw.trim();
      if (nonEmpty.has(term) || reported.has(term)) continue;
      reported.add(term);
      throw new Error(
        `${source.path}: ${kind.field}: ${JSON.stringify(raw)} has no visible posts`,
      );
    }
  }
}

/**
 * Append one archive per term (newest first, sliced to the T015 page-1
 * seam) and — when the kind has any terms at all — its index sorted by
 * slug with total visible counts.
 */
function appendKind(
  site: Site,
  kind: Kind,
  groups: TermGroup[],
  pageSize: number | undefined,
): void {
  if (groups.length === 0) return;

  for (const group of groups) {
    let carriers = sortByDate(group.carriers);
    if (pageSize !== undefined && carriers.length > pageSize) {
      carriers = carriers.slice(0, pageSize);
    }
    const title = group.term;
    const posts = carriers.map((page) => ({
      title: typeof page.data.title === "string" ? page.data.title : "",
      url: encodeURI(page.url),
      date: page.data.date instanceof Date ? page.data.date : undefined,
    }));
    append(site, `${kind.base}${slugify(group.term)}/`, { title, posts });
  }

  const posts: IndexEntry[] = groups
    .map((group) => ({ group, slug: slugify(group.term) }))
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .map(({ group, slug }) => ({
      title: group.term,
      url: encodeURI(`${kind.base}${slug}/`),
      count: group.carriers.length,
    }));
  append(site, kind.base, { title: kind.indexTitle, posts });
}

/**
 * Append one Page-shaped entry. `url` equals the `data.permalink` value in
 * its final (T005-normalized) form — the same URL `pageOutputFor` would
 * derive at emit, but set eagerly so template views of `site.pages` (which
 * run before emit and render `p.url` strictly) can list these pages; a
 * url-less entry makes any `index.html`-layout page crash with
 * `undefined variable "p.url"`. The layout points at the T014 partial,
 * which extends T009's index layout and renders `page.posts`.
 */
function append(site: Site, permalink: string, data: Record<string, unknown>): void {
  site.pages.push({
    path: `taxonomy:${permalink}`,
    url: permalink,
    content: "",
    data: { permalink, layout: "taxonomy-list", ...data },
  });
}

/**
 * T015's published seam: `site.data.pagination = { pageSize }` when
 * pagination runs; absent or unusable (T015 validates its own key) → the
 * full list renders.
 */
function pageSizeOf(site: Site): number | undefined {
  const raw = site.data.pagination;
  if (typeof raw !== "object" || raw === null) return undefined;
  const size = (raw as { pageSize?: unknown }).pageSize;
  return typeof size === "number" && Number.isInteger(size) && size > 0
    ? size
    : undefined;
}

/** JSON form of a value for error messages, with a non-throwing fallback. */
function describeValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? describeType(value);
  } catch {
    return String(value);
  }
}

/** Type name for error messages, mirroring `src/content/collections.ts`. */
function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
