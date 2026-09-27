/**
 * T036 — theme switcher: the script shipper and config publisher.
 *
 * Hook split, mirroring the search feature (T023):
 * - `onSite` runs after T013's visibility filter and publishes the
 *   configured default theme as `site.data.themeDefault` (the partial
 *   renders `data-default-theme` from `site.themeDefault` through T012's
 *   siteContext — the only top-level channel a feature has). There is no
 *   file to write and no per-page work: the palettes themselves are plain
 *   CSS owned by the site, keyed on the `data-theme` attribute the
 *   browser script toggles.
 * - `onBuildEnd` copies `assets/theme.js` byte-for-byte to
 *   `dist/assets/theme.js` (the same copy contract as search.js).
 *
 * `default` is `features.theme.default` — a string, `"dark"` or `"light"`,
 * default `"dark"`. Anything else (a non-string, an empty string, or any
 * other word) fails the build with an error naming
 * `features.theme.default`, via `ctx.options`' `features.theme: ` prefix.
 *
 * The UI is opt-in exactly like search: include
 * `templates/partials/theme.html` anywhere (a layout, a header partial)
 * and the page gets a toggle button and the deferred script. The script
 * reads the visitor's stored choice from localStorage (`kiln-theme`),
 * where it wins over the configured default, applies it to the document
 * root, and persists toggles — all guarded, never throwing (unavailable
 * or write-blocked storage degrades to per-page-only choices).
 */
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Site } from "../content/document.ts";
import type { BuildEnd, Feature, FeatureContext } from "../feature.ts";

/** `features.theme.default` when the config slice is absent. */
const DEFAULT_THEME = "dark";

/** `assets/theme.js`, resolved from this module, not the cwd. */
const SCRIPT_URL = new URL("../../assets/theme.js", import.meta.url);

/** The two themes the toggle and the stored choice accept. */
const THEMES = ["dark", "light"];

/** The validated `features.theme` slice. */
interface ThemeOptions {
  default: string;
}

/** Type name for error messages, mirroring `src/config.ts`. */
function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Validator for `config.features.theme`: an optional `default` string that
 * must be exactly "dark" or "light".
 */
function parseOptions(raw: unknown): ThemeOptions {
  if (raw === undefined) return { default: DEFAULT_THEME };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `features.theme.default: expected an object { default?: string } (got ${describeType(raw)})`,
    );
  }
  const value =
    typeof raw === "object" && raw !== null && "default" in raw
      ? raw.default
      : undefined;
  if (value === undefined) return { default: DEFAULT_THEME };
  if (typeof value !== "string" || !THEMES.includes(value)) {
    throw new Error(
      `features.theme.default must be "dark" or "light" (got ${describeType(value)})`,
    );
  }
  return { default: value };
}

async function onSite(site: Site, ctx: FeatureContext): Promise<void> {
  const { default: theme } = ctx.options(parseOptions);
  site.data.themeDefault = theme;
}

async function onBuildEnd(result: BuildEnd): Promise<void> {
  const target = path.join(result.distDir, "assets", "theme.js");
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(fileURLToPath(SCRIPT_URL), target);
}

const theme: Feature = { onSite, onBuildEnd };
export default theme;
