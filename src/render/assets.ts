/**
 * Static asset passthrough: mirror `public/` into `dist/` verbatim.
 *
 * Files are skipped when the destination is already up to date (mtime-based,
 * by design — content-hash invalidation belongs to a later layer), a source
 * whose target is a page emitted this build is reported as a collision and
 * never written, and the opt-in hash-bust mode renames copies to
 * `name.<8 hex sha256>.ext` and rewrites exact root-relative `src`/`href`
 * references in the emitted HTML.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Stats } from "node:fs";
import { cp, glob, mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

/** Options accepted by {@link copyAssets}. */
export interface AssetOptions {
  /** Source directory; relative values resolve against the cwd. Default `'public'`. */
  publicDir?: string;
  /** Destination directory; relative values resolve against the cwd. Default `'dist'`. */
  distDir?: string;
  /**
   * Dist-relative POSIX paths of pages emitted this build. A source whose
   * copy target is in this set is reported as a collision and never written;
   * hash-bust rewriting may still edit those pages' `src`/`href` attributes.
   */
  emitted?: ReadonlySet<string>;
  /** Copy to `name.<8 hex sha256 of content>.ext` names and rewrite HTML references. Default `false`. */
  hashBust?: boolean;
}

/** Result of one {@link copyAssets} run. Path lists are dist-relative POSIX. */
export interface AssetReport {
  /** Files written this run. */
  copied: string[];
  /** Files not written: already up to date, or a symlink with an unreadable target. */
  skipped: string[];
  /** Sources whose copy target is an emitted page — reported, never written. */
  collisions: string[];
  /** HTML files whose bytes changed during hash-bust reference rewriting. */
  rewritten: number;
}

/**
 * Copy every regular file under `publicDir` into `distDir`, preserving the
 * directory structure. A missing or empty `publicDir` resolves an all-zero
 * report; write failures reject with an error naming the failing path.
 */
export async function copyAssets(options: AssetOptions = {}): Promise<AssetReport> {
  const publicDir = path.resolve(options.publicDir ?? "public");
  const distDir = path.resolve(options.distDir ?? "dist");
  const { emitted, hashBust = false } = options;
  const report: AssetReport = { copied: [], skipped: [], collisions: [], rewritten: 0 };

  const { files, broken } = await walk(publicDir);
  report.skipped.push(...broken);

  /** Source-rel → hashed dist-rel, for hash-bust assets copied this run only. */
  const rewrites = new Map<string, string>();

  for (const file of files) {
    const hash = hashBust ? await hashFile(file.abs) : undefined;
    const targetRel = hash === undefined ? file.rel : withHash(file.rel, hash);

    // The emitted guard runs before the mtime skip: a static file aimed at a
    // page this build emitted must be reported as a collision even when the
    // emitted page happens to look "up to date".
    if (emitted !== undefined && emitted.has(targetRel)) {
      report.collisions.push(targetRel);
      continue;
    }

    const destAbs = path.join(distDir, ...targetRel.split("/"));
    if (await isUpToDate(destAbs, file.mtimeMs)) {
      report.skipped.push(targetRel);
      continue;
    }

    await copyOne(file.abs, destAbs, file.atimeMs, file.mtimeMs);
    report.copied.push(targetRel);
    if (hash !== undefined) rewrites.set(file.rel, targetRel);
  }

  if (rewrites.size > 0) {
    report.rewritten = await rewriteReferences(distDir, rewrites);
  }

  report.copied.sort();
  report.skipped.sort();
  report.collisions.sort();
  return report;
}

/** A regular file discovered under the tree, with its source timestamps. */
interface WalkedFile {
  rel: string;
  abs: string;
  atimeMs: number;
  mtimeMs: number;
}

interface WalkResult {
  files: WalkedFile[];
  /** Entries whose `stat` failed — symlinks whose target is unreadable. */
  broken: string[];
}

/**
 * Recursively enumerate regular files under `root`, using `fs.promises.glob()`
 * to list each directory's direct children.
 *
 * Node's glob treats `*` as "does not start with a dot", so a conventional
 * recursive sweep would silently drop dotfiles (`.nojekyll`) and never
 * descend into hidden directories; globbing `{*,.*}` per directory keeps the
 * mirror literal with no exclusion globs. Only `entry.isDirectory()` triggers
 * descent, and that is an lstat-based check — so symlinked directories are
 * never followed. Classification uses `stat()` (follows symlinks) so a
 * broken symlink lands in `broken` instead of failing the run.
 */
async function walk(root: string): Promise<WalkResult> {
  const files: WalkedFile[] = [];
  const broken: string[] = [];

  async function visit(dir: string, relBase: string): Promise<void> {
    for await (const entry of glob("{*,.*}", { cwd: dir, withFileTypes: true })) {
      if (entry.name === "." || entry.name === "..") continue;
      const rel = relBase === "" ? entry.name : `${relBase}/${entry.name}`;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(abs, rel);
        continue;
      }
      let target: Stats;
      try {
        target = await stat(abs);
      } catch {
        broken.push(rel);
        continue;
      }
      // Directories behind a symlink and non-regular files (FIFOs, sockets)
      // are not regular files, so they are neither copied nor reported.
      if (target.isFile()) {
        files.push({ rel, abs, atimeMs: target.atimeMs, mtimeMs: target.mtimeMs });
      }
    }
  }

  await visit(root, "");
  return { files, broken };
}

/** First 8 hex characters of the sha256 of the file's content. */
async function hashFile(abs: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(abs)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex").slice(0, 8);
}

/** `img/logo.png` + `abcd1234` → `img/logo.abcd1234.png`. */
function withHash(rel: string, hash: string): string {
  const { dir, name, ext } = path.parse(rel);
  const prefix = dir === "" ? "" : `${dir}/`;
  return `${prefix}${name}.${hash}${ext}`;
}

/** True when the destination exists and its mtime is at least the source's. */
async function isUpToDate(destAbs: string, sourceMtimeMs: number): Promise<boolean> {
  try {
    return (await stat(destAbs)).mtimeMs >= sourceMtimeMs;
  } catch {
    return false;
  }
}

/** Copy one file, then reject with an error naming the failing path on failure. */
async function copyOne(srcAbs: string, destAbs: string, atimeMs: number, mtimeMs: number): Promise<void> {
  try {
    await mkdir(path.dirname(destAbs), { recursive: true });
    await cp(srcAbs, destAbs, { preserveTimestamps: true, dereference: true });
    // fs.cp truncates preserved timestamps to whole milliseconds, which would
    // leave dest.mtimeMs < source mtimeMs (the fraction was lost) and force a
    // recopy on every run. Rounding up to the next millisecond makes the
    // `dest.mtimeMs >= source.mtimeMs` skip rule exact and stable.
    await utimes(destAbs, atimeMs / 1000, Math.ceil(mtimeMs) / 1000);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`copyAssets: failed to copy ${srcAbs} to ${destAbs}: ${reason}`, { cause: error });
  }
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrite exact root-relative `src`/`href` references in the HTML files under
 * `dist/` to their hash-busted targets; returns how many files' bytes changed.
 * Files are read and written as latin1 so every unmodified byte round-trips
 * untouched and string inequality equals byte inequality.
 */
async function rewriteReferences(distDir: string, mapping: Map<string, string>): Promise<number> {
  const alternatives = [...mapping.keys()].map(escapeRegExp).join("|");
  // The closing-quote requirement lets one alternation serve overlapping names
  // (`app.js` vs `app.js.map`) — the engine backtracks until the quotes line
  // up, so ref captured in group 3 is always a whole map key. The lookbehind
  // keeps lookalike attributes (`data-src=`) out; external URLs, protocol-
  // relative URLs and query strings break the quote alignment and never match.
  const reference = new RegExp(`((?<![\\w-])(?:src|href)\\s*=\\s*)(["'])/(${alternatives})\\2`, "g");

  const { files } = await walk(distDir);
  let rewritten = 0;
  for (const file of files) {
    if (!file.rel.endsWith(".html")) continue;
    const before = await readFile(file.abs, "latin1");
    const after = before.replace(reference, (_match, prefix, quote, ref) => {
      const target = mapping.get(ref)!;
      return `${prefix}${quote}/${target}${quote}`;
    });
    if (after === before) continue;
    await writeFile(file.abs, after, "latin1");
    rewritten += 1;
  }
  return rewritten;
}
