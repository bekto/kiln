import { access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { KilnError } from "./errors.ts";

/** The only config filename `loadConfig` looks for, directly inside `root`. */
export const CONFIG_FILENAME = "kiln.config.ts";

/**
 * Fully resolved project configuration. Every documented key lives here;
 * feature-specific settings live untouched inside `features`, where each
 * feature validates its own slice later.
 */
export interface KilnConfig {
  /** Absolute project root the config was loaded from. */
  root: string;
  /** Absolute path to the Markdown source directory. */
  contentDir: string;
  /** Absolute path to the template directory. */
  templatesDir: string;
  /** Absolute path to the static files served as-is. */
  publicDir: string;
  /** Absolute path to the build output directory. */
  outDir: string;
  /** Site-wide metadata. */
  site: {
    title: string;
    url: string;
    description?: string;
  };
  /** Dev-server port (consumer: T026). */
  port: number;
  /** File-watcher settings (consumer: T027). */
  watch: {
    /** Window in milliseconds within which watcher events coalesce. */
    debounceMs: number;
  };
  /** Static-asset settings (consumer: T011). */
  assets: {
    /** Whether copied assets get content-hash cache-busting names. */
    hashBust: boolean;
  };
  /** Open, unvalidated feature settings — features own their slices. */
  features: Record<string, unknown>;
}

const DEFAULTS = {
  contentDir: "content",
  templatesDir: "templates",
  publicDir: "public",
  outDir: "dist",
  site: { title: "Kiln site", url: "http://localhost:8080" },
  port: 4173,
  watch: { debounceMs: 100 },
  assets: { hashBust: false },
};

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every config error message starts with this prefix and names the key. */
function configError(message: string): KilnError {
  return new KilnError("config", `kiln.config.ts: ${message}`, {
    file: CONFIG_FILENAME,
  });
}

function invalid(keyPath: string, expected: string, actual: unknown): never {
  throw configError(`"${keyPath}" must be ${expected} (got ${describeType(actual)})`);
}

/** Validate only known keys; unknown top-level keys are ignored. */
function validateKnownKeys(raw: Record<string, unknown>): void {
  if (raw.site !== undefined && !isPlainObject(raw.site)) {
    invalid("site", "an object", raw.site);
  }
  const site = isPlainObject(raw.site) ? raw.site : undefined;
  if (site?.title !== undefined && typeof site.title !== "string") {
    invalid("site.title", "a string", site.title);
  }
  if (site?.url !== undefined && typeof site.url !== "string") {
    invalid("site.url", "a string", site.url);
  }
  if (site?.description !== undefined && typeof site.description !== "string") {
    invalid("site.description", "a string", site.description);
  }

  if (
    raw.port !== undefined &&
    !(typeof raw.port === "number" && Number.isInteger(raw.port) && raw.port >= 1 && raw.port <= 65535)
  ) {
    invalid("port", "an integer in 1..65535", raw.port);
  }

  if (raw.watch !== undefined && !isPlainObject(raw.watch)) {
    invalid("watch", "an object", raw.watch);
  }
  const watch = isPlainObject(raw.watch) ? raw.watch : undefined;
  if (watch?.debounceMs !== undefined && !(typeof watch.debounceMs === "number" && watch.debounceMs > 0)) {
    invalid("watch.debounceMs", "a positive number", watch.debounceMs);
  }

  if (raw.assets !== undefined && !isPlainObject(raw.assets)) {
    invalid("assets", "an object", raw.assets);
  }
  const assets = isPlainObject(raw.assets) ? raw.assets : undefined;
  if (assets?.hashBust !== undefined && typeof assets.hashBust !== "boolean") {
    invalid("assets.hashBust", "a boolean", assets.hashBust);
  }

  for (const key of ["contentDir", "templatesDir", "publicDir", "outDir"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") {
      invalid(key, "a string", raw[key]);
    }
  }

  if (raw.features !== undefined && !isPlainObject(raw.features)) {
    invalid("features", "a plain object", raw.features);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Import the project-local config file if it exists and return its default
 * export as a plain object. Absent file → undefined (silent defaults).
 */
async function readConfig(configPath: string): Promise<Record<string, unknown> | undefined> {
  if (!(await fileExists(configPath))) return undefined;
  let loaded: { default?: unknown };
  try {
    // Runtime-selected specifier (root varies per call) + a file that only
    // exists in the user's project — a static import cannot work here.
    // Node 24 type-stripping runs the .ts config directly.
    loaded = (await import(pathToFileURL(configPath).href)) as { default?: unknown };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // The position lives on the stack's first line (`<file>:<line>`), not in
    // the message; recorded when the config file itself is where it failed.
    const located =
      error instanceof Error && error.stack !== undefined
        ? new RegExp(`${CONFIG_FILENAME.replaceAll(".", "\\.")}:(\\d+)`)
            .exec(error.stack)
        : null;
    throw new KilnError("config", `failed to load ${configPath}: ${reason}`, {
      file: CONFIG_FILENAME,
      ...(located !== null ? { line: Number(located[1]) } : {}),
      cause: error,
    });
  }
  const exported = loaded.default;
  if (typeof exported !== "object" || exported === null || Array.isArray(exported)) {
    throw configError(`must default-export an object (got ${describeType(exported)})`);
  }
  return exported as Record<string, unknown>;
}

/** Relative values resolve against `root`; absolute values are kept as-is. */
function resolveDir(root: string, value: unknown, fallback: string): string {
  const dir = typeof value === "string" ? value : fallback;
  return path.isAbsolute(dir) ? dir : path.resolve(root, dir);
}

/**
 * Load `kiln.config.ts` from `root` (default `process.cwd()`, the only
 * directory searched) and merge it over the documented defaults. Unknown
 * top-level keys are ignored; the `features` map is stored verbatim. Throws
 * a `KilnError` with `stage: "config"` and a `kiln.config.ts:`-prefixed
 * message on invalid config.
 */
export async function loadConfig(root?: string): Promise<KilnConfig> {
  const projectRoot = path.resolve(root ?? process.cwd());
  const raw = await readConfig(path.join(projectRoot, CONFIG_FILENAME));
  if (raw !== undefined) validateKnownKeys(raw);

  const userSite = raw !== undefined && isPlainObject(raw.site) ? raw.site : {};
  const site: KilnConfig["site"] = {
    title: typeof userSite.title === "string" ? userSite.title : DEFAULTS.site.title,
    url: typeof userSite.url === "string" ? userSite.url : DEFAULTS.site.url,
  };
  if (typeof userSite.description === "string") {
    site.description = userSite.description;
  }

  const userPort = raw?.port;
  const userWatch = raw !== undefined && isPlainObject(raw.watch) ? raw.watch : {};
  const userAssets = raw !== undefined && isPlainObject(raw.assets) ? raw.assets : {};

  const config: KilnConfig = {
    root: projectRoot,
    contentDir: resolveDir(projectRoot, raw?.contentDir, DEFAULTS.contentDir),
    templatesDir: resolveDir(projectRoot, raw?.templatesDir, DEFAULTS.templatesDir),
    publicDir: resolveDir(projectRoot, raw?.publicDir, DEFAULTS.publicDir),
    outDir: resolveDir(projectRoot, raw?.outDir, DEFAULTS.outDir),
    site,
    port: typeof userPort === "number" ? userPort : DEFAULTS.port,
    watch: {
      debounceMs: typeof userWatch.debounceMs === "number" ? userWatch.debounceMs : DEFAULTS.watch.debounceMs,
    },
    assets: {
      hashBust: typeof userAssets.hashBust === "boolean" ? userAssets.hashBust : DEFAULTS.assets.hashBust,
    },
    // Same reference as the config file's export; left unfrozen (features own it).
    features:
      raw !== undefined && isPlainObject(raw.features) ? raw.features : {},
  };

  Object.freeze(site);
  return Object.freeze(config);
}
