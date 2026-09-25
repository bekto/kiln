/**
 * Related posts (T022) — attach a `related` list to every post document in
 * `onSite`, before collections and rendering, so a post layout can render a
 * "Related posts" section at build time with no client-side work.
 *
 * Scoring is pure tag overlap: the candidate pool is the posts collection
 * (T008 membership — `data.collection === "posts"`, never pages), minus
 * documents hidden by T013's rule: `draft: true` or a `date` after build
 * start stay out unless `--drafts` / `--future` include them (read through
 * `ctx.flags`, never `process.argv`). publish.ts strips hidden documents
 * from `site.pages` before this hook runs (filename order); the flag check
 * here keeps the feature self-contained without coupling to that module.
 *
 * Config: `features.related.limit` — positive integer, default 5. The slice
 * is validated through `ctx.options`, so an invalid value fails the build
 * with an error naming `features.related.limit` (recorded by the pipeline
 * as a feature error, never thrown from `build()`).
 *
 * Entries are plain template-safe objects `{ title, url, date }` with `date`
 * as an ISO 8601 string; `date` on a document without one counts as epoch
 * (oldest), matching `sortByDate` in `src/content/collections.ts`.
 */
import type { BuildFlags, Feature } from "../feature.ts";
import type { Page } from "../content/document.ts";

/** One related entry as templates consume it — plain data, ISO 8601 date. */
export interface RelatedEntry {
  title: string;
  url: string;
  date: string;
}

/** Default `features.related.limit` when the config key is absent. */
const DEFAULT_LIMIT = 5;

const feature: Feature = {
  onSite(site, ctx) {
    // Validate config first: an invalid limit fails the build before any
    // document is touched.
    const limit = ctx.options(readLimit);
    const buildStart = Date.now();

    // Posts only; candidates additionally honor T013's flag-driven
    // visibility so hidden posts stay out of everyone's list.
    const posts: Page[] = [];
    const candidates: Page[] = [];
    for (const page of site.pages) {
      if (page.data.collection !== "posts") continue;
      posts.push(page);
      if (visible(page, ctx.flags, buildStart)) candidates.push(page);
    }

    for (const post of posts) {
      const ownTags = tagsOf(post);
      const ranked: { page: Page; score: number }[] = [];
      for (const candidate of candidates) {
        // A post is always excluded from its own list — identity, plus path
        // in case the same document is handed in as two objects.
        if (candidate === post || candidate.path === post.path) continue;
        const score = overlap(ownTags, tagsOf(candidate));
        if (score > 0) ranked.push({ page: candidate, score });
      }
      // Score desc, then date desc, then URL ascending — fully
      // deterministic for equal scores and equal dates.
      ranked.sort(
        (a, b) =>
          b.score - a.score ||
          epochMs(b.page) - epochMs(a.page) ||
          compareCodepoints(a.page.url, b.page.url),
      );
      post.data.related = ranked.slice(0, limit).map(({ page }) => {
        const title = page.data.title;
        return {
          title: typeof title === "string" ? title : "",
          url: page.url,
          date: new Date(epochMs(page)).toISOString(),
        };
      });
    }
  },
};

export default feature;

/** `features.related.limit`: a positive integer, default 5. */
function readLimit(raw: unknown): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    const shown = raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw;
    throw new Error(`"features.related" must be a plain object (got ${shown})`);
  }
  const limit = (raw as { limit?: unknown }).limit;
  if (limit === undefined) return DEFAULT_LIMIT;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
    // A number shows itself (`0`, `1.5`, `NaN`); a non-number shows its
    // type — mirroring `src/config.ts`'s `describeType`.
    const shown =
      typeof limit === "number"
        ? String(limit)
        : limit === null
          ? "null"
          : Array.isArray(limit)
            ? "array"
            : typeof limit;
    throw new Error(
      `"features.related.limit" must be a positive integer (got ${shown})`,
    );
  }
  return limit;
}

/**
 * T013's visibility rule read through this feature's own flags: a boolean
 * `draft: true` hides unless `--drafts`, a `date` strictly after build start
 * hides unless `--future`. A `date` exactly at build time counts as
 * published; a non-boolean `draft` is publish.ts's validation, not ours.
 */
function visible(page: Page, flags: BuildFlags, buildStart: number): boolean {
  if (page.data.draft === true && !flags.drafts) return false;
  if (epochMs(page) > buildStart && !flags.future) return false;
  return true;
}

/**
 * `data.tags` as a trimmed set — absent, non-array, or non-string entries
 * contribute nothing, so an untagged post simply scores 0 everywhere.
 */
function tagsOf(page: Page): Set<string> {
  const tags = new Set<string>();
  const raw = page.data.tags;
  if (Array.isArray(raw)) {
    for (const tag of raw) {
      if (typeof tag !== "string") continue;
      const trimmed = tag.trim();
      if (trimmed !== "") tags.add(trimmed);
    }
  }
  return tags;
}

/** Set-intersection size — the score of one candidate pair. */
function overlap(own: Set<string>, candidate: Set<string>): number {
  let shared = 0;
  for (const tag of candidate) {
    if (own.has(tag)) shared += 1;
  }
  return shared;
}

/**
 * Epoch milliseconds of `data.date`; missing/invalid → 0 (oldest), the same
 * fallback `sortByDate` applies. T004 hands real documents a `Date`; the
 * string/number branches guard feature-appended pages.
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

/** Ascending Unicode codepoint order — the rule discovery/collections use. */
function compareCodepoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i += 1) {
    const l = left[i].codePointAt(0) ?? 0;
    const r = right[i].codePointAt(0) ?? 0;
    if (l !== r) return l - r;
  }
  return left.length - right.length;
}
