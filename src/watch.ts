/**
 * Watch mode — T027: `startWatching(config)` observes the project's source
 * roots and turns filesystem events into debounced whole-site rebuilds.
 *
 * Contract highlights:
 * - Rebuilds call T012's exported `build()` directly (never the CLI), with
 *   the project root and default flags; `build()` reloads `kiln.config.ts`
 *   on every invocation, so config edits land on the next rebuild.
 * - One trailing-edge debounce timer spans ALL roots: a burst of saves
 *   across any directories coalesces into exactly one rebuild, and each new
 *   event resets the window (`watch.debounceMs`, T003 key, default 100).
 * - Events arriving while a rebuild runs set a single `queued` flag; when
 *   the running rebuild finishes it starts exactly one follow-up, no matter
 *   how many events piled up.
 * - `outDir` is never a watch root and its events are filtered out anyway,
 *   so writing output can never retrigger a rebuild (no loop). Editor
 *   noise (`*~`, `*.swp`, `*.tmp`, `*.part`) never reaches the timer.
 * - After a successful rebuild, outputs under `outDir` whose content source
 *   no longer exists are pruned through T005's path→URL mapping
 *   (`urlForPath` → `filePathForUrl`); anything that cannot be mapped back
 *   to a source (static assets, feature outputs such as `feed.xml`, …) is
 *   never pruned.
 * - A failed rebuild prints `rebuild failed in <N>ms: <message>` to stderr
 *   and the watcher keeps running; the next change retries. Every attempt
 *   is announced to {@link onAfterRebuild} listeners (T028's seam).
 *
 * No command file lives here: T028 activates watching through `kiln serve`.
 */
import { existsSync, watch } from "node:fs";
import type { Dirent, FSWatcher } from "node:fs";
import { access, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import type { KilnConfig } from "./config.ts";
import { filePathForUrl, urlForPath } from "./content/slug.ts";
import { build } from "./pipeline/build.ts";
import type { BuildReport } from "./pipeline/report.ts";

/** Result of one rebuild attempt, as seen by {@link onAfterRebuild}. */
export interface AfterRebuild {
  /** `true` when `build()` resolved (feature failures are still `ok`). */
  ok: boolean;
  /** Present iff `ok` — T012's report for the rebuild that just ran. */
  report?: BuildReport;
  /** Present iff `!ok` — the value `build()` rejected with. */
  error?: unknown;
}

/** What {@link startWatching} returns. */
export interface WatchHandle {
  /** Stop every watcher and any pending debounce timer; idempotent. */
  close(): Promise<void>;
}

/** Editor temp/backup file suffixes that must never trigger a rebuild. */
const NOISE_PATTERN = /(?:~|\.(?:swp|tmp|part))$/;

/** Basename (or root-relative name) of every page output `emit` writes. */
const INDEX_PAGE = "index.html";

/** Listeners notified after every rebuild attempt; module-global, like the seam. */
const afterRebuildListeners = new Set<(result: AfterRebuild) => void>();

/**
 * Register a listener fired after every rebuild attempt with
 * `{ ok, report? , error? }`. Returns an unsubscribe function; with zero
 * registered listeners the notification is a no-op. A throwing listener is
 * reported to stderr and cannot break the watcher.
 */
export function onAfterRebuild(
  listener: (result: AfterRebuild) => void,
): () => void {
  afterRebuildListeners.add(listener);
  return () => {
    afterRebuildListeners.delete(listener);
  };
}

function notifyAfterRebuild(result: AfterRebuild): void {
  for (const listener of [...afterRebuildListeners]) {
    try {
      listener(result);
    } catch (error) {
      process.stderr.write(`watch: onAfterRebuild listener failed: ${reason(error)}\n`);
    }
  }
}

/**
 * Watch `contentDir`, `templatesDir`, and `publicDir` recursively and
 * rebuild (via T012's `build()`) once per debounced event burst.
 *
 * A missing root is warned about and skipped while the others stay watched;
 * when no root exists at all the call throws an error naming every root.
 */
export function startWatching(config: KilnConfig): WatchHandle {
  const roots = [
    ...new Set([config.contentDir, config.templatesDir, config.publicDir]),
  ];
  const missing = roots.filter((root) => !existsSync(root));
  if (missing.length === roots.length) {
    throw new Error(`watch: no watchable root exists: ${roots.join(", ")}`);
  }
  for (const root of missing) {
    process.stderr.write(`watch: root ${root} does not exist, skipping\n`);
  }

  const debounceMs = config.watch.debounceMs;
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  let building = false;
  let queued = false;
  let closed = false;
  /** Resolves when the current (or last) rebuild settles; awaited by `close()`. */
  let inFlight: Promise<void> | undefined;

  async function rebuild(): Promise<void> {
    building = true;
    const startedAt = Date.now();
    try {
      const report = await build({ cwd: config.root });
      await pruneStaleOutputs(config, report);
      process.stdout.write(`rebuild in ${report.durationMs}ms\n`);
      notifyAfterRebuild({ ok: true, report });
    } catch (error) {
      process.stderr.write(
        `rebuild failed in ${Date.now() - startedAt}ms: ${reason(error)}\n`,
      );
      notifyAfterRebuild({ ok: false, error });
    } finally {
      building = false;
      if (queued && !closed) {
        // Exactly one follow-up: the flag collapses every event that
        // arrived during the rebuild into this single run.
        queued = false;
        inFlight = rebuild();
      }
    }
  }

  /** Trailing-edge debounce: every call resets the single shared timer. */
  function schedule(): void {
    if (closed) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (closed) return;
      if (building) {
        queued = true;
        return;
      }
      inFlight = rebuild();
    }, debounceMs);
  }

  const skipped = new Set(missing);
  try {
    for (const root of roots) {
      if (skipped.has(root)) continue;
      const watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (filename === null) {
          schedule();
          return;
        }
        const name = String(filename);
        if (NOISE_PATTERN.test(name)) return;
        const absolute = path.resolve(root, name);
        if (
          absolute === config.outDir ||
          absolute.startsWith(config.outDir + path.sep)
        ) {
          return; // output writes must never retrigger the watcher
        }
        schedule();
      });
      watcher.on("error", (error) => {
        process.stderr.write(`watch: ${root}: ${reason(error)}\n`);
      });
      watchers.push(watcher);
    }
  } catch (error) {
    // A root that refuses to be watched must not orphan the others.
    for (const watcher of watchers) watcher.close();
    watchers.length = 0;
    throw error;
  }

  return {
    async close(): Promise<void> {
      closed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      for (const watcher of watchers) watcher.close();
      watchers.length = 0;
      // `closed` already forbids starting the queued follow-up, so once the
      // in-flight rebuild settles nothing can outlive this await.
      await inFlight;
    },
  };
}

/**
 * Delete every page-shaped output under `config.outDir` that this rebuild
 * did not (re)produce and whose content source no longer exists. Files that
 * cannot be mapped back to a source — static assets, feature outputs,
 * anything not shaped like an `emit` page — are never touched.
 */
async function pruneStaleOutputs(
  config: KilnConfig,
  report: BuildReport,
): Promise<void> {
  // Live outputs: emitted this run plus cache-skipped (already on disk),
  // then every static asset copy — `public/` sources re-copy each build.
  const keep = new Set<string>();
  for (const out of [...report.emitted, ...report.skipped]) {
    keep.add(out.file);
  }
  const publicFiles: string[] = [];
  await walkFiles(config.publicDir, "", publicFiles);
  for (const rel of publicFiles) keep.add(rel);

  const distFiles: string[] = [];
  await walkFiles(config.outDir, "", distFiles);
  for (const rel of distFiles) {
    if (keep.has(rel)) continue;
    const candidates = candidatesForOutput(rel);
    // Not mappable back to a source shape → never pruned (assets, feature
    // outputs like `feed.xml`, anything outside `emit`'s pretty-path form).
    if (candidates.length === 0) continue;
    if (await sourceStillExists(config, candidates)) continue;
    const target = path.join(config.outDir, rel);
    await rm(target, { force: true });
    await removeEmptyParents(path.dirname(target), config.outDir);
  }
}

/**
 * Could a living content source still produce `rel`? Candidates are the
 * content-relative paths whose T005 mapping (`urlForPath` →
 * `filePathForUrl`) lands exactly on `rel`; one existing candidate keeps
 * the output. An empty list means `rel` cannot be mapped to any source.
 */
async function sourceStillExists(
  config: KilnConfig,
  candidates: string[],
): Promise<boolean> {
  for (const candidate of candidates) {
    if (await fileExists(path.join(config.contentDir, candidate))) {
      return true;
    }
  }
  return false;
}

/**
 * Inverse of T005's mapping: dist-relative file → content-relative sources
 * that map onto it. The forward mapping only ever lands on
 * `index.html` / `<dir>/index.html`, so any other shape yields no
 * candidates — the prune loop's "never touch unmapped outputs" rule.
 */
function candidatesForOutput(rel: string): string[] {
  const url =
    rel === INDEX_PAGE ? "/" : `/${rel.slice(0, -INDEX_PAGE.length)}`;
  const base = url.replace(/^\/+|\/+$/g, "");
  const stems = base === "" ? ["index"] : [base, `${base}/index`];
  const candidates: string[] = [];
  for (const stem of stems) {
    for (const ext of [".md", ".markdown"]) {
      const candidate = `${stem}${ext}`;
      // Keep only candidates the forward mapping really sends to `rel`.
      if (filePathForUrl(urlForPath(candidate)) === rel) {
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

/** Recursively collect regular files under `dir` as POSIX paths relative to it. */
async function walkFiles(
  dir: string,
  prefix: string,
  into: string[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // missing or unreadable directory → nothing to collect
  }
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await walkFiles(path.join(dir, entry.name), rel, into);
    } else if (entry.isFile()) {
      into.push(rel); // symlinks and others: not ours to prune
    }
  }
}

/** Remove now-empty directories left behind by a prune, stopping at `stopAt`. */
async function removeEmptyParents(dir: string, stopAt: string): Promise<void> {
  let current = dir;
  while (current !== stopAt && current.startsWith(stopAt + path.sep)) {
    try {
      await rmdir(current);
    } catch {
      return; // not empty or already gone
    }
    current = path.dirname(current);
  }
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** Failure text for a thrown value, mirroring `src/cli.ts`. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
