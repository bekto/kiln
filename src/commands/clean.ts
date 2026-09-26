/**
 * `kiln clean` — remove the build output directory and nothing else. A hard
 * path-traversal guard resolves the configured `outDir` against the project
 * root and refuses (throwing → T002 prints `kiln: <message>` / exit 1, with
 * zero deletions) when that target is the project root, the filesystem root,
 * or anywhere outside the project tree. `--dry-run` lists what would go;
 * a missing target is a success no-op. Discovered by T002's auto-discovery;
 * `src/cli.ts` never names this file.
 */
import type { Stats } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CONFIG_FILENAME, loadConfig } from "../config.ts";

export const name = "clean";
export const description = "Remove the build output directory";

const USAGE = "usage: kiln clean [--dry-run]";
const DEFAULT_OUT_DIR = "dist";

/**
 * The `outDir` string as written in `kiln.config.ts` (default `dist`) — the
 * guard's error must name the configured value, but `loadConfig` keeps only
 * the resolved path. The specifier is computed from the runtime project root
 * and may point at a file that does not exist, so no static import can name
 * it (same rationale as config.ts's `readConfig`); the dynamic import hits
 * the ESM cache `loadConfig` already populated. Absent file → the default.
 */
async function configuredOutDir(root: string): Promise<string> {
  let loaded: { default?: unknown };
  try {
    loaded = (await import(
      pathToFileURL(path.join(root, CONFIG_FILENAME)).href
    )) as { default?: unknown };
  } catch {
    return DEFAULT_OUT_DIR;
  }
  const raw = loaded.default;
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const value = (raw as Record<string, unknown>).outDir;
    if (typeof value === "string") return value;
  }
  return DEFAULT_OUT_DIR;
}

export async function run(args: string[]): Promise<void> {
  let dryRun = false;
  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else {
      // Usage error (unknown flag or any positional): stderr listing the
      // supported flags, exit 2 — nothing is inspected or removed.
      process.stderr.write(
        `kiln: ${name}: unknown argument '${arg}'\n${USAGE}\n`,
      );
      process.exitCode = 2;
      return;
    }
  }

  const config = await loadConfig();
  const root = config.root;
  // loadConfig already resolves outDir against the project root; resolving
  // again (idempotent for absolute paths) keeps the guarantee local.
  const target = path.resolve(root, config.outDir);

  // Safety guard, before any listing or deletion: refuse the filesystem root
  // (`/` or an empty string), the project root itself, and anything that
  // resolves outside the project tree.
  const isFsRoot = target === "" || target === path.parse(target).root;
  const relative = path.relative(root, target);
  const isProjectRoot = relative === "";
  const isOutside =
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative);
  if (isFsRoot || isProjectRoot || isOutside) {
    const configured = await configuredOutDir(root);
    const problem = isFsRoot
      ? `resolves to filesystem root '${target}'`
      : isProjectRoot
        ? `resolves to the project root '${target}'`
        : `resolves to '${target}', outside the project root '${root}'`;
    throw new Error(`refusing to clean: outDir '${configured}' ${problem}`);
  }

  let stats: Stats;
  try {
    stats = await stat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // Nothing to remove is a success, not an error.
      process.stdout.write(`nothing to clean: ${target} does not exist\n`);
      return;
    }
    throw error;
  }
  if (!stats.isDirectory()) {
    throw new Error(
      `refusing to clean: outDir '${target}' is not a directory (nothing removed)`,
    );
  }

  if (dryRun) {
    const children = (await readdir(target)).sort();
    process.stdout.write(`dry run: ${target}\n`);
    for (const child of children) {
      process.stdout.write(`  ${path.join(target, child)}\n`);
    }
    process.stdout.write(`would remove ${children.length} entries\n`);
    return;
  }

  await rm(target, { recursive: true });
  process.stdout.write(`removed ${target}\n`);
}
