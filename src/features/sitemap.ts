/**
 * T019 — `dist/sitemap.xml`: one `<url>` per HTML page T010 emitted in this
 * build, as an absolute URL resolved against `site.url`, with `<lastmod>`
 * taken from the source page's frontmatter `date`.
 *
 * The `<loc>` set is exactly `result.emitted` filtered to `.html` targets:
 * non-HTML emissions (`feed.xml`, JSON indexes) never pass the filter, and
 * this file itself is written from `onBuildEnd` so it is never in `emitted`.
 * T013's hidden drafts/future posts are removed from `site.pages` in
 * `onSite` and therefore never reach emit — no re-filtering happens here;
 * the sitemap test pins that pipeline guarantee instead.
 *
 * `site.url` must be an absolute http(s) URL with a host. Missing, empty,
 * or relative values (`/blog`, `blog.example.com`, `//host`) throw before
 * any file is written; the orchestrator records the rejection as a feature
 * error (report + exit 1), never a crash.
 *
 * Hand-rolled XML — no dependencies. Entries are sorted lexicographically
 * by `<loc>` so golden-site snapshots get byte-stable output, and the
 * absolute URLs are produced by the WHATWG URL parser, which percent-encodes
 * T005's unicode path segments the same way browsers do.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "../content/document.ts";
import type { BuildEnd, Feature } from "../feature.ts";
import { pageOutputFor } from "../render/emit.ts";

/** The sitemap protocol namespace on the root element. */
const SITEMAP_NS = "http://www.sitemaps.org/schemas/sitemap/0.9";

/** XML text entities — sitemap content is URLs and dates only. */
const XML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

/** One `<url>` entry: `<loc>` first, then optional `<lastmod>`. */
interface Entry {
  loc: string;
  lastmod?: string;
}

const sitemap: Feature = {
  async onBuildEnd(result: BuildEnd): Promise<void> {
    // Validate first: a bad site.url fails the build with nothing written.
    const base = requireSiteUrl(result.site.data.url);

    // Source page by output file — frontmatter `date` for emitted pages.
    const lastmodByFile = new Map<string, string>();
    for (const page of result.site.pages) {
      const lastmod = lastmodFor(page);
      if (lastmod !== undefined) {
        lastmodByFile.set(pageOutputFor(page).file, lastmod);
      }
    }

    const entries: Entry[] = [];
    for (const emitted of result.emitted) {
      // Only HTML pages: feed.xml / JSON indexes / sitemap.xml itself are
      // not `.html` and are excluded by construction.
      if (!emitted.file.endsWith(".html")) continue;
      entries.push({
        loc: absoluteUrl(base, emitted.url),
        lastmod: lastmodByFile.get(emitted.file),
      });
    }
    entries.sort((a, b) => (a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0));

    await mkdir(result.distDir, { recursive: true });
    await writeFile(
      path.join(result.distDir, "sitemap.xml"),
      renderSitemap(entries),
      "utf8",
    );
  },
};

export default sitemap;

/**
 * `site.url` as an absolute http(s) URL with a host. Every rejection names
 * the key, so the recorded feature error always says `site.url`.
 */
function requireSiteUrl(raw: unknown): URL {
  const got = JSON.stringify(raw) ?? String(raw);
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      const parsed = new URL(raw.trim());
      if (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.host !== ""
      ) {
        return parsed;
      }
    } catch {
      // Relative or unparseable — fall through to the shared error.
    }
  }
  throw new Error(
    `site.url must be an absolute http(s) URL with a host (got ${got})`,
  );
}

/**
 * Resolve one site-relative emitted URL against `site.url`'s origin + path.
 * The base is normalized to a trailing slash before joining, so neither a
 * missing nor a present trailing slash can produce `//` at the seam; the
 * URL parser percent-encodes non-ASCII path characters (`/café/` →
 * `/caf%C3%A9/`), consistently with how browsers map T005's unicode URLs.
 */
function absoluteUrl(base: URL, url: string): string {
  const root = base.href.endsWith("/") ? base.href : `${base.href}/`;
  return new URL(url.replace(/^\/+/, ""), root).href;
}

/**
 * The page's frontmatter `date` as `<lastmod>`, or `undefined` when the
 * page has none (home, tag archives — a valid sitemap, not an error):
 * `YYYY-MM-DD` for date-only dates (frontmatter `2026-01-02` normalizes to
 * UTC midnight), the full ISO 8601 UTC timestamp otherwise.
 */
function lastmodFor(page: Page): string | undefined {
  const { date } = page.data;
  if (!(date instanceof Date)) return undefined;
  const iso = date.toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
}

/** The complete `sitemap.xml` document — declaration, root, entries. */
function renderSitemap(entries: readonly Entry[]): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<urlset xmlns="${SITEMAP_NS}">`,
  ];
  for (const { loc, lastmod } of entries) {
    const safeLoc = loc.replace(/[&<>]/g, (char) => XML_ENTITIES[char]);
    lines.push("  <url>", `    <loc>${safeLoc}</loc>`);
    if (lastmod !== undefined) {
      lines.push(`    <lastmod>${lastmod}</lastmod>`);
    }
    lines.push("  </url>");
  }
  lines.push("</urlset>", "");
  return lines.join("\n");
}
