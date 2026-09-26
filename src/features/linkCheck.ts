/**
 * T032 — internal link checker: after every build, every `.html` file
 * under `dist/` (recursive) is scanned for internal `href`/`src` links and
 * same-page/cross-page
 * `#anchors`, and one aggregated plain `Error` fails the build with the
 * full `source page → broken target` list. The check is offline by
 * construction: this module performs no network I/O of any kind — every
 * scheme-bearing href (`https:`, `http:`, `mailto:`, `tel:`, `javascript:`,
 * `data:`, …) and every protocol-relative `//host/…` reference is skipped
 * before anything resolves or stats it.
 *
 * Raw-text regions — HTML comments, `<pre>`, `<code>`, `<script>` — are
 * stripped first, so escaped samples
 * (`<code>&lt;a href="/fake/"&gt;</code>`) and JS string literals never
 * yield phantom links. Only quoted attribute values count (`href="…"`,
 * `href='…'`, `src="…"`, `src='…'`); the emitter always quotes attributes,
 * so unquoted values are ignored.
 *
 * Resolution — T005's one mapping, no second pretty-path scheme:
 * - the `#fragment` is split off first and handled separately, the rest
 *   resolves against the containing page's emitted URL through the WHATWG
 *   `URL` API (dummy origin), and `?query` disappears with `pathname`;
 * - the decoded pathname maps to `dist/` either as an exact file (last
 *   segment contains `.`: `/feed.xml`, `/search-index.json`,
 *   `/images/x.png`) or through `filePathForUrl` (directory-style and
 *   extensionless URLs: `/tags/foo/` → `tags/foo/index.html`, `/about` →
 *   `about/index.html`);
 * - existence is the plain case-sensitive filesystem check, so `/About/`
 *   is broken when only `/about/` was emitted;
 * - a fragment then needs `id="…"` (T017 heading ids) or `<a name="…">`
 *   in an HTML target, compared after `decodeURIComponent` (a malformed
 *   escape compares literally, so unicode heading ids work); a fragment on
 *   a non-HTML target is existence-only; fragment-only links are checked
 *   against the page being scanned.
 *
 * One sanctioned exception to at-scan-time existence: `/sitemap.xml` and
 * `/assets/search.js` are written by `sitemap.ts` and `search.ts` from
 * their own `onBuildEnd` hooks, which T012's sorted-filename order runs
 * AFTER `linkCheck.ts` (`"l" < "s"`). They are guaranteed same-build
 * outputs that cannot exist yet at scan time — failing them would also
 * stop the very hook loop that would write them, deadlocking every build
 * that links them. Every other target, including `/feed.xml` (feed.ts runs
 * before this hook), is existence-checked for real.
 *
 * Reporting: the scan always completes (no fail-fast), deduped to one
 * entry per (source page, resolved target), ordered by source URL:
 *
 * ```text
 * 2 broken internal links:
 *   1. /posts/hello/ → /tags/nonexistent/ (href="/tags/nonexistent/")
 *   2. /posts/hello/ → /about/#missing (href="/about/#missing")
 * ```
 *
 * Zero broken links → no output, exit 0; empty `dist/` or a site with no
 * internal links is a no-op.
 *
 * Config (`features.linkCheck`, validated here through `ctx.options`, so
 * failures surface with the full key path; both default to `[]`):
 * - `allow: string[]` — globs matched against the **resolved target URL**
 *   of a would-be-broken link; a match forgives it (looked at, broken,
 *   excused — never reported);
 * - `exclude: string[]` — globs matched against the **raw href or the
 *   source page URL**; a match skips the link entirely (never resolved,
 *   never checked).
 * Globs are matched with Node's built-in `path.matchesGlob`.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { filePathForUrl } from "../content/slug.ts";
import type { BuildEnd, Feature, FeatureContext } from "../feature.ts";

/**
 * Exact-file targets this hook cannot see yet — see the file header:
 * same-build outputs of features whose `onBuildEnd` runs after ours in
 * T012's sorted-filename order, and therefore structurally absent at scan
 * time. Not excused: anything a hook that already ran has written
 * (`feed.xml`, `hljs.css`, `search-index.json` — written in `onSite`) or
 * that landed with the asset copy (`public/**`, hash-busted names).
 */
const SAME_BUILD_OUTPUTS: Readonly<Record<string, true>> = {
  "/sitemap.xml": true,
  "/assets/search.js": true,
};

/** Dummy hierarchical origin for the WHATWG resolver — never contacted. */
const ORIGIN = "kiln://check";

/**
 * Quoted `href`/`src` attribute values only. The lookbehind excludes
 * lookalikes (`data-href`, `xlink:href`); `srcset` never matches because
 * `src` must be followed by `=`.
 */
const LINK_ATTR = /(?<![-\w])(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/** Scheme or protocol-relative reference — skipped entirely, never checked. */
const EXTERNAL = /^(?:[a-z][a-z0-9+\-.]*:|\/\/)/i;

/** One aggregated report line's worth of a broken link. */
interface BrokenLink {
  /** Source page URL, e.g. `/posts/hello/`. */
  readonly source: string;
  /**
   * Resolved target as reported: the decoded path, plus `#fragment` when
   * an HTML target exists but the anchor does not.
   */
  readonly target: string;
  /** The raw href exactly as it appears in the markup. */
  readonly href: string;
}

/** Validated `features.linkCheck` slice. */
interface LinkCheckOptions {
  readonly allow: readonly string[];
  readonly exclude: readonly string[];
}

const feature: Feature = { onBuildEnd };
export default feature;

/**
 * Validate config, then scan every emitted HTML file. A broken-link
 * report is thrown as one plain `Error` carrying the whole list — T012's
 * hook contract records it as a feature failure (exit 1), and later
 * harnesses wrap it verbatim.
 */
async function onBuildEnd(
  result: BuildEnd,
  ctx: FeatureContext,
): Promise<void> {
  const { allow, exclude } = ctx.options(readOptions);

  // Subpath hosting: pages link as `/kiln/…` while dist files are rooted at
  // `/`, so resolution strips the prefix before mapping to files/anchors.
  const basePath =
    typeof result.site.data.basePath === "string"
      ? result.site.data.basePath
      : "";
  const files = await htmlFilesUnder(result.distDir);
  const anchors = new Map<string, Set<string>>();
  const broken = new Map<string, BrokenLink>();
  for (const file of files) {
    const html = await readFile(path.join(result.distDir, file), "utf8");
    const source = sourceUrlFor(file);
    const text = stripRawRegions(html);
    for (const raw of quotedLinkValues(text)) {
      // exclude: raw href or source page URL → skip before anything else.
      if (matchesAny(exclude, raw) || matchesAny(exclude, source)) continue;
      const link = raw.trim();
      if (EXTERNAL.test(link)) continue;
      const hit = await inspectLink(
        result.distDir,
        file,
        source,
        link,
        anchors,
        basePath,
      );
      if (hit === undefined) continue;
      if (matchesAny(allow, hit.target)) continue;
      const key = `${source}\0${hit.target}`;
      if (!broken.has(key)) {
        broken.set(key, { source, target: hit.target, href: raw });
      }
    }
  }
  if (broken.size === 0) return;

  const entries = [...broken.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : 0,
  );
  throw new Error(formatBroken(entries));
}

/**
 * Check one internal reference; `undefined` means fine (or not checkable).
 * `link` is the trimmed href — external forms never reach here; the raw
 * value stays with the caller for reporting. `basePath` is the hosting
 * subpath carried by prefixed hrefs (`/kiln/…`); it is stripped from the
 * resolved path so a subpath site maps onto the same dist tree a root site
 * would (fragment-only references never carry it).
 */
async function inspectLink(
  distDir: string,
  file: string,
  source: string,
  link: string,
  anchors: Map<string, Set<string>>,
  basePath: string,
): Promise<{ target: string } | undefined> {
  const hash = link.indexOf("#");
  const pathPart = hash === -1 ? link : link.slice(0, hash);
  const fragment = hash === -1 ? undefined : link.slice(hash + 1);

  // Fragment-only → same-page anchor check against the file in hand.
  if (pathPart === "") {
    if (fragment === undefined || fragment === "") return undefined;
    const anchor = decodePart(fragment);
    const known = await anchorsFor(distDir, file, anchors);
    if (known.has(anchor)) return undefined;
    return { target: `${source}#${anchor}` };
  }

  let resolved: string;
  try {
    resolved = new URL(pathPart, `${ORIGIN}${source}`).pathname;
  } catch {
    return undefined; // unparseable reference — nothing sound to check
  }
  if (
    basePath !== "" &&
    (resolved === basePath || resolved.startsWith(`${basePath}/`))
  ) {
    resolved = resolved.slice(basePath.length) || "/";
  }
  const targetPath = decodePart(resolved);
  const segments = targetPath.split("/");
  // An encoded traversal (`..%2f…` decodes to `../…`) cannot map to a
  // dist-relative file — same bucket as an unparseable reference.
  if (segments.includes("..") || segments.includes(".")) return undefined;

  const exact =
    !targetPath.endsWith("/") && (segments.at(-1) ?? "").includes(".");
  const targetFile = exact
    ? targetPath.replace(/^\/+/, "")
    : filePathForUrl(targetPath);

  if (!Object.hasOwn(SAME_BUILD_OUTPUTS, targetPath)) {
    if (!(await fileExists(path.join(distDir, targetFile)))) {
      // Missing file wins: report the file, never its fragment.
      return { target: targetPath };
    }
  }
  if (fragment === undefined || fragment === "") return undefined;
  // Fragment on a non-HTML target (feed.xml, an image) is existence-only.
  if (exact && !targetFile.toLowerCase().endsWith(".html")) return undefined;

  const anchor = decodePart(fragment);
  const known = await anchorsFor(distDir, targetFile, anchors);
  if (known.has(anchor)) return undefined;
  return { target: `${targetPath}#${anchor}` };
}

/**
 * `features.linkCheck`: an optional object whose `allow`/`exclude` are
 * arrays of glob strings. T012's `ctx.options` re-throws any failure
 * prefixed `features.linkCheck: `, and each message below names its exact
 * key so the surfaced text always carries `features.linkCheck.allow` /
 * `features.linkCheck.exclude`.
 */
function readOptions(raw: unknown): LinkCheckOptions {
  if (raw === undefined) return { allow: [], exclude: [] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `expected an object like { allow?: string[], exclude?: string[] } (got ${describeType(raw)})`,
    );
  }
  const record = raw as { allow?: unknown; exclude?: unknown };
  return {
    allow: readGlobList(record.allow, "allow"),
    exclude: readGlobList(record.exclude, "exclude"),
  };
}

/** One `string[]` config key: absent → `[]`, wrong shape → named error. */
function readGlobList(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(
      `features.linkCheck.${key} must be an array of strings (got ${describeType(value)})`,
    );
  }
  const globs: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const element: unknown = value[index];
    if (typeof element !== "string") {
      throw new Error(
        `features.linkCheck.${key} must contain only strings (element ${index} is ${describeType(element)})`,
      );
    }
    globs.push(element);
  }
  return globs;
}

/** Type name for config-error messages. */
function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** The aggregated report — one numbered entry per broken link. */
function formatBroken(entries: readonly BrokenLink[]): string {
  const noun =
    entries.length === 1 ? "broken internal link" : "broken internal links";
  const lines = entries.map(
    (entry, index) =>
      `  ${index + 1}. ${entry.source} → ${entry.target} (href=${JSON.stringify(entry.href)})`,
  );
  return `${entries.length} ${noun}:\n${lines.join("\n")}`;
}

/**
 * Every `.html` file under `dist/`, dist-relative POSIX, sorted — the
 * scan's source set (emitted and cache-skipped pages alike, both live on
 * disk). A missing `dist/` is the empty scan, not an error.
 */
async function htmlFilesUnder(distDir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const dir = rel === "" ? distDir : path.join(distDir, rel);
    const entries = await readdir(dir, { withFileTypes: true }).catch(
      (error: unknown) => {
        if (
          rel === "" &&
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return undefined;
        }
        throw error;
      },
    );
    if (entries === undefined) return;
    for (const entry of entries) {
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (entry.name.endsWith(".html")) found.push(child);
    }
  };
  await walk("");
  return found.sort();
}

/** `dist/`-relative file → the URL it is served at. */
function sourceUrlFor(file: string): string {
  if (file === "index.html") return "/";
  if (file.endsWith("/index.html")) {
    return `/${file.slice(0, -"index.html".length)}`;
  }
  return `/${file}`;
}

/**
 * Drop raw-text regions — comments, `<pre>`, `<code>`, `<script>` — so
 * escaped markup samples and script string literals never produce links
 * or phantom anchor targets. The same stripped text feeds both link
 * extraction and anchor collection.
 */
function stripRawRegions(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<pre\b[\s\S]*?<\/pre\s*>/gi, " ")
    .replace(/<code\b[\s\S]*?<\/code\s*>/gi, " ")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ");
}

/** Quoted `href`/`src` values of one stripped document, in document order. */
function* quotedLinkValues(text: string): Generator<string> {
  for (const match of text.matchAll(LINK_ATTR)) {
    yield match[1] ?? match[2] ?? "";
  }
}

/** `id="…"`/`id='…'` and `<a name="…">` targets of one stripped document. */
function collectAnchors(text: string): Set<string> {
  const ids = new Set<string>();
  const patterns = [
    /(?<![-\w])id\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
    /<a\b[^>]*?(?<![-\w])name\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1] ?? match[2];
      if (value !== undefined) ids.add(value);
    }
  }
  return ids;
}

/** Anchor set of one target file — read once, then cached per scan. */
async function anchorsFor(
  distDir: string,
  file: string,
  cache: Map<string, Set<string>>,
): Promise<Set<string>> {
  const hit = cache.get(file);
  if (hit !== undefined) return hit;
  const html = await readFile(path.join(distDir, file), "utf8");
  const ids = collectAnchors(stripRawRegions(html));
  cache.set(file, ids);
  return ids;
}

/** Percent-decode, guarding malformed escapes → compare literally. */
function decodePart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Does any glob in `patterns` match `value`? */
function matchesAny(patterns: readonly string[], value: string): boolean {
  return patterns.some((pattern) => {
    try {
      return path.matchesGlob(value, pattern);
    } catch {
      return false; // a malformed pattern excuses/skips nothing
    }
  });
}

/** Existence probe: any stat failure counts as absent. */
async function fileExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
