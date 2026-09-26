/**
 * `kiln new` — scaffold a content file in the right collection with valid
 * frontmatter (T004) and a unicode-safe slug filename (T005), and never
 * clobber an existing file. Discovered by T002's auto-discovery;
 * `src/cli.ts` never names this file.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.ts";
import { parseDocument } from "../content/document.ts";
import { slugify } from "../content/slug.ts";

export const name = "new";
export const description = "Create a new content file";

const USAGE = "usage: kiln new <title> [--dir <pages|posts>]";

/** Usage error: reason + usage on stderr, exit 2 — caller returns before any write. */
function usageError(reason: string): void {
  process.stderr.write(`kiln: ${name}: ${reason}\n${USAGE}\n`);
  process.exitCode = 2;
}

/** ISO 8601 now at second precision with the local UTC offset (no milliseconds). */
function timestampNow(): string {
  const now = new Date();
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/**
 * Render the new file's bytes: frontmatter with `title` verbatim, an ISO 8601
 * now-timestamp at second precision, `draft: true`, then an empty body and a
 * trailing newline. The plain title form from the ticket's example is used
 * when T004's reader hands the title back unchanged; otherwise the title
 * becomes a JSON string (valid YAML). Implicit YAML types (`null`, `true`,
 * `123`, dates) and layout indicators never win, because the title round-trips
 * by construction instead of by reimplementing YAML's resolver rules.
 */
function scaffold(title: string): string {
  const tail = `date: ${timestampNow()}\ndraft: true\n---\n`;
  for (const scalar of [title, JSON.stringify(title)]) {
    const content = `---\ntitle: ${scalar}\n${tail}`;
    try {
      if (parseDocument("kiln new", content).data.title === title) return content;
    } catch {
      // This scalar doesn't parse; fall through to the quoted form.
    }
  }
  throw new Error(`cannot render title as YAML: ${JSON.stringify(title)}`);
}

export async function run(args: string[]): Promise<void> {
  // Every non-flag token joins into the title; --dir <value> is consumed.
  let dir = "posts";
  const titleTokens: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dir") {
      const value = args[i + 1];
      i += 1;
      if (value === undefined) {
        usageError("--dir requires a value");
        return;
      }
      if (value !== "pages" && value !== "posts") {
        usageError(`--dir must be one of: pages, posts (got '${value}')`);
        return;
      }
      dir = value;
    } else if (arg.startsWith("--")) {
      usageError(`unknown argument '${arg}'`);
      return;
    } else {
      titleTokens.push(arg);
    }
  }

  const title = titleTokens.join(" ");
  if (title.trim() === "") {
    usageError("title is required");
    return;
  }

  const content = scaffold(title);
  const config = await loadConfig();
  const target = path.join(config.contentDir, dir, `${slugify(title)}.md`);
  const rel = path.relative(process.cwd(), target);
  const shown =
    rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
      ? target
      : rel;

  await mkdir(path.dirname(target), { recursive: true });
  try {
    // Exclusive create: an existing file is refused byte-identical, never truncated.
    await writeFile(target, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`${shown} already exists`);
    }
    throw error;
  }
  process.stdout.write(`created ${shown}\n`);
}
