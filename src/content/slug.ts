/**
 * Pure, unicode-safe slug and URL helpers — the single source of truth for
 * URL shape, consumed by the renderer (T006) and permalink emission (T010).
 *
 * Every export is synchronous and depends only on its arguments: no fs, no
 * config access, no globals.
 */

/**
 * Unicode-safe slug: NFC-normalized and lowercased; whitespace and `_` runs
 * become a single `-`; Unicode letters/numbers survive in any script; all
 * other characters are dropped; `-` runs collapse and the ends are trimmed.
 * Empty result (empty input, punctuation-only input) → `'untitled'`.
 */
export function slugify(input: string): string {
  const slug = input
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\s_]+/gu, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "untitled" : slug;
}

/**
 * Last segment minus its extension, slugified. An `index` basename resolves
 * to the parent directory segment (`about/index.md` → `about`; a bare
 * `index.md` has no directory of its own → `'untitled'`). Both separators
 * are honored, and `./` segments are ignored.
 */
export function slugFromPath(relPath: string): string {
  const segments = relPath
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  const basename = (segments.pop() ?? "").replace(/\.[^.]*$/, "");
  const effective =
    basename.toLowerCase() === "index" ? (segments.pop() ?? "") : basename;
  return slugify(effective);
}

/**
 * Source path → site URL. Normalizes `\` to `/`, drops a trailing
 * `.md`/`.markdown` (case-insensitive) and any `./` prefix, slugifies each
 * segment, and collapses a trailing `index` segment into its directory.
 * The result always starts and ends with `/` (`index.md` → `/`).
 */
export function urlForPath(relPath: string): string {
  const segments = relPath
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .map((segment) => slugify(segment.replace(/\.(?:markdown|md)$/i, "")));
  if (segments.at(-1) === "index") segments.pop();
  return segments.length === 0 ? "/" : `/${segments.join("/")}/`;
}

/**
 * Pretty URL → output path relative to `outDir`. Every pretty URL names a
 * directory whose document is `index.html`; a missing trailing slash is
 * still a directory (`/about` → `about/index.html`).
 */
export function filePathForUrl(url: string): string {
  const dir = url.replace(/^\/+/, "").replace(/\/+$/, "");
  return dir === "" ? "index.html" : `${dir}/index.html`;
}

/**
 * Expand a permalink template: `:slug` from `ctx.slug`; `:year` (4-digit),
 * `:month`/`:day` (2-digit zero-padded) from `ctx.date` via UTC getters, so
 * output never depends on the build machine's timezone. A colon not followed
 * by letters is literal. Unknown `:word` or a date placeholder without
 * `ctx.date` throws. Output is normalized to a leading and trailing `/`.
 */
export function applyPermalink(
  template: string,
  ctx: { slug: string; date?: Date },
): string {
  const expanded = template.replace(/:(\p{L}+)/gu, (_match, word: string) => {
    switch (word) {
      case "slug":
        return ctx.slug;
      case "year":
      case "month":
      case "day": {
        const date = ctx.date;
        if (date === undefined) {
          throw new Error(`placeholder ":${word}" requires a date`);
        }
        if (word === "year") {
          return String(date.getUTCFullYear()).padStart(4, "0");
        }
        const value =
          word === "month" ? date.getUTCMonth() + 1 : date.getUTCDate();
        return String(value).padStart(2, "0");
      }
      default:
        throw new Error(
          `unknown permalink placeholder ":${word}" in "${template}"`,
        );
    }
  });
  const withLeading = expanded.startsWith("/") ? expanded : `/${expanded}`;
  return withLeading.endsWith("/") ? withLeading : `${withLeading}/`;
}
