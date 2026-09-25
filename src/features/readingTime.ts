/**
 * Reading time & word count (T021) — `onDocument` gives every document
 * integer `words` and `readingTime` metrics before markdown/layout render,
 * so templates read them straight off `page.words` / `page.readingTime`
 * (T009's `pageView` spreads `doc.data`) and listings can show word counts
 * with no client-side work. The same values are mirrored as top-level
 * `doc.words` / `doc.readingTime`, the literal placement the ticket names.
 *
 * Counting (T021) — plain visible text only:
 * - fenced code blocks are dropped first (no word count of code blocks;
 *   frontmatter is already outside `doc.content`);
 * - HTML comments and tags are removed, and inline markdown syntax
 *   (images/links keep their text, code spans, emphasis, strikethrough) is
 *   unwrapped, so markup never counts as words (`<code>x</code>` → 1);
 * - the rest splits on Unicode whitespace (`\s` with the `u` flag) into
 *   tokens where every CJK character (Han, Hiragana, Katakana, Hangul)
 *   counts as one word and each maximal run of non-CJK characters counts
 *   as one word (`hello world` → 2, `你好世界` → 4, `Hello, 世界` → 3,
 *   `中文abc` → 3, `don't` → 1);
 * - block markers stay tokens — the spec's `# Heading` → 2 words example
 *   pins that `#` is counted.
 *
 * Reading time is `max(1, ceil(words / wordsPerMinute))`: ceiling rounding
 * only (conservative, never rounds down) and never below one minute, so an
 * empty document is `words: 0`, `readingTime: 1`.
 *
 * Config: `features.readingTime.wordsPerMinute` — positive integer, default
 * `200`; an invalid value throws with the full key in the message and
 * `ctx.options` re-throws it prefixed `features.readingTime: `, which T012
 * records as a build-failing feature error. Self-contained: only its own
 * config slice and the documents it is handed.
 */
import type { Feature } from "../feature.ts";

/** `features.readingTime.wordsPerMinute` when the key is absent. */
const DEFAULT_WORDS_PER_MINUTE = 200;

/** Unicode whitespace split — spaces, tabs, newlines, Unicode space separators. */
const WHITESPACE = /\s+/u;

/** One CJK character (Han, Hiragana, Katakana, Hangul) — each is its own word. */
const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/**
 * An HTML tag: a name-led open/close/self-closing marker. Replaced by a
 * space so `word<br>word` splits into two words while prose `<` (a < b) and
 * autolink URLs (`<https://…>`) pass through as text.
 */
const HTML_TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g;

/** Any (possibly indented) opening-or-closing fence line's marker run. */
const FENCE = /^[ \t]*(`{3,}|~{3,})/;

/** A closing line: the whole line is fence markers only (no info string). */
const CLOSING_FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

const feature: Feature = {
  onDocument(doc, ctx) {
    // Validate the config first: an invalid wordsPerMinute fails the build
    // before this document is counted or touched.
    const wordsPerMinute = ctx.options(readWordsPerMinute);
    const words = countWords(visibleText(doc.content));
    const readingTime = Math.max(1, Math.ceil(words / wordsPerMinute));
    // The data bag is what T009's pageView hands templates (`page.words`);
    // the top-level mirror is the ticket's literal `doc.words` placement.
    doc.data.words = words;
    doc.data.readingTime = readingTime;
    Object.assign(doc, { words, readingTime });
  },
  onSite(_site, ctx) {
    // An empty site never runs onDocument — validate the slice here too so
    // an invalid wordsPerMinute always fails the build, documents or not.
    ctx.options(readWordsPerMinute);
  },
};

export default feature;

/**
 * The document's plain visible text: fenced code blocks dropped (T021's
 * "no word count of code blocks"), HTML comments/tags removed, inline
 * markdown unwrapped to its text. Images keep their alt text and links
 * their label; block markers are left alone.
 */
function visibleText(markdown: string): string {
  const text = withoutFencedCode(markdown)
    .replace(HTML_COMMENT, " ")
    .replace(HTML_TAG, " ");
  return (
    text
      // Images before links so `![alt](url)` yields the alt, not a stray `!`.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      // Word guards keep identifiers like `snake_case_word` intact.
      .replace(/(?<!\w)_([^_]+)_(?!\w)/g, "$1")
      .replace(/~~([^~]+)~~/g, "$1")
  );
}

/**
 * Drop fenced code blocks — open through the first same-character close of
 * at least the opening length, or to end of input when never closed. Lines
 * outside fences pass through byte-identical.
 */
function withoutFencedCode(markdown: string): string {
  const kept: string[] = [];
  let fenceChar = "";
  let fenceLength = 0;
  for (const line of markdown.split("\n")) {
    const marker = FENCE.exec(line);
    if (fenceChar === "") {
      if (marker === null) kept.push(line);
      else {
        fenceChar = marker[1].charAt(0);
        fenceLength = marker[1].length;
      }
    } else if (
      marker !== null &&
      marker[1].charAt(0) === fenceChar &&
      marker[1].length >= fenceLength &&
      CLOSING_FENCE.test(line)
    ) {
      fenceChar = "";
    }
  }
  return kept.join("\n");
}

/**
 * Unicode-aware word count over plain text: split on Unicode whitespace,
 * then per token count every CJK character as one word and each maximal run
 * of non-CJK characters as one word.
 */
function countWords(text: string): number {
  let words = 0;
  for (const token of text.split(WHITESPACE)) {
    if (token === "") continue;
    let inNonCjkRun = false;
    for (const character of token) {
      if (CJK.test(character)) {
        inNonCjkRun = false;
        words += 1;
      } else if (!inNonCjkRun) {
        inNonCjkRun = true;
        words += 1;
      }
    }
  }
  return words;
}

/** `features.readingTime.wordsPerMinute`: positive integer, default 200. */
function readWordsPerMinute(raw: unknown): number {
  if (raw === undefined) return DEFAULT_WORDS_PER_MINUTE;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `"features.readingTime" must be a plain object (got ${describe(raw)})`,
    );
  }
  const wordsPerMinute = (raw as { wordsPerMinute?: unknown }).wordsPerMinute;
  if (wordsPerMinute === undefined) return DEFAULT_WORDS_PER_MINUTE;
  if (
    typeof wordsPerMinute !== "number" ||
    !Number.isInteger(wordsPerMinute) ||
    wordsPerMinute <= 0
  ) {
    throw new Error(
      `"features.readingTime.wordsPerMinute" must be a positive integer (got ${describe(wordsPerMinute)})`,
    );
  }
  return wordsPerMinute;
}

/** Failure detail: primitives show themselves, containers show their type. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return typeof value;
}
