/**
 * Template engine: a strict nunjucks {@link Environment} over a project's
 * `templates/` directory (with `templates/partials/` alongside it as a
 * search path), the frontmatter-driven layout phase, and the markdown phase
 * (T006) that produces the rendered `content` layouts insert with `|safe`.
 *
 * Strict by construction: `autoescape` is on, `throwOnUndefined` turns a
 * typo like `{{ titel }}` into a render rejection naming the template, line,
 * and variable. Failures are re-wrapped to keep that guarantee — the raw
 * nunjucks messages vary by path (top-level render vs. `{% extends %}` vs.
 * `{% include %}`), so {@link wrapRenderError} normalizes them to the stable
 * forms `post.html: line 7: undefined variable "titel"` and
 * `template not found: "x.html" (searched: templates/, templates/partials/)`.
 *
 * Templates are re-read on every render call (the loader runs with
 * `noCache`): rebuilds must see edits to layout files without a restart
 * (T027 relies on this).
 *
 * nunjucks ships no TypeScript types and this batch installs only nunjucks
 * itself, so the two constructor entry points come through `createRequire`
 * and are typed by the narrow {@link Loader}/{@link Environment} interfaces.
 */
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import type { Page } from "../content/document.ts";
import { asMarkdownError, createRenderer } from "../content/markdown.ts";
import type { MarkdownExtension } from "../content/markdown.ts";
import { KilnError, projectRelative } from "../errors.ts";

const require = createRequire(import.meta.url);

/** The `FileSystemLoader` surface this module uses. */
interface Loader {
  cache: Record<string, unknown>;
  getSource(
    name: string,
  ): { src: string; path: string; noCache?: boolean } | null;
}

/** The nunjucks `Environment` surface this module uses. */
interface Environment {
  addFilter(name: string, filter: (value: unknown) => string): void;
  render(
    name: string,
    data: Record<string, unknown>,
    callback: (error: Error | null, result?: string) => void,
  ): void;
}

const { Environment: NunjucksEnvironment, FileSystemLoader } = require(
  "nunjucks",
) as {
  Environment: new (
    loader: Loader,
    options: { autoescape: boolean; throwOnUndefined: boolean },
  ) => Environment;
  FileSystemLoader: new (
    searchPaths: string[],
    options: { noCache: boolean },
  ) => Loader;
};

/** Everything {@link Templates.renderDocument} needs beyond the page itself. */
export interface RenderDocumentOptions {
  /** Pretty URL of the page being rendered, e.g. `/posts/hi/`. */
  url: string;
  /** Site metadata (T012 seeds it from config) plus `pages` for listing. */
  site: Record<string, unknown>;
  /** T012's feature-provided markdown plugins (T006 seam); omitted → plain. */
  extensions?: MarkdownExtension[];
  /** Extra top-level context; `page`/`site`/`content` cannot be shadowed. */
  extra?: Record<string, unknown>;
}

/** A loaded templates directory ready to render. */
export interface Templates {
  /** Render a template by name (e.g. `"post.html"`) with `data` as context. */
  render(template: string, data: Record<string, unknown>): Promise<string>;
  /** Markdown phase then layout phase: render one {@link Page} to HTML. */
  renderDocument(page: Page, opts: RenderDocumentOptions): Promise<string>;
}

/**
 * The template view of a page: frontmatter plus the computed `url`/`path`,
 * which win over same-named frontmatter keys — the document's identity is
 * not overridable from its own metadata.
 */
export function pageView(page: Page): Record<string, unknown> {
  return { ...page.data, url: page.url, path: page.path };
}

/**
 * Load a templates directory (default `'templates'`, resolved against the
 * current working directory) for rendering. The directory must exist at
 * load time — a missing one rejects with `<absolute path>: templates
 * directory not found`, before any render can start.
 *
 * Search paths are `[templatesDir, templatesDir/partials]`: layouts resolve
 * by path (`"post.html"`), partials by bare name (`"header.html"` →
 * `templates/partials/header.html`) and by prefixed path
 * (`"partials/header.html"`).
 */
export async function loadTemplates(
  templatesDir = "templates",
): Promise<Templates> {
  const root = path.resolve(templatesDir);
  const info = await stat(root).catch(() => null);
  if (info === null || !info.isDirectory()) {
    throw new KilnError("template", `${root}: templates directory not found`, {
      file: projectRelative(root),
    });
  }
  const partials = path.join(root, "partials");
  // Error messages echo the directories as the caller named them (relative
  // in, relative out), with a trailing separator to match the loader docs.
  const searched = [templatesDir, path.join(templatesDir, "partials")].map(
    (directory) =>
      directory.endsWith(path.sep) ? directory : directory + path.sep,
  );

  const loader = new FileSystemLoader([root, partials], { noCache: true });
  const env = new NunjucksEnvironment(loader, {
    autoescape: true,
    throwOnUndefined: true,
  });

  env.addFilter("date", (value: unknown) => {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    throw new Error(`date filter: expected Date, got ${typeof value}`);
  });

  const renderAsync = promisify(env.render.bind(env));

  async function render(
    template: string,
    data: Record<string, unknown>,
  ): Promise<string> {
    try {
      return (await renderAsync(template, data)) ?? "";
    } catch (error) {
      if (error instanceof Error) throw wrapRenderError(error, searched, template);
      throw error;
    }
  }

  async function renderDocument(
    page: Page,
    opts: RenderDocumentOptions,
  ): Promise<string> {
    // Hosting subpath (T012 seeds it from site.url's path); default "" so
    // hand-built test contexts render exactly as before.
    const basePath =
      typeof opts.site.basePath === "string" ? opts.site.basePath : "";
    // Markdown phase: the env carries the page so feature plugins can
    // attach per-page data (e.g. doc.data.toc) during render. A renderer
    // crash (buggy extension rule) is a markdown-stage failure — the
    // pipeline caller attaches the source document next.
    const md = createRenderer({
      extensions: opts.extensions,
      currentUrl: opts.url,
      basePath,
    });
    let content: string;
    try {
      content = md.render(page.content, { doc: page });
    } catch (error) {
      throw asMarkdownError(error);
    }
    // Layout phase: extra first so page/site/content always win.
    const context = {
      ...opts.extra,
      site: { basePath, ...opts.site },
      page: pageView(page),
      content,
    };
    return render(layoutFor(page), context);
  }

  return { render, renderDocument };
}

/**
 * The template a page renders through: frontmatter `layout` normalized to a
 * `.html` file name (`post` and `post.html` both → `post.html`), defaulting
 * to `post.html` when absent. A non-string value names the source path and
 * the value it rejected.
 */
function layoutFor(page: Page): string {
  const layout = page.data.layout;
  if (layout === undefined) return "post.html";
  if (typeof layout !== "string") {
    throw new KilnError(
      "template",
      `${page.path}: layout must be a string, got ${
        typeof layout
      } (${describe(layout)})`,
      { file: projectRelative(page.path) },
    );
  }
  return layout.endsWith(".html") ? layout : `${layout}.html`;
}

/** JSON form of a value for error messages, with a non-throwing fallback. */
function describe(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // Circular or otherwise unserializable — fall through.
  }
  return String(value);
}

/**
 * Normalize a nunjucks render failure into the stable messages this engine
 * promises, wrapped as a `stage: "template"` {@link KilnError}:
 * - missing templates gain the directories that were searched (byte-
 *   identical message; the requested name becomes the structured `file`);
 * - strict undefined-variable failures keep T009's exact
 *   `<template>: line <n>: undefined variable "<name>"` message (nunjucks'
 *   own text says only "attempted to output null or undefined value", so the
 *   variable is read back from the source at the reported line/column),
 *   with `file`/`line`/`col` mirroring that position;
 * - any other located failure is normalized to `<file>:<line> — <reason>`;
 * - an unlocated failure (e.g. a filter throwing) is prefixed with the
 *   template being rendered, so every message names its source.
 */
function wrapRenderError(
  error: Error,
  searched: string[],
  template: string,
): KilnError {
  const message = error.message;

  const missing = /template not found: (\S+)/.exec(message);
  if (missing !== null) {
    return new KilnError(
      "template",
      `template not found: "${missing[1]}" (searched: ${searched.join(", ")})`,
      { file: missing[1], cause: error },
    );
  }

  const located =
    /\(([^()\n]+)\) \[Line (\d+)(?:, Column (\d+))?\]/.exec(message);
  if (located !== null) {
    const file = located[1];
    const line = Number(located[2]);
    const col = located[3] !== undefined ? Number(located[3]) : undefined;
    const position = {
      file: projectRelative(file),
      line,
      ...(col !== undefined ? { col } : {}),
    };
    if (message.includes("attempted to output null or undefined value")) {
      const variable = variableAt(file, line, col ?? 1);
      return new KilnError(
        "template",
        `${path.basename(file)}: line ${line}: undefined variable "${variable}"`,
        { ...position, cause: error },
      );
    }
    const reason = message.replace(located[0], "").trim();
    return new KilnError("template", `${position.file}:${line} — ${reason}`, {
      ...position,
      cause: error,
    });
  }

  return new KilnError("template", `${template}: ${message}`, { cause: error });
}

/**
 * The dotted variable name rendered at `line`/`col` of a template file:
 * prefer the expression opening at the column (the `{{ … }}` the strict
 * check failed on), else the line's first identifier.
 */
function variableAt(file: string, line: number, col: number): string {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return "unknown";
  }
  const text = source.split("\n")[line - 1] ?? "";
  const atColumn = text.slice(Math.max(0, col - 1));
  const identifier = "[A-Za-z_$][\\w$]*(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*)*";
  const expression = new RegExp(`\\{\\{[-~]?\\s*(${identifier})`);
  const plain = new RegExp(`(${identifier})`);
  const match =
    expression.exec(atColumn) ??
    expression.exec(text) ??
    plain.exec(atColumn) ??
    plain.exec(text);
  return match?.[1].replace(/\s+/g, "") ?? "unknown";
}
