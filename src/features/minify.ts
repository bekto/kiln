/**
 * HTML minification (T030) — the opt-in `features.minify` slice. At
 * `onBuildEnd`, every emitted or cache-skipped `.html` file under `dist/`
 * is minified in place through `html-minifier-terser@7`'s async `minify()`
 * (the hook resolves only after every rewrite). Only
 * `BuildEnd.emitted` + `BuildEnd.skipped` entries whose dist-relative file
 * ends in `.html` are ever opened — `feed.xml`, `sitemap.xml`,
 * `search-index.json`, `assets/**`, and images are never read or written.
 *
 * Opt-in semantics (canonical example):
 *
 * ```ts
 * // kiln.config.ts
 * export default {
 *   features: {
 *     minify: { collapseWhitespace: true, removeComments: true, minifyCSS: true },
 *   },
 * };
 * ```
 *
 * - `features.minify` absent → `validateOptions` returns `undefined` and
 *   `onBuildEnd` returns before touching the filesystem: a complete no-op.
 * - Present → must be a plain object (array/string/number/null fail the
 *   build with an error naming `features.minify`). The four optional
 *   booleans merge over `{ collapseWhitespace: true, removeComments: true,
 *   minifyCSS: false, minifyJS: false }`; a non-boolean value fails the
 *   build naming the exact key (`features.minify.minifyCSS`), matching the
 *   sibling features' `ctx.options` validation style — the validator's
 *   throw arrives prefixed `features.minify: `.
 * - Those four keys are the entire exposed surface: unknown keys are
 *   ignored rather than forwarded, and every other library option keeps
 *   its markup-safe default (so e.g. `removeAttributeQuotes` stays off and
 *   is never configurable).
 *
 * `<pre>`/`<code>` invariant: the library's `collapseWhitespace` skips
 * `<pre>` content but DOES collapse inline `<code>` runs, so both element
 * kinds are shielded through `ignoreCustomFragments` — one fragment
 * alternation that the library compiles from `re.source` alone (it drops
 * any flags), hence case-insensitive tag names spelled as character
 * classes and newlines as `[\s\S]`. The `<pre>` alternative leads, so a
 * code block wins over the `<code>` it wraps. Shielded elements — inner
 * whitespace runs, comments, text, plus `hljs` classes and token spans —
 * minify byte-for-byte; everything outside them still collapses, and
 * entities/doctype pass through untouched.
 *
 * A read/minify/write failure rejects `onBuildEnd` with a plain `Error`
 * (`kiln: failed to minify <file>: <reason>`) naming the offending output
 * file; T012 records it as a feature failure — report line, exit 1.
 * Deterministic: identical input yields byte-identical output (no
 * timestamps, no random ids in the result). Empty or whitespace-only
 * pages minify to empty without error.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { minify } from "html-minifier-terser";
import type { Options } from "html-minifier-terser";
import type { BuildEnd, Feature, FeatureContext } from "../feature.ts";

/** The exposed `features.minify` booleans, merged over their defaults. */
interface MinifyConfig {
  collapseWhitespace: boolean;
  removeComments: boolean;
  minifyCSS: boolean;
  minifyJS: boolean;
}

/**
 * `<pre>…</pre>` or `<code>…</code>` (open tags may carry attributes) as
 * one atomic fragment the minifier must not enter. Must stay a single line
 * with no whitespace outside character classes: the library rewraps this
 * source as `\s*(?:<src>)+\s*` with only a `g` flag, so case-insensitivity
 * is spelled with character classes and `[\s\S]` spans newlines. The
 * `<pre>` alternative leads so a block matches before the `<code>` inside.
 */
const PRESERVED =
  String.raw`<[pP][rR][eE](?:\s[^<>]*)?>[\s\S]*?<\/[pP][rR][eE]>` +
  "|" +
  String.raw`<[cC][oO][dD][eE](?:\s[^<>]*)?>[\s\S]*?<\/[cC][oO][dD][eE]>`;

/**
 * `onBuildEnd` — rewrite every emitted/skipped `.html` output in place,
 * in sorted-filename order, awaiting each async `minify()`. Absent config
 * returns before any path is constructed; a rejected read/minify/write
 * names the file in a plain `Error` for T012 to record (exit 1).
 */
async function onBuildEnd(
  result: BuildEnd,
  ctx: FeatureContext,
): Promise<void> {
  const config = ctx.options(validateOptions);
  if (config === undefined) return; // key absent: not one byte is read or written

  const files = new Set<string>();
  for (const page of [...result.emitted, ...result.skipped]) {
    if (page.file.endsWith(".html")) files.add(page.file);
  }
  const options: Options = {
    collapseWhitespace: config.collapseWhitespace,
    removeComments: config.removeComments,
    minifyCSS: config.minifyCSS,
    minifyJS: config.minifyJS,
    ignoreCustomFragments: [new RegExp(PRESERVED)],
  };
  for (const file of [...files].sort()) {
    try {
      const source = await readFile(path.join(result.distDir, file), "utf8");
      const minified = await minify(source, options);
      await writeFile(path.join(result.distDir, file), minified, "utf8");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`kiln: failed to minify ${file}: ${reason}`);
    }
  }
}

const feature: Feature = { onBuildEnd };

export default feature;

/**
 * `config.features.minify` — `undefined` (key absent) means the feature is
 * off; otherwise a plain object whose four optional booleans must be
 * booleans. Every rejection names the full key path so the `ctx.options`
 * prefix plus this text carries `features.minify` / `features.minify.<key>`.
 */
function validateOptions(raw: unknown): MinifyConfig | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `"features.minify" must be a plain object (got ${describe(raw)})`,
    );
  }
  const options = raw as Record<string, unknown>;
  return {
    collapseWhitespace: readBoolean(options, "collapseWhitespace", true),
    removeComments: readBoolean(options, "removeComments", true),
    minifyCSS: readBoolean(options, "minifyCSS", false),
    minifyJS: readBoolean(options, "minifyJS", false),
  };
}

/** One optional boolean key: absent → `fallback`, non-boolean → reject. */
function readBoolean(
  options: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = options[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new Error(
      `"features.minify.${key}" must be a boolean (got ${describe(value)})`,
    );
  }
  return value;
}

/** Failure detail: primitives show themselves, containers show their type. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return typeof value;
}
