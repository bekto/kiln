/**
 * T017 — heading anchors & table of contents.
 *
 * `extendMarkdown` registers one markdown-it core rule (runs after the
 * `inline` rule, so heading children are parsed) that — per render, with all
 * state local to the invocation:
 *
 * - assigns every `h1`–`h6` a slugified `id`: T005's unicode-safe
 *   `slugify` over the heading's plain text (inline markup stripped —
 *   `` `code` ``, links, emphasis — images contribute nothing), made unique
 *   **within the page** by suffixing `-2`, `-3`, … on repeats (an empty
 *   result falls back to `section`, deduped the same way);
 * - when `env.doc` is present (T012's `md.render(content, { doc })` seam),
 *   writes the depth-filtered entries (`level <= features.toc.depth`) to
 *   `doc.data.toc` as `{ level, text, id, url }`, visible to layouts as
 *   `page.toc`; anchors are assigned regardless of depth, only the TOC list
 *   is filtered;
 * - when — and only when — that TOC is non-empty, appends the partial name
 *   `"toc.html"` to `doc.data.injectBody`, so `templates/base.html`'s body
 *   slot includes `templates/partials/toc.html` (shared layouts untouched).
 *
 * `features.toc.depth` (integer 2–3, default 3) is read through
 * `ctx.options(...)`, so a bad value fails the build with a message
 * prefixed `features.toc: `. It is validated eagerly in `onSite` too: the
 * markdown hook only runs once a page renders, but a misconfigured site
 * must fail even when nothing is emitted.
 */
import type { MarkdownIt, StateCore, Token } from "markdown-it";
import type { Feature } from "../feature.ts";
import type { Site } from "../content/document.ts";
import type { Page } from "../content/document.ts";
import { slugify } from "../content/slug.ts";

/** One table-of-contents row, stored on `doc.data.toc` → `page.toc`. */
interface TocEntry {
  level: number;
  text: string;
  id: string;
  url: string;
}

/** The `features.toc` slice: `depth` only, defaulting when absent. */
function validateOptions(raw: unknown): { depth: number } {
  if (raw === undefined || raw === null) return { depth: 3 };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `options must be an object (got ${Array.isArray(raw) ? "array" : typeof raw})`,
    );
  }
  const depth = (raw as { depth?: unknown }).depth;
  if (depth === undefined) return { depth: 3 };
  if (!Number.isInteger(depth) || (depth !== 2 && depth !== 3)) {
    throw new Error(
      `depth must be an integer in 2..3 (got ${String(depth)})`,
    );
  }
  return { depth };
}

const feature: Feature = {
  extendMarkdown(md: MarkdownIt, ctx): void {
    const { depth } = ctx.options(validateOptions);
    md.core.ruler.push("kiln_toc", (state) => {
      annotateHeadings(state, depth);
    });
  },

  onSite(_site: Site, ctx): void {
    // Eager validation: `extendMarkdown` only fires once a page renders,
    // so an empty site still has to reject a bad `features.toc.depth`.
    ctx.options(validateOptions);
  },
};

/**
 * The core rule body — every piece of state (the per-page slug set, the
 * TOC rows) is created here, so rebuilds never accumulate suffixes and the
 * same heading on two pages gets the bare slug on both.
 */
function annotateHeadings(state: StateCore, depth: number): void {
  // T012 renders with `env = { doc: page }`; a bare `md.render(src)` (no
  // env doc) still gets anchor ids, just no TOC data or injection.
  const doc = state.env.doc as Page | undefined;
  const pageUrl = doc !== undefined && typeof doc.url === "string" ? doc.url : "";

  const used = new Set<string>();
  const toc: TocEntry[] = [];
  const tokens = state.tokens;

  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i];
    if (open.type !== "heading_open") continue;
    const inline = tokens[i + 1];
    const text =
      inline !== undefined && inline.type === "inline" ? plainText(inline) : "";
    const id = uniqueId(text === "" ? "section" : slugify(text), used);
    open.attrSet("id", id);
    if (doc !== undefined) {
      const level = Number(open.tag.slice(1));
      if (level <= depth) {
        toc.push({ level, text, id, url: `${pageUrl}#${id}` });
      }
    }
  }

  if (doc === undefined || toc.length === 0) return;
  doc.data.toc = toc;
  const injected = Array.isArray(doc.data.injectBody)
    ? [...doc.data.injectBody]
    : [];
  if (!injected.includes("toc.html")) injected.push("toc.html");
  doc.data.injectBody = injected;
}

/**
 * A heading's plain text: `text`/`code_inline` content (emphasis, links and
 * other markup live in their surrounding tags, which carry none), soft/hard
 * breaks as spaces. Images contribute nothing — an image-only heading is
 * "empty" and falls back to `section`.
 */
function plainText(inline: Token): string {
  let text = "";
  for (const child of inline.children ?? []) {
    if (
      child.type === "text" ||
      child.type === "text_special" ||
      child.type === "code_inline"
    ) {
      text += child.content;
    } else if (child.type === "softbreak" || child.type === "hardbreak") {
      text += " ";
    }
  }
  return text.trim();
}

/**
 * Page-scoped uniqueness: the first occurrence keeps the bare slug, later
 * ones take the first free `-2`, `-3`, … suffix (so a literal `## Setup-2`
 * heading reserves that id and the second `## Setup` skips to `-3`).
 */
function uniqueId(base: string, used: Set<string>): string {
  let candidate = base;
  for (let n = 2; used.has(candidate); n++) {
    candidate = `${base}-${n}`;
  }
  used.add(candidate);
  return candidate;
}

export default feature;
