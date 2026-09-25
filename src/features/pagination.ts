/**
 * Pagination (T015) — the home list and every tag/category archive are
 * split into pages of `features.pagination.pageSize` posts (default 10):
 * page 1 keeps its canonical URL, overflow pages land at `/page/2/` … and
 * `/tags/<slug>/page/2/` … with working prev/next navigation, and single
 * posts or static pages are never paginated.
 *
 * Hook shape: `onSite` only, and it filename-sorts FIRST among the
 * `onSite`-running features (`pagination` < `publish` < `taxonomy`), which
 * drives the ticket's three constraints:
 *
 * - publish.ts (T013) has not removed hidden documents yet, so this
 *   feature skips every page with `data.published === false` itself (the
 *   flag publish resolves in `onDocument`, before any `onSite`) plus the
 *   same flag-driven draft/future rule taxonomy re-derives — a draft
 *   never occupies a page slot, whatever `--drafts` says.
 * - taxonomy.ts (T014) has not appended its archives yet, so the term
 *   set is re-derived here from the same frontmatter fields (`tags`,
 *   `category`) and T005's `slugify`, keyed by slug — a duplicate T014
 *   will reject still dedupes here (T014's error aborts the build before
 *   emit) — and terms with zero visible carriers simply never form a
 *   group (T014 owns that error). Identical derivation ⇒ the overflow
 *   paths line up with T014's archives.
 * - the resolved settings are published first as
 *   `site.data.pagination = { pageSize }`, the seam T014's archives
 *   consume to slice their page-1 list (they render the full list when
 *   it is absent, i.e. standalone builds of that feature).
 *
 * List documents — the home document and every appended overflow page —
 * get `data.posts` (the entries the layout renders, sliced to the page),
 * `data.pagination = { page, totalPages, prevUrl?, nextUrl? }` (1-based;
 * `prevUrl` absent on page 1, `nextUrl` absent on the last page, page 2's
 * `prevUrl` is the canonical list URL — never `/page/1/`), and
 * `data.injectBody = ["pagination.html"]` so
 * `templates/partials/pagination.html` renders the nav through
 * base.html's body slot on any layout chain (the partial itself emits
 * nothing while `totalPages` is 1, so a single-page list is unchanged).
 *
 * Overflow pages are appended as Page-shaped objects
 * `{ path: "pagination:<url>", url, content, data: { permalink, layout?,
 * title?, posts, pagination, injectBody } }` — `layout`/`title` are set
 * only when the home document declares them (absence mirrors so T009's
 * default layout applies to page 1 and page 2 alike), `url` mirrors the
 * permalink eagerly (T014's fix): template views of `site.pages` render
 * `p.url` strictly before emit, so a url-less entry would crash every
 * index-layout page that loops `site.pages`.
 *
 * Validation: `features.pagination.pageSize` must be a positive integer —
 * `0`, negative, fractional, or non-number values fail the build through
 * `ctx.options`, which prefixes the full `features.pagination` key path.
 * An existing document already claiming a planned overflow URL fails the
 * build with an error naming that URL (exit 1 through the report, like
 * every feature failure). Everything is recomputed per `onSite`
 * invocation from the site at hand — no module state, so watch-mode
 * rebuilds cannot inherit stale pages.
 */
import type { BuildFlags, Feature, FeatureContext } from "../feature.ts";
import type { Page, Site } from "../content/document.ts";
import { sortByDate } from "../content/collections.ts";
import { filePathForUrl, slugify } from "../content/slug.ts";
import { pageOutputFor } from "../render/emit.ts";
import { pageView } from "../render/templates.ts";

/** Default `features.pagination.pageSize` when the config key is absent. */
const DEFAULT_PAGE_SIZE = 10;

/** The nav partial injected into every paginated list document's body. */
const PARTIAL = "pagination.html";

/** One paginated list kind: frontmatter field + T014's pretty-URL base. */
interface Kind {
  readonly field: "tags" | "category";
  /** Pretty-URL base including slashes, e.g. `"/tags/"`. */
  readonly base: string;
}

const KINDS: readonly Kind[] = [
  { field: "tags", base: "/tags/" },
  { field: "category", base: "/categories/" },
];

/** One archive's carriers sharing one slug — T014's archive URL path. */
interface Group {
  readonly slug: string;
  /** First-seen raw term, trimmed — the archive title T014 shows. */
  readonly term: string;
  readonly carriers: Page[];
}

/** `data.pagination` — 1-based page; prev/next absent where pinned. */
interface PaginationInfo {
  page: number;
  totalPages: number;
  prevUrl?: string;
  nextUrl?: string;
}

/** One overflow page to append, fully planned before anything mutates. */
interface Overflow {
  readonly permalink: string;
  readonly layout: string | undefined;
  readonly title: string | undefined;
  readonly posts: Record<string, unknown>[];
  readonly pagination: PaginationInfo;
}

const feature: Feature = {
  onSite(site, ctx) {
    // Validate config first — even an empty site must reject a bad
    // pageSize — then publish the seam T014's archives slice with.
    const pageSize = ctx.options(readPageSize);
    site.data.pagination = { pageSize };
    const buildStart = Date.now();

    // Visible only: T013's resolved flag plus the same flag-driven
    // draft/future rule taxonomy applies, so this feature derives exactly
    // the set taxonomy sees after publish.ts has filtered site.pages.
    const visiblePages = site.pages.filter((page) =>
      visible(page, ctx.flags, buildStart),
    );
    const visibleSet = new Set(visiblePages);
    const overflows: Overflow[] = [];

    // The home list — the document published at "/". A hidden home is
    // removed by publish.ts later, so it neither shows a list nor claims
    // overflow URLs.
    const home = site.pages.find((page) => page.url === "/");
    if (home !== undefined && visibleSet.has(home)) {
      const posts = sortByDate(
        visiblePages.filter((page) => page.data.collection === "posts"),
      );
      const totalPages = Math.max(1, Math.ceil(posts.length / pageSize));
      // Replace the home document's post-list view data with the first
      // pageSize visible posts (all of them while the list fits one page).
      home.data.posts = posts.slice(0, pageSize).map(entryFor);
      home.data.pagination = pageInfo(1, totalPages, "/", "/page/");
      injectPartial(home);

      // Overflow pages mirror the home document's own layout and title so
      // page 2 renders like page 1. Home with NO frontmatter layout keeps
      // NO layout on its overflow pages: T009's default (post.html) then
      // applies to both identically — forcing "index" here would render
      // page 2 through a template page 1 never used (and break projects
      // that ship no index.html).
      const layout =
        typeof home.data.layout === "string" ? home.data.layout : undefined;
      const title =
        typeof home.data.title === "string" ? home.data.title : undefined;
      for (let page = 2; page <= totalPages; page += 1) {
        overflows.push({
          permalink: `/page/${page}/`,
          layout,
          title,
          posts: posts
            .slice((page - 1) * pageSize, page * pageSize)
            .map(entryFor),
          pagination: pageInfo(page, totalPages, "/", "/page/"),
        });
      }
    }

    // Tag/category archives — the term set re-derived exactly as T014
    // derives it (this hook runs first, so it reads frontmatter and T005's
    // slugger, never T014's output). Terms are keyed by slug: two terms
    // T014 will reject as a slug collision still merge into one group
    // here, and T014's error aborts the build before emit.
    for (const kind of KINDS) {
      for (const group of groupsFor(visiblePages, kind)) {
        const carriers = sortByDate(group.carriers);
        const totalPages = Math.max(1, Math.ceil(carriers.length / pageSize));
        const canonical = `${kind.base}${group.slug}/`;
        const overflow = `${canonical}page/`;
        // One page (fits pageSize) → the loop below never runs: no
        // empty /page/2/ directory.
        for (let page = 2; page <= totalPages; page += 1) {
          overflows.push({
            permalink: `${overflow}${page}/`,
            layout: "taxonomy-list",
            title: group.term,
            posts: carriers
              .slice((page - 1) * pageSize, page * pageSize)
              .map(entryFor),
            pagination: pageInfo(page, totalPages, canonical, overflow),
          });
        }
      }
    }

    // Collision: an existing document already claims a planned overflow
    // URL. Paired by output file so a permalink missing its trailing slash
    // cannot slip past; the error names the URL the ticket pins.
    for (const overflow of overflows) {
      const target = filePathForUrl(overflow.permalink);
      const clash = site.pages.find((page) => pageOutputFor(page).file === target);
      if (clash !== undefined) {
        throw new Error(
          `pagination: ${overflow.permalink} is already claimed by ${clash.path}`,
        );
      }
    }

    // Append the overflow pages; they flow through T010's emit like
    // discovered pages. `url` mirrors the permalink (T014's fix) so the
    // strict `p.url` render in any index-layout page cannot crash.
    for (const overflow of overflows) {
      const data: Record<string, unknown> = {
        permalink: overflow.permalink,
        posts: overflow.posts,
        pagination: overflow.pagination,
        injectBody: [PARTIAL],
      };
      if (overflow.layout !== undefined) data.layout = overflow.layout;
      if (overflow.title !== undefined) data.title = overflow.title;
      site.pages.push({
        path: `pagination:${overflow.permalink}`,
        url: overflow.permalink,
        content: "",
        data,
      });
    }
  },
};

export default feature;

/**
 * `features.pagination.pageSize`: a positive integer, default 10. Failures
 * carry the full key path — T012's `ctx.options` prefixes them
 * `features.pagination: ` on the way out, so every message here surfaces
 * with both `features.pagination` and `pageSize`.
 */
function readPageSize(raw: unknown): number {
  if (raw === undefined) return DEFAULT_PAGE_SIZE;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    const shown =
      raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw;
    throw new Error(
      `"features.pagination" must be a plain object with an optional "pageSize" positive integer (got ${shown})`,
    );
  }
  const pageSize = (raw as { pageSize?: unknown }).pageSize;
  if (pageSize === undefined) return DEFAULT_PAGE_SIZE;
  if (
    typeof pageSize !== "number" ||
    !Number.isInteger(pageSize) ||
    pageSize <= 0
  ) {
    // A number shows itself (`0`, `-1`, `1.5`, `NaN`); a non-number shows
    // its type — mirroring `src/config.ts`'s describeType.
    const shown =
      typeof pageSize === "number"
        ? String(pageSize)
        : pageSize === null
          ? "null"
          : Array.isArray(pageSize)
            ? "array"
            : typeof pageSize;
    throw new Error(
      `"features.pagination.pageSize" must be a positive integer (got ${shown})`,
    );
  }
  return pageSize;
}

/**
 * T013's visibility rule read through this feature's own flags — the same
 * self-contained reading `src/features/taxonomy.ts` uses — plus the
 * ticket's `data.published === false` filter (publish resolves that flag
 * in `onDocument`, before any `onSite`; this hook sorts before publish's
 * `onSite`, so hidden documents are still in `site.pages` here).
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

/**
 * One list entry as layouts render it: T009's page view (frontmatter +
 * `url`/`path`) with the href percent-encoded — the same encoding T014
 * applies to its archive entries, so unicode URLs render as they link in
 * the taxonomy index.
 */
function entryFor(page: Page): Record<string, unknown> {
  return { ...pageView(page), url: encodeURI(page.url) };
}

/**
 * `data.pagination` for `page` of `totalPages` over a list whose canonical
 * URL is `canonical` and whose overflow pages live under `overflow`
 * (`"/page/"` at the root, `"/tags/<slug>/page/"` in an archive):
 * 1-based, `prevUrl` absent on page 1, `nextUrl` absent on the last page,
 * and page 2's `prevUrl` is the canonical URL — never `/page/1/`.
 */
function pageInfo(
  page: number,
  totalPages: number,
  canonical: string,
  overflow: string,
): PaginationInfo {
  const pagination: PaginationInfo = { page, totalPages };
  if (page > 1) {
    pagination.prevUrl = encodeURI(
      page === 2 ? canonical : `${overflow}${page - 1}/`,
    );
  }
  if (page < totalPages) {
    pagination.nextUrl = encodeURI(`${overflow}${page + 1}/`);
  }
  return pagination;
}

/**
 * Register the nav partial in the document's body-injection list —
 * base.html includes `page.injectBody` entries after the content block, so
 * the partial renders on any layout chain (the same mechanism publish.ts
 * uses for its noindex head partial).
 */
function injectPartial(page: Page): void {
  const body = page.data.injectBody;
  if (body === undefined) {
    page.data.injectBody = [PARTIAL];
  } else if (Array.isArray(body) && !body.includes(PARTIAL)) {
    body.push(PARTIAL);
  }
}

/**
 * Every visible carrier grouped by slug, first-seen order (T014's
 * `groupsFor`, re-derived because this hook runs before taxonomy appends):
 * per page the terms are deduped by slug — a page carrying two terms that
 * slugify together joins one group once — and a term no visible page
 * carries never forms a group (T014 raises that error instead).
 */
function groupsFor(visible: Page[], kind: Kind): Group[] {
  const groups = new Map<string, Group>();
  for (const page of visible) {
    const seen = new Set<string>();
    for (const raw of termsOf(page, kind)) {
      const term = raw.trim();
      if (term === "") continue;
      const slug = slugify(term);
      if (seen.has(slug)) continue;
      seen.add(slug);
      const group = groups.get(slug);
      if (group === undefined) {
        groups.set(slug, { slug, term, carriers: [page] });
      } else {
        group.carriers.push(page);
      }
    }
  }
  return [...groups.values()];
}

/**
 * The raw terms of `page` for `kind` — lenient on purpose: taxonomy's
 * `onDocument` validated every document's `tags`/`category` before any
 * `onSite` ran, so malformed values have already failed the build and the
 * defensive branches here only keep this derivation total.
 */
function termsOf(page: Page, kind: Kind): string[] {
  if (kind.field === "tags") {
    const tags = page.data.tags;
    return Array.isArray(tags)
      ? tags.filter((tag): tag is string => typeof tag === "string")
      : [];
  }
  const category = page.data.category;
  return typeof category === "string" ? [category] : [];
}
