/**
 * T029 — build cache: the `src/pipeline/cache.ts` half of T012's
 * `BuildCache` seam. `createCache()` reads `dist/.kiln-cache.json` once and
 * returns the pair `build()` wires in: `shouldSkip(page)` before render/write
 * (emit additionally requires the target file to exist) and `record(page,
 * outFile)` after each successful write, which persists write-through via an
 * atomic temp-file + rename.
 *
 * Invalidation has two layers, both required for a skip:
 *
 * - Per page: the SHA-256 of the source file's bytes. Feature-appended pages
 *   (`pagination:/page/2/`, `taxonomy:/tags/…`) have no file on disk, so they
 *   fall back to hashing their own render inputs (path, url, content, data).
 * - Global (any mismatch discards every entry → full rebuild): the sorted
 *   `src/features/*.ts` list hashed with module code, the effective T003
 *   config from `loadConfig(siteDir)` minus runtime-only keys (`root`,
 *   `port`, `watch` — dev-server/watcher consumers, not build inputs), the
 *   `drafts`/`future` build flags (toggling either must never serve entries
 *   produced in the other mode), and every file under `templatesDir`.
 *
 * Data problems never fail a build: a missing, corrupt, truncated, or
 * wrong-shape cache file is silently discarded (full rebuild, re-recorded
 * entries heal the file); an unexpected failure in `createCache` degrades to
 * always-render behavior; `record()` persistence errors are swallowed
 * (entries simply not written). `--no-cache` never reaches this module —
 * T012 skips the dynamic import entirely.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.ts";
import type { Page } from "../content/document.ts";
import type { BuildFlags } from "../feature.ts";
import { pageOutputFor } from "../render/emit.ts";
import type { BuildCache, BuildOptions } from "./build.ts";

/** Cache filename inside the dist directory. */
const CACHE_FILE = ".kiln-cache.json";

/** Cache-file format marker; a different version is discarded wholesale. */
const VERSION = 1;

/** Absolute `src/features/` resolved from this module, as in `./features.ts`. */
const FEATURES_DIR = fileURLToPath(new URL("../features/", import.meta.url));

/** Options `build.ts`'s `loadCache` passes to `createCache`. */
export interface CreateCacheOptions {
  siteDir: string;
  distDir: string;
  templatesDir: string;
  flags?: BuildOptions["flags"];
}

/** One cached page: the source's SHA-256 content hash. */
interface Entry {
  hash: string;
}

/** Parsed cache file: global-input hash + output path → entry. */
interface CacheFile {
  version: number;
  global: string;
  pages: Record<string, Entry>;
}

/** The full-rebuild fallback when cache data cannot be prepared. */
const UNCACHED: BuildCache = {
  shouldSkip: () => false,
  record: () => {},
};

/**
 * Build the cache handle for one `build()` run: hash the global inputs,
 * read `dist/.kiln-cache.json` once, and drop every stored entry when the
 * stored global hash does not match this run's. Never rejects — any
 * unexpected failure returns {@link UNCACHED} so the build proceeds uncached.
 */
export async function createCache(
  options: CreateCacheOptions,
): Promise<BuildCache> {
  try {
    const flags: BuildFlags = {
      drafts: options.flags?.drafts ?? false,
      future: options.flags?.future ?? false,
      noCache: options.flags?.noCache ?? false,
    };
    const global = await globalHash(options.siteDir, options.templatesDir, flags);
    const stored = readCacheFile(options.distDir);
    // Corrupt/missing file → undefined; global mismatch → discard all.
    const pages =
      stored !== undefined && stored.global === global ? stored.pages : {};
    return makeCache(options.distDir, global, pages);
  } catch {
    return UNCACHED;
  }
}

/** The live cache handle over an in-memory entry map. */
function makeCache(
  distDir: string,
  global: string,
  pages: Record<string, Entry>,
): BuildCache {
  const file: CacheFile = { version: VERSION, global, pages };

  // Write-through: atomic temp-file + rename, silent on any fs failure so
  // an interrupted or unwritable run never fails the build or half-writes
  // the cache.
  const persist = (): void => {
    try {
      mkdirSync(distDir, { recursive: true });
      const temp = path.join(distDir, `${CACHE_FILE}.${process.pid}.tmp`);
      writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
      renameSync(temp, path.join(distDir, CACHE_FILE));
    } catch {
      // Unwritable cache data → entries not persisted; this build's
      // in-memory decisions stand.
    }
  };

  return {
    shouldSkip(page: Page): boolean {
      const out = pageOutputFor(page).file;
      const entry = pages[out];
      if (entry === undefined) return false;
      // Belt: emit re-checks existence; a missing target never skips.
      if (!existsSync(path.join(distDir, out))) return false;
      const hash = sourceHash(page);
      return hash !== undefined && hash === entry.hash;
    },
    record(page: Page, outFile: string): void {
      const hash = sourceHash(page);
      if (hash === undefined) return; // unverifiable → never becomes skippable
      pages[outFile] = { hash };
      persist();
    },
  };
}

/**
 * Hash every global build input: feature modules + their code, the
 * effective config (via `loadConfig`, minus runtime-only keys), the
 * drafts/future flags, and all template files.
 */
async function globalHash(
  siteDir: string,
  templatesDir: string,
  flags: BuildFlags,
): Promise<string> {
  const hash = createHash("sha256");
  hash.update("kiln-cache-global-v1\0");

  hash.update("features\0");
  hash.update(featuresHash());

  const config = await loadConfig(siteDir);
  const { root: _root, port: _port, watch: _watch, ...buildConfig } = config;
  hash.update("config\0");
  hash.update(stableJson(buildConfig));
  hash.update("\0");

  hash.update("flags\0");
  hash.update(stableJson({ drafts: flags.drafts, future: flags.future }));
  hash.update("\0");

  hash.update("templates\0");
  hash.update(templatesHash(templatesDir));
  hash.update("\0");

  return hash.digest("hex");
}

/** SHA-256 over the sorted top-level `src/features/*.ts` names and bytes. */
function featuresHash(): string {
  const hash = createHash("sha256");
  try {
    const names = readdirSync(FEATURES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name)
      .sort();
    for (const name of names) {
      hash.update(name);
      hash.update("\0");
      hash.update(readFileSync(path.join(FEATURES_DIR, name)));
      hash.update("\0");
    }
  } catch {
    // No readable features directory → same "no features" hash discovery uses.
  }
  return hash.digest("hex");
}

/** SHA-256 over every file under `templatesDir`, keyed by relative path. */
function templatesHash(templatesDir: string): string {
  const hash = createHash("sha256");
  try {
    for (const rel of listTemplateFiles(templatesDir)) {
      hash.update(rel);
      hash.update("\0");
      hash.update(readFileSync(path.join(templatesDir, rel)));
      hash.update("\0");
    }
  } catch {
    // Unreadable/absent templates → a stable empty hash; emit fails later
    // if templates are truly needed, before any entry could be recorded.
  }
  return hash.digest("hex");
}

/** All files under `dir` as POSIX-relative paths, sorted at every level. */
function listTemplateFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (relative: string): void => {
    const entries = readdirSync(path.join(dir, relative), {
      withFileTypes: true,
    });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = relative === "" ? entry.name : `${relative}/${entry.name}`;
      // Symlinks resolve (a symlinked templates root or partial); a broken
      // symlink stats undefined and is skipped.
      const target = entry.isSymbolicLink()
        ? statSync(path.join(dir, rel), { throwIfNoEntry: false })
        : entry;
      if (target?.isDirectory() === true) walk(rel);
      else if (target?.isFile() === true) found.push(rel);
    }
  };
  walk("");
  return found;
}

/**
 * The page's content hash: the source file's bytes when it exists, else a
 * canonical hash of the page's own render inputs (feature-appended pages
 * like `pagination:/page/2/` carry synthetic paths). `undefined` means the
 * page can never be skipped.
 */
function sourceHash(page: Page): string | undefined {
  if (path.isAbsolute(page.path)) {
    try {
      return createHash("sha256").update(readFileSync(page.path)).digest("hex");
    } catch {
      // Source vanished mid-build → fall through to the render-input hash.
    }
  }
  try {
    const inputs = stableJson({
      path: page.path,
      url: page.url ?? null,
      content: page.content,
      data: page.data,
    });
    return createHash("sha256").update(inputs).digest("hex");
  } catch {
    return undefined; // unserializable (circular) data → rebuild every time
  }
}

/** Read and validate `dist/.kiln-cache.json`; anything wrong → undefined. */
function readCacheFile(distDir: string): CacheFile | undefined {
  let raw: string;
  try {
    raw = readFileSync(path.join(distDir, CACHE_FILE), "utf8");
  } catch {
    return undefined; // missing or unreadable → silent full rebuild
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined; // corrupt or truncated → silent full rebuild
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined; // wrong shape → silent full rebuild
  }
  const stored = parsed as Record<string, unknown>;
  if (stored.version !== VERSION || typeof stored.global !== "string") {
    return undefined;
  }
  if (
    typeof stored.pages !== "object" ||
    stored.pages === null ||
    Array.isArray(stored.pages)
  ) {
    return undefined;
  }
  // Entries with a bad shape are dropped individually: that page rebuilds
  // and re-records, healing the file.
  const pages: Record<string, Entry> = {};
  for (const [file, entry] of Object.entries(
    stored.pages as Record<string, unknown>,
  )) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { hash?: unknown }).hash === "string"
    ) {
      pages[file] = { hash: (entry as { hash: string }).hash };
    }
  }
  return { version: VERSION, global: stored.global, pages };
}

/** JSON with object keys sorted — stable across processes and key order. */
function stableJson(value: unknown): string {
  const replacer = (_key: string, item: unknown): unknown => {
    if (
      typeof item === "object" &&
      item !== null &&
      !Array.isArray(item) &&
      !(item instanceof Date)
    ) {
      const entries = Object.entries(item as Record<string, unknown>).sort(
        ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
      );
      return Object.fromEntries(entries);
    }
    if (typeof item === "number" && !Number.isFinite(item)) return String(item);
    if (typeof item === "function" || typeof item === "symbol") {
      return String(item);
    }
    return item;
  };
  // Never undefined for object inputs; circular data throws (callers catch).
  return JSON.stringify(value, replacer) ?? "null";
}
