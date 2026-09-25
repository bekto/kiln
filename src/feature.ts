/**
 * The `Feature` hook contract — the seam every Wave-3/4/5 feature in
 * `src/features/*.ts` plugs into (T013–T023, T030–T032). This file is the
 * frozen API surface: the orchestrator (T012) discovers feature modules,
 * builds one {@link FeatureContext} per feature per build, and invokes hooks
 * in sorted-filename order with the guarantees documented on each hook.
 *
 * Timing guarantees:
 * - `extendMarkdown` — applied in sorted-filename order, once per rendered
 *   page, before any markdown; pure plugin registration (no I/O, no
 *   once-per-process assumptions).
 * - `onDocument` — each discovered page in path order, all features in
 *   filename order per page, BEFORE markdown/layout render; mutating
 *   `doc.data` is legal.
 * - `onSite` — once after all pages, filename order; may remove entries from
 *   `site.pages` or append `Page`-shaped entries (pages lacking `url` get it
 *   from T010's `pageOutputFor` fallback via `data.permalink`/`path`).
 * - `onBuildEnd` — once per build, filename order, after emit + asset copy;
 *   may write files into `result.distDir`.
 *
 * Any hook rejection (including `options()` validation) stops the build
 * immediately — no further hooks or stages run — and records a
 * {@link FeatureError}; the build report still prints and `build()` returns
 * it with non-empty `featureErrors` (feature failures never throw).
 */
import type { MarkdownIt } from "markdown-it";
import type { Document, Site } from "./content/document.ts";
import type { EmittedPage } from "./render/emit.ts";

/** One feature module's hooks; every hook is optional. */
export interface Feature {
  extendMarkdown?(md: MarkdownIt, ctx: FeatureContext): void | Promise<void>;
  onDocument?(doc: Document, ctx: FeatureContext): void | Promise<void>;
  onSite?(site: Site, ctx: FeatureContext): void | Promise<void>;
  onBuildEnd?(result: BuildEnd, ctx: FeatureContext): void | Promise<void>;
}

/** CLI flags for one build, as exposed to features through `ctx.flags`. */
export interface BuildFlags {
  drafts: boolean;
  future: boolean;
  noCache: boolean;
}

/** Per-feature, per-build context handed to every hook invocation. */
export interface FeatureContext {
  /** Feature file stem, e.g. `"highlight"`. */
  readonly name: string;
  readonly flags: BuildFlags;
  /**
   * Read `config.features?.[name]` (undefined when absent) and return
   * `validate(raw)`'s result untouched. A validator failure is re-thrown
   * prefixed `features.<name>: ` so config errors always carry the full key
   * path (each feature validates its own slice; T003 never gains
   * feature-specific keys).
   */
  options<T>(validate: (raw: unknown) => T): T;
}

/** The build outcome handed to `onBuildEnd`, after emit + asset copy. */
export interface BuildEnd {
  readonly distDir: string;
  readonly site: Site;
  readonly emitted: readonly EmittedPage[];
  readonly skipped: readonly EmittedPage[];
}

/**
 * A recorded feature failure. `feature` is `src/features/<file>.ts`, `hook`
 * is `load | extendMarkdown | onDocument | onSite | onBuildEnd`, `doc` is
 * present for `onDocument` failures (the source path).
 */
export interface FeatureError {
  feature: string;
  hook: string;
  message: string;
  doc?: string;
}
