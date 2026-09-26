import { readFile } from "node:fs/promises";
import matter from "gray-matter";
import { KilnError, projectRelative } from "../errors.ts";

/**
 * One Markdown source file parsed into frontmatter and body. `data` is fully
 * open — frontmatter stays unvalidated and each feature reads its own fields
 * (concurrency rule 5: T004 never narrows the bag).
 */
export interface Document {
  /** Absolute path of the source file this document was parsed from. */
  path: string;
  /** Parsed frontmatter (empty object when the file has none). */
  data: Record<string, unknown>;
  /** Markdown body with the frontmatter fences removed. */
  content: string;
}

/** A document plus the final URL it is served at (URL production: T005/T007/T010). */
export interface Page extends Document {
  /** Site-relative URL this page is published under, e.g. `/posts/hello/`. */
  url: string;
}

/** Site-level container: all pages plus an open bag for site metadata. */
export interface Site {
  pages: Page[];
  /** Site metadata (T012 seeds it from config); open like `Document.data`. */
  data: Record<string, unknown>;
}

/**
 * Parse raw Markdown text (frontmatter + body) into a `Document`. Pure and
 * synchronous: no I/O, no shared state.
 *
 * Errors always name the file:
 * - invalid YAML → `<path>: invalid frontmatter at line N: <reason>`
 * - sequence/scalar frontmatter → `<path>: frontmatter must be a YAML mapping`
 * - unparseable `date` → `<path>: "date" must be a valid date (got <type>)`
 */
export function parseDocument(filePath: string, raw: string): Document {
  // gray-matter memoizes results without options and hands the same `data`
  // object back by reference — pass options so every parse is standalone.
  let parsed;
  try {
    parsed = matter(raw, {});
  } catch (error) {
    throw frontmatterError(filePath, error);
  }

  // d.ts claims `data` is a mapping; the YAML engine actually returns
  // whatever the document is (array/scalar for non-mapping frontmatter).
  const data: unknown = parsed.data;
  if (!isMapping(data)) {
    throw new KilnError(
      "frontmatter",
      `${filePath}: frontmatter must be a YAML mapping`,
      { file: projectRelative(filePath) },
    );
  }
  normalizeDate(filePath, data);
  return { path: filePath, data, content: parsed.content };
}

/** Read `filePath` and parse it with {@link parseDocument}. */
export async function readDocument(filePath: string): Promise<Document> {
  const raw = await readFile(filePath, "utf8");
  return parseDocument(filePath, raw);
}

/** YAML mapping: a plain object, never an array/scalar/timestamp. */
function isMapping(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Type name for error messages, mirroring `src/config.ts`. */
function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Wrap the YAML parser's exception so the message carries the file path and
 * the parser's 1-based line position. gray-matter hands js-yaml the raw
 * frontmatter block including the newline after the opening `---`, so
 * js-yaml's line numbers line up with the file's. The structured fields
 * mirror those numbers exactly (`col` only when the parser reports one).
 */
function frontmatterError(filePath: string, error: unknown): KilnError {
  const file = projectRelative(filePath);
  if (typeof error === "object" && error !== null) {
    const { mark, reason } = error as {
      mark?: { line?: unknown; column?: unknown };
      reason?: unknown;
    };
    if (typeof mark === "object" && mark !== null && typeof mark.line === "number") {
      const detail = typeof reason === "string" ? reason : "invalid YAML";
      return new KilnError(
        "frontmatter",
        `${filePath}: invalid frontmatter at line ${mark.line + 1}: ${detail}`,
        {
          file,
          line: mark.line + 1,
          ...(typeof mark.column === "number" ? { col: mark.column + 1 } : {}),
          cause: error,
        },
      );
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return new KilnError("frontmatter", `${filePath}: invalid frontmatter: ${message}`, {
    file,
    cause: error,
  });
}

/**
 * Validate and normalize `data.date` in place: an existing `Date` is kept, a
 * string becomes one (`new Date()`, date-only strings parse as UTC). Absent
 * `date` stays absent — later tickets decide fallbacks.
 */
function normalizeDate(filePath: string, data: Record<string, unknown>): void {
  if (!("date" in data)) return;
  const value = data.date;
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : undefined;
  if (date === undefined || Number.isNaN(date.getTime())) {
    throw new KilnError(
      "frontmatter",
      `${filePath}: "date" must be a valid date (got ${describeType(value)})`,
      { file: projectRelative(filePath) },
    );
  }
  data.date = date;
}
