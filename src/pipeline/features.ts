/**
 * Feature auto-discovery — the seam every Wave-3/4/5 feature plugs into.
 * Glob `src/features/*.ts` resolved from this file's `import.meta.url` (never
 * the cwd), sort lexicographically by filename — that order is THE feature
 * order for every hook — then `import()` each module and take its default
 * export as the {@link Feature}.
 *
 * An empty (or not-yet-existing) directory yields zero features: valid, W2
 * runs featureless. An invalid module — no default export, a default that is
 * not a plain object, a present hook that is not a function, or an import
 * failure — throws {@link FeatureLoadError}, which the orchestrator records
 * as a `FeatureError` with `hook: "load"` and aborts the build with.
 */
import { glob, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  BuildFlags,
  Feature,
  FeatureContext,
  FeatureError,
} from "../feature.ts";

/** Repo-relative POSIX location of the features directory (report naming). */
const FEATURES_LABEL = "src/features";

/** Absolute features directory, resolved from this module, not the cwd. */
const FEATURES_DIR = fileURLToPath(new URL("../features/", import.meta.url));

/** The hooks a default export may provide; anything else is ignored. */
const HOOKS = ["extendMarkdown", "onDocument", "onSite", "onBuildEnd"] as const;

/** One discovered feature plus the per-build context its hooks receive. */
export interface FeatureEntry {
  /** File stem — `FeatureContext.name` (`"toc"` for `src/features/toc.ts`). */
  readonly name: string;
  /** `src/features/<file>.ts` — the `FeatureError.feature` value. */
  readonly file: string;
  readonly feature: Feature;
  readonly ctx: FeatureContext;
}

/**
 * An invalid feature module. The message is the bare reason; the report line
 * already names the file through `featureError.feature`.
 */
export class FeatureLoadError extends Error {
  readonly featureError: FeatureError;

  constructor(file: string, message: string) {
    super(message);
    this.featureError = { feature: file, hook: "load", message };
  }
}

/**
 * Discover every feature module, in sorted-filename order. `featureOptions`
 * is the raw `config.features` map each feature reads through
 * `ctx.options(validate)`.
 */
export async function discoverFeatures(options: {
  flags: BuildFlags;
  featureOptions: Record<string, unknown>;
}): Promise<FeatureEntry[]> {
  const info = await stat(FEATURES_DIR).catch(() => undefined);
  if (info?.isDirectory() !== true) return []; // no src/features yet (W2)

  const files: string[] = [];
  for await (const entry of glob("*.ts", { cwd: FEATURES_DIR })) {
    files.push(entry);
  }
  files.sort(); // lexicographic by filename — the hook order for this build

  const entries: FeatureEntry[] = [];
  for (const file of files) {
    const rel = `${FEATURES_LABEL}/${file}`;
    let mod: { default?: unknown };
    try {
      // Runtime-selected specifier: the file list comes from the glob, so no
      // static import can name it (and typecheck never needs the files).
      mod = (await import(pathToFileURL(path.join(FEATURES_DIR, file)).href)) as {
        default?: unknown;
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new FeatureLoadError(rel, `failed to load (${reason})`);
    }
    const raw = mod.default;
    if (raw === undefined) {
      throw new FeatureLoadError(rel, "no default export");
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      const type = raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw;
      throw new FeatureLoadError(
        rel,
        `default export must be a plain object (got ${type})`,
      );
    }
    const hooks = raw as Record<string, unknown>;
    for (const hook of HOOKS) {
      const value = hooks[hook];
      if (value !== undefined && typeof value !== "function") {
        const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
        throw new FeatureLoadError(
          rel,
          `'${hook}' must be a function (got ${type})`,
        );
      }
    }
    const name = file.endsWith(".ts") ? file.slice(0, -3) : file;
    entries.push({
      name,
      file: rel,
      feature: hooks as unknown as Feature,
      ctx: makeContext(name, options.flags, options.featureOptions),
    });
  }
  return entries;
}

/**
 * One feature's hook context. `options(validate)` reads this feature's own
 * config slice (`config.features[name]`, undefined when absent), returns the
 * validator's result untouched, and re-throws any validator failure prefixed
 * `features.<name>: ` so config errors always carry the full key path.
 */
function makeContext(
  name: string,
  flags: BuildFlags,
  featureOptions: Record<string, unknown>,
): FeatureContext {
  return {
    name,
    flags,
    options<T>(validate: (raw: unknown) => T): T {
      const raw = featureOptions[name];
      try {
        return validate(raw);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`features.${name}: ${reason}`, { cause: error });
      }
    },
  };
}
