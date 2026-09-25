/**
 * T018 — Atom feed: write a valid Atom 1.0 document to `dist/feed.xml`
 * from `onBuildEnd` (T012's contract: build-end hooks may write files into
 * `result.distDir`).
 *
 * Shape of the output — all produced by the partial
 * `templates/partials/feed.xml` rendered through T009's strict nunjucks
 * environment (`loadTemplates()`, the same seam `emitPages` uses). The
 * partial resolves project-first (a project-shipped
 * `templates/partials/feed.xml` overrides) and falls back to the copy
 * bundled with the package, so no user project or shared fixture ever has
 * to carry the template for a build to pass:
 * - the XML declaration is the first bytes on the line, then the Atom
 *   namespace root with `<title>`, `<id>`, `<updated>`, and
 *   `<link rel="self" href="…/feed.xml">`;
 * - one `<entry>` per post with `<title>`, `<id>`, `<updated>`, `<link
 *   rel="alternate">`, and `<content type="html">` carrying the post's full
 *   rendered HTML. The environment's `autoescape` supplies the XML escaping
 *   (`&`, `<`, `>`, quotes) for titles and for the embedded markup alike —
 *   no CDATA anywhere (T018 non-goal).
 *
 * Entries are the `posts` collection read from `site.pages` inside
 * `onBuildEnd` — by T012's ordering guarantees every `onSite` hook
 * (notably T013's `publish`) has already removed hidden drafts and
 * future-dated posts, so the feed inherits visibility for free; `--drafts`
 * / `--future` builds include them exactly as the pages do. Posts are
 * newest-first (T008 `computeCollections`) and capped at
 * `features.feed.limit` (positive integer, default 20, validated through
 * `ctx.options` so failures carry the `features.feed: ` prefix).
 *
 * Every `href`/`id` is absolute: `site.url` must be an `http(s)://` origin
 * with a host — missing, empty, or relative values reject with an error
 * naming `site.url`, which T012 records as a feature failure (exit 1).
 *
 * A site with zero posts still yields a valid empty feed (no `<entry>`
 * children) whose `<updated>` falls back to the build timestamp.
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeCollections } from "../content/collections.ts";
import type { Page } from "../content/document.ts";
import { createRenderer } from "../content/markdown.ts";
import type { BuildEnd, Feature, FeatureContext } from "../feature.ts";
import { pageOutputFor } from "../render/emit.ts";
import { loadTemplates } from "../render/templates.ts";

/** Entry cap when `features.feed.limit` is absent. */
const DEFAULT_LIMIT = 20;

/**
 * The templates directory this package ships `partials/feed.xml` in — the
 * fallback source when the project carries no partial of its own. A
 * feature-shipped partial belongs to the kiln package: users and test
 * fixtures must never have to copy it for a build to succeed.
 */
const PACKAGE_TEMPLATES_DIR = fileURLToPath(
  new URL("../../templates/", import.meta.url),
);

/** The validated slice of `config.features.feed`. */
interface FeedOptions {
  limit: number;
}

/** One entry as `templates/partials/feed.xml` consumes it. */
interface FeedEntry {
  title: string;
  id: string;
  updated: string;
  link: string;
  content: string;
}

const feature: Feature = { onBuildEnd };

export default feature;

/**
 * `onBuildEnd` — validate config, select the posts, render the partial,
 * and write `dist/feed.xml` (creating `dist/` when an empty site never got
 * an emit). Any rejection is recorded by T012 as a feature failure; this
 * hook never throws past the contract.
 */
async function onBuildEnd(
  result: BuildEnd,
  ctx: FeatureContext,
): Promise<void> {
  // Order matters for message precedence: the feature's own config first,
  // then the site invariant every absolute link depends on.
  const { limit } = ctx.options(readFeedOptions);
  const base = siteBaseUrl(result.site.data.url);
  const siteTitle = result.site.data.title;
  const title =
    typeof siteTitle === "string" && siteTitle.trim() !== ""
      ? siteTitle
      : "Kiln site";

  // The empty feed's clock: build time in UTC/ISO 8601, used only when
  // there is no newest post to take `<updated>` from.
  const buildStamp = new Date().toISOString();

  const posts = computeCollections(result.site).posts; // newest first
  const entries: FeedEntry[] = posts.slice(0, limit).map((page) => {
    const link = absoluteUrl(base, pageOutputFor(page).url);
    const date = page.data.date;
    return {
      title: titleFor(page),
      id: link,
      // T004 leaves `date` optional; an undated post falls back to build
      // time (Atom requires `<updated>` on every entry).
      updated: date instanceof Date ? date.toISOString() : buildStamp,
      link,
      content: renderedContent(page),
    };
  });

  // Template resolution: a project that ships its own
  // `templates/partials/feed.xml` wins (project override); everyone else
  // renders the partial bundled with the kiln package. Only a package
  // missing ITS own copy fails — T009's loud `template not found`.
  const projectPartial = path.resolve("templates", "partials", "feed.xml");
  const projectOwnsFeed = await stat(projectPartial).then(
    (info) => info.isFile(),
    () => false,
  );
  const templates = await loadTemplates(
    projectOwnsFeed ? undefined : PACKAGE_TEMPLATES_DIR,
  );
  const xml = await templates.render("feed.xml", {
    title,
    feedId: absoluteUrl(base, "/"),
    updated: entries[0]?.updated ?? buildStamp,
    selfHref: absoluteUrl(base, "/feed.xml"),
    entries,
  });

  await mkdir(result.distDir, { recursive: true });
  await writeFile(path.join(result.distDir, "feed.xml"), xml, "utf8");
}

/**
 * Validate `config.features.feed`: an object (or absent) whose optional
 * `limit` is a positive integer. T012's `ctx.options` re-throws any failure
 * prefixed `features.feed: `, so every message here surfaces with the full
 * config key path.
 */
function readFeedOptions(raw: unknown): FeedOptions {
  if (raw === undefined) return { limit: DEFAULT_LIMIT };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`settings must be an object (got ${describe(raw)})`);
  }
  const limit = (raw as { limit?: unknown }).limit;
  if (limit === undefined) return { limit: DEFAULT_LIMIT };
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
    throw new Error(`limit must be a positive integer (got ${describe(limit)})`);
  }
  return { limit };
}

/**
 * `site.url` as a link-building base — an `http(s)://` URL with a host,
 * normalized to origin + path with no trailing slash, so joining a
 * site-relative URL onto it can never double up slashes. Anything missing,
 * empty, or relative (`/blog`, `blog.example.com`, `//host`) rejects with
 * an error naming `site.url`.
 */
function siteBaseUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw invalidSiteUrl(raw);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw invalidSiteUrl(raw);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalidSiteUrl(raw);
  }
  if (parsed.host === "") {
    throw invalidSiteUrl(raw);
  }
  // origin never has a trailing slash; the path keeps its segments minus
  // any trailing slashes; search/hash are not part of a base.
  return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}

/** The one rejection every bad `site.url` shares — it must name the key. */
function invalidSiteUrl(raw: unknown): Error {
  return new Error(
    `site.url must be an absolute http:// or https:// URL with a host (got ${describe(raw)})`,
  );
}

/**
 * Join a site-relative URL (`/posts/hi/`, `/`) onto the base — exactly one
 * slash at the junction, no matter how either side is slashed.
 */
function absoluteUrl(base: string, urlPath: string): string {
  return `${base}/${urlPath.replace(/^\/+/, "")}`;
}

/** Entry `<title>`: frontmatter title, else the URL's last segment. */
function titleFor(page: Page): string {
  const raw = page.data.title;
  if (typeof raw === "string" && raw.trim() !== "") return raw;
  const segments = pageOutputFor(page).url
    .split(/[?#]/)[0]
    .split("/")
    .filter((segment) => segment !== "");
  return segments.at(-1) ?? "Untitled";
}

/**
 * The post's full rendered HTML — the same markdown phase
 * `Templates.renderDocument` runs (same link rewriting, same `env.doc`),
 * minus T012's `extendMarkdown` plugins, which `onBuildEnd` cannot reach:
 * the seam hands features no extension array. Never an excerpt, never raw
 * markdown.
 */
function renderedContent(page: Page): string {
  const url = pageOutputFor(page).url;
  const md = createRenderer({ currentUrl: url });
  return md.render(page.content, { doc: page });
}

/** JSON-ish rendering of a bad value for error messages; never throws. */
function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value) ?? "an object";
    } catch {
      return "an object";
    }
  }
  return `a ${typeof value}`;
}
