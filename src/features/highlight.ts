/**
 * T016 — build-time syntax highlighting with highlight.js.
 *
 * `extendMarkdown` replaces markdown-it's fence renderer: the info string's
 * first token is the language (`` ```ts title=x.ts `` → label `ts`; the rest
 * of the info string is ignored), looked up through `hljs.getLanguage()` —
 * the allowlist that keeps raw fence text out of `highlight()`. Recognized
 * languages render with `hljs` + `language-<lang>` on the `<code>` element
 * and highlight.js's `hljs-` prefixed token spans (themes target those);
 * unknown or absent languages fall back to escaped plain `<code>`, so a
 * fence is never blank and never crashes the render. The visible label above
 * each block comes from the same first token.
 *
 * Theme emission: `features.highlight.theme` (string, default
 * `github-dark`) names a bundled style in `highlight.js/styles/`.
 * `onSite` — the earliest once-per-build hook, running before any page
 * renders — validates the config slice (an invalid theme fails the build
 * with an error naming `features.highlight.theme`) and resets the
 * per-build highlighted-block counter, which makes re-invocation safe
 * (watch mode never assumes a hook fires once per process). `onBuildEnd`
 * then writes `dist/assets/hljs.css` when at least one block was
 * highlighted this build, and removes a stale file when none was AND
 * every page was re-rendered (cache-skipped pages keep the theme).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import hljs from "highlight.js";
import type { MarkdownIt } from "markdown-it";
import type { Feature } from "../feature.ts";

const DEFAULT_THEME = "github-dark";

/** Theme names are bare highlight.js style basenames — no paths, no dots. */
const THEME_NAME = /^[a-z0-9][a-z0-9-]*$/;

const require = createRequire(import.meta.url);

/** Absolute `highlight.js/styles/` directory in the installed package. */
const STYLES_DIR = path.join(
  path.dirname(require.resolve("highlight.js/package.json")),
  "styles",
);

/**
 * Highlighted blocks counted since this build's `onSite` reset; `onBuildEnd`
 * emits the theme only while this is non-zero.
 */
let highlightedBlocks = 0;

/**
 * Absolute path of the stylesheet backing `theme`, or `undefined` when the
 * name is not a bundled highlight.js style (the allowlist for
 * `features.highlight.theme`).
 */
function themeFile(theme: string): string | undefined {
  if (!THEME_NAME.test(theme)) return undefined;
  const min = path.join(STYLES_DIR, `${theme}.min.css`);
  if (existsSync(min)) return min;
  const full = path.join(STYLES_DIR, `${theme}.css`);
  return existsSync(full) ? full : undefined;
}

/** Validated `features.highlight` slice: the theme to emit at build end. */
interface HighlightConfig {
  theme: string;
}

/**
 * Validate `config.features.highlight` for `ctx.options()`. Failures are
 * re-thrown by the feature context prefixed `features.highlight: `, so each
 * message names `features.highlight.theme` to carry the full key path.
 */
function validateOptions(raw: unknown): HighlightConfig {
  if (raw === undefined) return { theme: DEFAULT_THEME };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error('expected an object like { theme: "github-dark" }');
  }
  const theme = (raw as { theme?: unknown }).theme;
  if (theme === undefined) return { theme: DEFAULT_THEME };
  if (typeof theme !== "string") {
    throw new Error(
      `value of features.highlight.theme must be a string, got ${
        theme === null ? "null" : typeof theme
      }`,
    );
  }
  if (themeFile(theme) === undefined) {
    throw new Error(
      `unknown theme "${theme}" for features.highlight.theme; expected a bundled highlight.js style, default "github-dark"`,
    );
  }
  return { theme };
}

/**
 * Highlight `content` when the first info-string token names a registered
 * language, counting the block toward this build's theme emission; fall
 * back to escaped plain code for unknown languages, absent languages, and
 * any highlighter failure.
 */
function fenceBody(md: MarkdownIt, content: string, lang: string): string {
  if (lang !== "" && hljs.getLanguage(lang) !== undefined) {
    try {
      const result = hljs.highlight(content, {
        language: lang,
        ignoreIllegals: true,
      });
      highlightedBlocks++;
      return result.value;
    } catch {
      // Degrade to escaped plain code — a fence never aborts the render.
    }
  }
  return md.utils.escapeHtml(content);
}

const feature: Feature = {
  extendMarkdown(md) {
    md.renderer.rules.fence = (tokens, idx) => {
      const token = tokens[idx];
      const info = token.info ? md.utils.unescapeAll(token.info).trim() : "";
      // First token only: ```ts title=x.ts → language/label `ts`.
      const lang = info === "" ? "" : info.split(/\s+/)[0];
      const classes =
        lang === "" ? "hljs" : `hljs language-${md.utils.escapeHtml(lang)}`;
      const label =
        lang === ""
          ? ""
          : `<span class="hljs-langlabel">${md.utils.escapeHtml(lang)}</span>\n`;
      return `<pre>${label}<code class="${classes}">${fenceBody(
        md,
        token.content,
        lang,
      )}</code></pre>\n`;
    };
  },

  onSite(_site, ctx) {
    // Earliest once-per-build hook: a bad theme fails the build before any
    // page renders, and the highlighted-block count starts fresh here.
    ctx.options(validateOptions);
    highlightedBlocks = 0;
  },

  async onBuildEnd(result, ctx) {
    const { theme } = ctx.options(validateOptions);
    const cssFile = path.join(result.distDir, "assets", "hljs.css");
    if (highlightedBlocks === 0) {
      // Nothing highlighted in pages rendered this build. Cache-skipped
      // pages may still carry hljs classes — keep any existing theme
      // rather than break them (T029 gate fix); remove it only when every
      // page was re-rendered and none used highlighting.
      if (result.skipped.length > 0) return;
      await rm(cssFile, { force: true });
      return;
    }
    const source = themeFile(theme);
    if (source === undefined) {
      throw new Error(
        `features.highlight.theme: no bundled style for "${theme}"`,
      );
    }
    await mkdir(path.dirname(cssFile), { recursive: true });
    await writeFile(cssFile, await readFile(source, "utf8"));
  },
};

export default feature;
