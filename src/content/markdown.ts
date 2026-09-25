/**
 * Markdown rendering: a configured markdown-it@15 instance plus the
 * `extendMarkdown` seam features (T012+) use to register plugins without the
 * core ever importing or discovering them (concurrency rule 6).
 *
 * GFM tables, strikethrough, and fenced code blocks come from markdown-it's
 * default rule set (`~~…~~` is mapped to the GFM `<del>` tag); raw HTML in
 * the source is escaped (`html: false`) and bare URLs autolink
 * (`linkify: true`). No heading anchors/TOC (T017), no syntax highlighting
 * (T016) — both arrive later through this seam.
 */
import MarkdownItCtor from "markdown-it";
import type { MarkdownIt, RendererRule } from "markdown-it";
import { urlForPath } from "./slug.ts";

/**
 * A markdown-it plugin registration hook — identical in shape to the
 * `Feature.extendMarkdown(md)` hook T012 defines; T012's orchestrator
 * collects the hooks and passes them through {@link RenderOptions.extensions}.
 * Pure registration: applying it configures the instance, it never renders.
 */
export type MarkdownExtension = (md: MarkdownIt) => void;

/** Options shared by {@link createRenderer} and {@link renderMarkdown}. */
export interface RenderOptions {
  /** Plugins applied to the instance in array order, before any rendering. */
  extensions?: MarkdownExtension[];
  /**
   * Pretty URL of the page whose markdown is being rendered, e.g.
   * `/posts/hi/`. Needed to resolve relative `.md` links; when omitted,
   * relative `.md` links are left unchanged (root-relative and external
   * targets are handled the same either way).
   */
  currentUrl?: string;
}

/**
 * Configured markdown-it instance with `options.extensions` already applied
 * in array order — callers may build once and reuse across pages. Installed
 * last, the internal `.md` link rewriting cannot be displaced by a plugin.
 */
export function createRenderer(options?: RenderOptions): MarkdownIt {
  const md = new MarkdownItCtor({
    html: false,
    linkify: true,
    typographer: false,
  });
  // GFM/GitHub render ~~…~~ as <del>; markdown-it 15's strikethrough rule
  // emits tag "s". Installed before extensions so a plugin may override it.
  md.renderer.rules.s_open = () => "<del>";
  md.renderer.rules.s_close = () => "</del>";
  for (const extension of options?.extensions ?? []) extension(md);
  installLinkRewriting(md, options?.currentUrl);
  return md;
}

/**
 * Render `source` to GFM-flavored HTML: create, render, return. Malformed or
 * merely weird markdown degrades to ordinary markdown-it output — this never
 * throws on markdown input.
 */
export function renderMarkdown(
  source: string,
  options?: RenderOptions,
): string {
  return createRenderer(options).render(source);
}

/**
 * Rewrite `href` on every `link_open` token at render time (covers manual
 * links and `linkify` autolinks alike): a `.md`/`.markdown` path becomes the
 * pretty URL from `urlForPath`, preserving query and fragment. Wraps whatever
 * `link_open` rule exists so extension-installed rules keep working.
 */
function installLinkRewriting(
  md: MarkdownIt,
  currentUrl: string | undefined,
): void {
  const previous: RendererRule | undefined = md.renderer.rules.link_open;
  md.renderer.rules.link_open = (tokens, idx, options, env, renderer) => {
    const token = tokens[idx];
    const href = token.attrGet("href");
    if (typeof href === "string") {
      const rewritten = rewriteMarkdownHref(href, currentUrl);
      if (rewritten !== null) token.attrSet("href", rewritten);
    }
    return (
      previous?.(tokens, idx, options, env, renderer) ??
      renderer.renderToken(tokens, idx, options)
    );
  };
}

/**
 * Pretty URL for a `.md` link, or `null` to leave `href` unchanged:
 * - external targets never rewritten — any scheme (`http:`, `mailto:`, …)
 *   or protocol-relative `//host/…`;
 * - root-relative `/guide/setup.md` always becomes `/guide/setup/`;
 * - relative `../about.md` is resolved against {@link directoryOf} of
 *   `currentUrl`, and only then; without `currentUrl` it stays unchanged;
 * - targets not ending in `.md`/`.markdown` (anchors, `notes.txt`) stay
 *   unchanged. Query and fragment ride along untouched either way.
 */
function rewriteMarkdownHref(
  href: string,
  currentUrl: string | undefined,
): string | null {
  const cut = href.search(/[?#]/);
  const path = cut === -1 ? href : href.slice(0, cut);
  const suffix = cut === -1 ? "" : href.slice(cut);
  if (!/\.(?:md|markdown)$/i.test(path)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  if (path.startsWith("//")) return null;
  if (path.startsWith("/")) {
    return urlForPath(resolveWithin("/", path)) + suffix;
  }
  if (currentUrl === undefined) return null;
  return urlForPath(resolveWithin(directoryOf(currentUrl), path)) + suffix;
}

/**
 * Directory containing the page a pretty URL names: query/fragment dropped,
 * trailing slashes removed, last segment cut (`/posts/hi/` → `/posts/`,
 * `/` → `/`). A relative `href` resolves from there, so
 * `/posts/hi/` + `../about.md` → `/about/`.
 */
function directoryOf(url: string): string {
  const cut = url.search(/[?#]/);
  const path = cut === -1 ? url : url.slice(0, cut);
  const trimmed = path.replace(/\/+$/, "");
  const dir = trimmed.slice(0, trimmed.lastIndexOf("/") + 1);
  return dir === "" ? "/" : dir;
}

/**
 * Join a relative `href` onto an absolute directory and normalize `.`/`..`
 * segments (clamped at `/`), so {@link urlForPath} receives a plain absolute
 * path and never sees a `..` it would slugify.
 */
function resolveWithin(dir: string, relative: string): string {
  const segments: string[] = [];
  for (const segment of `${dir}${relative}`.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}
