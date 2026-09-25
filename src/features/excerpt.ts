/**
 * Excerpts (T020) — attach a plain-text `excerpt` to every document in
 * `onDocument`, before markdown/layout render, so listings, archives,
 * feeds, and search always have a safe one-line summary and raw markup can
 * never leak into one.
 *
 * Precedence: a frontmatter `excerpt` string wins verbatim — trimmed of
 * surrounding whitespace only, never truncated, never given an ellipsis —
 * even when it is longer than the body or the cap. A non-string
 * frontmatter value fails the build with an error naming the `excerpt`
 * field and the source file; an empty or whitespace-only value counts as
 * absent.
 *
 * Derivation: the body's first non-empty top-level paragraph. Headings,
 * lists, blockquotes, tables, code fences, and paragraphs nested inside
 * them never contribute; an HTML block contributes its inner text with
 * tags stripped. A private markdown-it instance tokenizes the body with
 * `html: true`, so source tags surface as droppable `html_inline`/
 * `html_block` tokens while their visible words stay behind as `text`
 * tokens (entities already decoded); emphasis markers, link syntax (the
 * link text survives), and code-span backticks arrive as plain
 * `text`/`code_inline` content. The result is plain text — raw markup
 * never appears in `doc.excerpt`.
 *
 * Cap: `features.excerpt.length` — positive integer, default `260`,
 * counted in Unicode code points (an emoji counts once; a surrogate pair
 * is never split). Longer excerpts cut at the last whitespace at or before
 * the cap (trailing whitespace trimmed) and append `…` (U+2026); with no
 * whitespace inside the cap they cut at the cap exactly. Text at or under
 * the cap is returned whole, without an ellipsis. The slice is validated
 * through `ctx.options`, so an invalid length fails the build with an
 * error naming `features.excerpt.length` (recorded by the pipeline as a
 * feature error, never thrown from `build()`).
 *
 * The value is written both as `doc.excerpt` — the Document field this
 * ticket exposes to templates and downstream features — and into
 * `doc.data.excerpt`, which T009's `pageView` spreads into template
 * context. An empty document (or no prose paragraph at all) yields `""`,
 * never `undefined`.
 *
 * Self-contained: it reads only its own config key and the document it is
 * handed; the markdown-it instance is private, so auto-discovery order
 * never matters.
 */
import MarkdownItCtor from "markdown-it";
import type { MarkdownIt, Token } from "markdown-it";
import type { Document } from "../content/document.ts";
import type { Feature } from "../feature.ts";

/** A Document plus the plain-text `excerpt` this feature attaches. */
type ExcerptedDocument = Document & { excerpt: string };

/** Default `features.excerpt.length` when the config key is absent. */
const DEFAULT_LENGTH = 260;

/**
 * The feature's own renderer — never T009's, never a plugin's.
 * `html: true` is what keeps source tags tokenized as `html_inline`
 * (dropped below) instead of merging them into `text` (which would leak
 * them into the excerpt).
 */
const md: MarkdownIt = new MarkdownItCtor({ html: true });

const feature: Feature = {
  onDocument(doc, ctx) {
    // Validate config first: an invalid length fails the build before any
    // document is touched (recorded as a feature error, not thrown out of
    // build()).
    const maxLength = ctx.options(readLength);

    const raw = doc.data["excerpt"];
    let excerpt: string;
    if (raw === undefined || raw === null) {
      excerpt = derive(doc.content, maxLength);
    } else if (typeof raw === "string") {
      const trimmed = raw.trim();
      excerpt = trimmed === "" ? derive(doc.content, maxLength) : trimmed;
    } else {
      // Type name for the message — mirroring `src/config.ts`'s describeType.
      const shown = Array.isArray(raw) ? "array" : typeof raw;
      throw new Error(
        `${doc.path}: frontmatter "excerpt" must be a string (got ${shown})`,
      );
    }

    // The Document field templates and downstream features read, plus the
    // data-bag copy T009's pageView spreads into template context — so a
    // derived excerpt reaches templates exactly like a frontmatter one.
    doc.data["excerpt"] = excerpt;
    (doc as ExcerptedDocument).excerpt = excerpt;
  },
};

export default feature;

/**
 * Plain text for `content`'s first non-empty top-level paragraph, capped
 * at `maxLength` code points. Candidates are tried in source order — the
 * first one that survives as non-empty text wins; no prose at all → `""`.
 */
function derive(content: string, maxLength: number): string {
  const tokens = md.parse(content, {});
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    let plain: string;
    if (token.type === "paragraph_open" && token.level === 0) {
      // markdown-it's paragraph shape: paragraph_open, inline, paragraph_close.
      plain = plainFromInline(tokens[i + 1]);
    } else if (token.type === "html_block" && token.level === 0) {
      plain = plainFromHtml(token.content);
    } else {
      // Heading/fence/table at top level, everything else nested in a
      // blockquote or list (level > 0) — none of it is a prose paragraph.
      continue;
    }
    if (plain !== "") return capAt(plain, maxLength);
  }
  return "";
}

/**
 * Plain text from one `inline` token: `text` carries the visible words
 * (markdown-it already decoded HTML entities into it), `code_inline` is a
 * code span's contents, and an `image`'s content is its alt text — the
 * caption that reads alongside the paragraph. Breaks become spaces
 * (collapsed later). `html_inline` is only ever a tag, and the
 * emphasis/link open-close markers carry no text of their own — the words
 * around them are separate `text` tokens, which is how `[label](url)`
 * keeps `label` while the syntax disappears.
 */
function plainFromInline(inline: Token | undefined): string {
  const parts: string[] = [];
  for (const child of inline?.children ?? []) {
    switch (child.type) {
      case "text":
      case "code_inline":
      case "image":
        parts.push(child.content);
        break;
      case "softbreak":
      case "hardbreak":
        parts.push(" ");
        break;
      case "html_inline":
        break; // a tag — its visible words are neighboring text tokens
      default:
        break; // em/strong/link open & close markers
    }
  }
  return parts.join("").replace(/\s+/g, " ").trim();
}

/**
 * Plain text from an `html_block` token's raw source: tags and comments
 * become spaces (block boundaries read as word breaks), then the remainder
 * runs through the same inline pass so entities decode exactly the way
 * markdown-it decodes them inside paragraphs.
 */
function plainFromHtml(raw: string): string {
  const stripped = raw.replace(
    /<\/?[a-zA-Z][^<>]*>|<!--[\s\S]*?-->|<![^>]*>/g,
    " ",
  );
  return plainFromInline(md.parseInline(stripped, {})[0]);
}

/**
 * Cap `text` at `maxLength` Unicode code points on a word boundary: the
 * last whitespace at or before the cap ends the excerpt (trailing
 * whitespace trimmed, `…` appended); with no whitespace inside the cap,
 * cut at the cap exactly and append `…`. At or under the cap → returned
 * whole, no ellipsis.
 */
function capAt(text: string, maxLength: number): string {
  const points = [...text]; // by code point — never splits a surrogate pair
  if (points.length <= maxLength) return text;
  let cut = -1;
  for (let i = maxLength; i > 0; i -= 1) {
    if (/\s/.test(points[i])) {
      cut = i;
      break;
    }
  }
  if (cut === -1) return points.slice(0, maxLength).join("") + "…";
  return points.slice(0, cut).join("").trimEnd() + "…";
}

/**
 * `features.excerpt.length`: a positive integer, default 260. Failures
 * carry the full key path — T012's `ctx.options` prefixes them
 * `features.excerpt: ` on the way out.
 */
function readLength(raw: unknown): number {
  if (raw === undefined) return DEFAULT_LENGTH;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    const shown = raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw;
    throw new Error(`"features.excerpt" must be a plain object (got ${shown})`);
  }
  const length = (raw as { length?: unknown }).length;
  if (length === undefined) return DEFAULT_LENGTH;
  if (typeof length !== "number" || !Number.isInteger(length) || length <= 0) {
    // A number shows itself (`0`, `1.5`, `NaN`); a non-number shows its
    // type — mirroring `src/config.ts`'s `describeType`.
    const shown =
      typeof length === "number"
        ? String(length)
        : length === null
          ? "null"
          : Array.isArray(length)
            ? "array"
            : typeof length;
    throw new Error(
      `"features.excerpt.length" must be a positive integer (got ${shown})`,
    );
  }
  return length;
}
