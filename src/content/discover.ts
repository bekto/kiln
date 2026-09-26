/**
 * Content discovery — the input half of the build pipeline: walk the content
 * directory, parse every Markdown document (T004), assign its URL (T005) and
 * stamp its collection, and return one deterministic {@link Site}.
 *
 * Reads only: no writes, no config, no templates/`public/`.
 */
import { constants } from "node:fs";
import { access, glob, stat } from "node:fs/promises";
import path from "node:path";
import { readDocument } from "./document.ts";
import type { Document, Page, Site } from "./document.ts";
import { applyPermalink, slugFromPath, urlForPath } from "./slug.ts";
import { KilnError, projectRelative } from "../errors.ts";

/** Markdown file extensions, matched case-insensitively. */
const MARKDOWN_EXT = /\.(?:md|markdown)$/i;

/**
 * Find every Markdown document under `contentDir` (absolute or cwd-relative)
 * and assemble them into a {@link Site}.
 *
 * Hidden and underscore-prefixed segments relative to `contentDir` are never
 * content; symlinks get no special handling — whatever the glob yields runs
 * through the same rules. Rejects with `content directory not found: <abs>`
 * when `contentDir` is missing/unreadable, `no markdown files found under
 * <abs>` when it holds no matching file, and with T004's own errors (carrying
 * the absolute source path) on parse failures. Returned pages are sorted
 * ascending by `path` in codepoint order, so two runs over the same tree
 * yield identical sequences.
 *
 * `onError` is the error sink T031's collector passes: with it, every broken
 * document is recorded (files are read in sorted order, so the recorded order
 * is deterministic) and discovery continues to the next file — N broken
 * documents produce N collected errors, and a tree holding only broken
 * documents yields an empty site instead of `no markdown files found`.
 * Without it, existing callers keep the original fail-fast rejection.
 */
export async function discover(options: {
  contentDir: string;
  onError?: (error: KilnError) => void;
}): Promise<Site> {
  const dir = path.resolve(options.contentDir);
  await assertDiscoverable(dir);

  // Sorted before reading: both pages and collected errors come out in
  // deterministic path order, not glob order.
  const files: { filePath: string; relPath: string }[] = [];
  for await (const entry of glob(path.join(dir, "**/*"), {
    withFileTypes: true,
  })) {
    // Regular files only: directories, symlinks, etc. fall out of the same
    // uniform rule — no symlink-specific handling.
    if (!entry.isFile()) continue;
    const filePath = path.join(entry.parentPath, entry.name);
    const relPath = path.relative(dir, filePath).split(path.sep).join("/");
    if (
      relPath
        .split("/")
        .some((segment) => segment.startsWith(".") || segment.startsWith("_"))
    ) {
      continue;
    }
    if (!MARKDOWN_EXT.test(entry.name)) continue;
    files.push({ filePath, relPath });
  }
  files.sort((a, b) => compareCodepoints(a.relPath, b.relPath));

  const pages: Page[] = [];
  let collected = false;
  for (const { filePath, relPath } of files) {
    try {
      pages.push(makePage(await readDocument(filePath), relPath));
    } catch (error) {
      if (options.onError === undefined) throw error;
      collected = true;
      options.onError(
        error instanceof KilnError
          ? error
          : new KilnError(
              "frontmatter",
              error instanceof Error ? error.message : String(error),
              { file: projectRelative(filePath), cause: error },
            ),
      );
    }
  }

  if (pages.length === 0 && !collected) {
    throw new Error(`no markdown files found under ${dir}`);
  }
  pages.sort((a, b) => compareCodepoints(a.path, b.path));
  return { pages, data: {} };
}

/**
 * The content directory must exist, be a directory, and be readable —
 * otherwise discovery reports it as missing instead of silently yielding an
 * empty site.
 */
async function assertDiscoverable(dir: string): Promise<void> {
  const info = await stat(dir).catch(() => undefined);
  const isDir = info?.isDirectory() ?? false;
  const isReadable =
    isDir &&
    (await access(dir, constants.R_OK | constants.X_OK).then(
      () => true,
      () => false,
    ));
  if (!isReadable) {
    throw new Error(`content directory not found: ${dir}`);
  }
}

/**
 * Turn one parsed document into a {@link Page}: assign the URL (a
 * `permalink` template goes through T005, otherwise T005's default mapping)
 * and stamp collection membership when the frontmatter did not set it. A
 * user-provided `collection` is preserved verbatim — T008 validates it later.
 */
function makePage(doc: Document, relPath: string): Page {
  const data = doc.data;
  let url: string;
  if ("permalink" in data) {
    const permalink = data.permalink;
    if (typeof permalink !== "string") {
      throw new KilnError(
        "frontmatter",
        `${doc.path}: "permalink" must be a string (got ${describeType(permalink)})`,
        { file: projectRelative(doc.path) },
      );
    }
    try {
      url = applyPermalink(permalink, {
        slug: slugFromPath(relPath),
        date: data.date instanceof Date ? data.date : undefined,
      });
    } catch (error) {
      // T005's message is precise but silent about the file — prefix it so
      // the failure names its source, matching T004's error style.
      const reason = error instanceof Error ? error.message : String(error);
      throw new KilnError("frontmatter", `${doc.path}: ${reason}`, {
        file: projectRelative(doc.path),
        cause: error,
      });
    }
  } else {
    url = urlForPath(relPath);
  }
  if (!("collection" in data)) {
    data.collection = relPath.startsWith("posts/") ? "posts" : "pages";
  }
  return { ...doc, url };
}

/** Type name for error messages, mirroring `src/config.ts` and T004. */
function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Ascending Unicode codepoint order. Plain `<` compares UTF-16 code units,
 * which disagree with codepoint order where surrogate pairs meet the
 * U+E000–U+FFFF range; spreading to codepoints keeps the sort total and
 * identical across runs.
 */
function compareCodepoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i++) {
    const x = left[i].codePointAt(0) ?? 0;
    const y = right[i].codePointAt(0) ?? 0;
    if (x !== y) return x - y;
  }
  return left.length - right.length;
}
