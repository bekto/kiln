/**
 * Permalink emission: every {@link Page} of a {@link Site} rendered through
 * T009's template engine and written to its pretty-path `.html` target under
 * `dist/` (`/posts/my-post/` → `dist/posts/my-post/index.html`).
 *
 * Nothing renders or writes before a full pre-scan of `site.pages` proves
 * the run safe:
 * - every page's absolute target must sit strictly inside
 *   `path.resolve(distDir)`, so a hostile `permalink` (`/../../escape/`)
 *   fails the build with nothing created outside `dist/`;
 * - no two pages may resolve to the same output file (duplicate guard).
 *
 * The plan preserves `site.pages` order, and so do the result's
 * `emitted`/`skipped` lists. `shouldSkip` is the cache-hit seam T012/T029
 * wire in: a page is skipped only when its target file already exists, so a
 * stale or lying cache can never leave a hole in the output tree.
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page, Site } from "../content/document.ts";
import type { MarkdownExtension } from "../content/markdown.ts";
import {
  applyPermalink,
  filePathForUrl,
  slugFromPath,
  urlForPath,
} from "../content/slug.ts";
import { loadTemplates, pageView } from "./templates.ts";

/** One page's output pairing: its URL and the dist-relative POSIX file. */
export interface EmittedPage {
  url: string;
  file: string;
}

/** Result of one {@link emitPages} run; both lists follow `site.pages` order. */
export interface EmitResult {
  emitted: EmittedPage[];
  skipped: EmittedPage[];
}

/** Everything {@link emitPages} needs beyond the site itself. */
export interface EmitOptions {
  /** Output directory; defaults to `'dist'`, resolved against the cwd. */
  distDir?: string;
  /** T012's feature markdown plugins (T006 seam); omitted → plain. */
  extensions?: MarkdownExtension[];
  /** Extra top-level render context (T012 passes `collections`/`flags`). */
  extra?: Record<string, unknown>;
  /** Cache seam: `true` + an existing target file → skip render and write. */
  shouldSkip?: (page: Page) => boolean;
}

/**
 * Pure URL→file pairing for one page — no fs, no globals. The page's own
 * `url` wins; a page without one falls back to T005's permalink expansion
 * (feature-appended pages carrying only `data.permalink`/`path`) and then
 * to `urlForPath(path)`. `file` is the pretty-path mapping: a directory URL
 * names its `index.html`, always POSIX and relative to the dist root.
 */
export function pageOutputFor(page: Page): EmittedPage {
  const permalink = page.data.permalink;
  const url =
    page.url ??
    (permalink
      ? applyPermalink(permalink as string, {
          slug: slugFromPath(page.path),
          date: page.data.date instanceof Date ? page.data.date : undefined,
        })
      : urlForPath(page.path));
  return { url, file: filePathForUrl(url) };
}

/**
 * Render every page of `site` and write it to `distDir` (default `'dist'`).
 *
 * Order of operations: pre-scan all pages for containment and duplicate
 * output files, then build the site template context once, then per page —
 * in order — either record a cache skip (`shouldSkip` + existing file) or
 * render through T009, `mkdir -p` the parent, and write UTF-8 (overwriting
 * an existing file). Zero pages short-circuit to an empty success without
 * touching the filesystem. Write failures reject with an error naming the
 * target path; template/render failures reject with T009's own messages.
 */
export async function emitPages(
  site: Site,
  options: EmitOptions,
): Promise<EmitResult> {
  // Nothing to emit: no render, no writes, and dist/ must not appear.
  if (site.pages.length === 0) {
    return { emitted: [], skipped: [] };
  }

  const distRoot = path.resolve(options.distDir ?? "dist");

  // Pre-scan — before any render or write: every target strictly inside
  // distRoot, and no two pages resolving to the same output file.
  const byTarget = new Map<string, string>();
  const plans = site.pages.map((page) => {
    const out = pageOutputFor(page);
    const target = path.resolve(distRoot, out.file);
    const relative = path.relative(distRoot, target);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        `refusing to write outside dist: ${out.url} → ${out.file} (${page.path})`,
      );
    }
    const firstUrl = byTarget.get(target);
    if (firstUrl !== undefined) {
      throw new Error(
        `duplicate output file: ${out.file} (urls: ${firstUrl}, ${out.url})`,
      );
    }
    byTarget.set(target, out.url);
    return { page, out, target };
  });

  const templates = await loadTemplates();
  const siteContext: Record<string, unknown> = {
    ...site.data,
    pages: site.pages.map(pageView),
  };

  const emitted: EmittedPage[] = [];
  const skipped: EmittedPage[] = [];
  for (const { page, out, target } of plans) {
    if (options.shouldSkip?.(page) === true) {
      const exists = await stat(target).then(() => true, () => false);
      if (exists) {
        // Cache hit: the existing bytes stay untouched.
        skipped.push(out);
        continue;
      }
      // Missing target defeats the skip — a lying cache cannot leave a hole.
    }
    const html = await templates.renderDocument(page, {
      url: out.url,
      site: siteContext,
      extensions: options.extensions,
      extra: options.extra,
    });
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, html, "utf8");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${target}: ${reason}`, { cause: error });
    }
    emitted.push(out);
  }
  return { emitted, skipped };
}
