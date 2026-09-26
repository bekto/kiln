/**
 * Build orchestrator — `build()` runs the whole pipeline in one function:
 *
 * ```text
 * config → discover → seed site.data → feature discovery → onDocument
 *   → onSite → computeCollections → emitPages → copyAssets → cache.record
 *   → onBuildEnd → report
 * ```
 *
 * Failure split (T031): FATAL — `stage: "config"` (there is no build
 * without config) and `stage: "build"` (unexpected orchestrator/setup
 * failure) reject as one KilnError and nothing further runs; the CLI prints
 * a single `kiln: [stage] <message>` line. COLLECTED — `frontmatter`,
 * `markdown`, `template`, `emit` are recorded per page/file and the stage
 * moves on (one broken page never hides the others). Feature failures —
 * any hook rejection, including `ctx.options()` validation, plus invalid
 * feature modules — keep T012's contract: RECORDED in `featureErrors`, the
 * build stops immediately (no further hooks or stages), the report still
 * prints with partial counts, and `build()` returns it with non-empty
 * `featureErrors`. Any run that recorded a non-feature error rejects with
 * one {@link BuildErrors} carrying every recorded error after the report
 * prints, so the command renders a single numbered block.
 *
 * Re-invocation safety (watch mode): config is loaded fresh every call, and
 * the extensions array, feature contexts, cache handle, and clock are
 * recreated per call. Feature modules stay imported (ESM cache), so hooks
 * must tolerate firing on every rebuild — never assume a hook runs exactly
 * once per process. No core file imports `src/features/*` — only
 * `src/pipeline/features.ts` globs (rules 3/6).
 */
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.ts";
import type { KilnConfig } from "../config.ts";
import { computeCollections } from "../content/collections.ts";
import { discover } from "../content/discover.ts";
import type { Page } from "../content/document.ts";
import type { MarkdownExtension } from "../content/markdown.ts";
import {
  BuildErrors,
  errorMessage,
  FeatureHookFailure,
  KilnError,
} from "../errors.ts";
import type { BuildEnd, BuildFlags, FeatureError } from "../feature.ts";
import { copyAssets } from "../render/assets.ts";
import { emitPages, pageOutputFor } from "../render/emit.ts";
import type { EmittedPage } from "../render/emit.ts";
import { discoverFeatures, FeatureLoadError, wrapFeatureError } from "./features.ts";
import type { FeatureEntry } from "./features.ts";
import { formatReport } from "./report.ts";
import type { BuildReport } from "./report.ts";

/** Options for one `build()` run. */
export interface BuildOptions {
  /** Project root holding `kiln.config.ts`; defaults to `process.cwd()`. */
  cwd?: string;
  flags?: BuildFlags;
}

/**
 * The build-cache seam T029's `src/pipeline/cache.ts` implements:
 * - `shouldSkip(page)` — `true` lets T010 skip render+write when the target
 *   file exists; such pages land in `report.skipped`.
 * - `record(page, outFile)` — after each successful write, for emitted pages
 *   only, once asset copy succeeded. `outFile` is the dist-relative POSIX
 *   path of the written file (identical to `EmittedPage.file`).
 */
export interface BuildCache {
  shouldSkip(page: Page): boolean;
  record(page: Page, outFile: string): void;
}

/** The exports `src/pipeline/cache.ts` must provide (contract fixed in T029). */
interface CacheModule {
  createCache?: unknown;
}

type CreateCache = (options: {
  siteDir: string;
  distDir: string;
  templatesDir: string;
  flags: BuildFlags;
}) => BuildCache;

/**
 * Run one full build. Prints the formatted report to stdout before returning
 * it (feature failures included); only non-feature failures reject.
 *
 * Fatal `stage: "config"`/`stage: "build"` failures reject immediately as a
 * single {@link KilnError} (nothing further runs). Collected failures are
 * recorded per stage, the build keeps going, and — once any non-feature
 * error exists — the run rejects with a single {@link BuildErrors} carrying
 * every recorded error (pipeline order) after the report has printed, so
 * the command can render one numbered block.
 */
export async function build(options?: BuildOptions): Promise<BuildReport> {
  try {
    return await runBuild(options);
  } catch (error) {
    if (error instanceof KilnError || error instanceof BuildErrors) throw error;
    // Unexpected orchestrator/setup failure (discovery, cache, assets, …):
    // fatal stage "build", message preserved verbatim.
    throw new KilnError("build", errorMessage(error), { cause: error });
  }
}

/** The pipeline body {@link build} wraps; see there for the failure policy. */
async function runBuild(options?: BuildOptions): Promise<BuildReport> {
  const startedAt = Date.now();
  // Partial flags from a caller still normalize to full booleans.
  const flags: BuildFlags = {
    drafts: options?.flags?.drafts ?? false,
    future: options?.flags?.future ?? false,
    noCache: options?.flags?.noCache ?? false,
  };
  const report: BuildReport = {
    emitted: [],
    skipped: [],
    durationMs: 0,
    featureErrors: [],
  };
  // T031's collector: every stage pushes its KilnErrors here in pipeline
  // order (discovery reads files sorted, so the recording is deterministic).
  const errors: KilnError[] = [];
  // Stop the clock, print, return — every exit path funnels through here,
  // except a run that recorded collected failures: the report still prints,
  // then every recorded error leaves as one BuildErrors rejection.
  const finish = (): BuildReport => {
    report.durationMs = Date.now() - startedAt;
    process.stdout.write(`${formatReport(report)}\n`);
    if (errors.some((error) => error.stage !== "feature")) {
      throw new BuildErrors(errors);
    }
    return report;
  };

  // Config: loaded fresh per call so watch-mode re-invocations see edits.
  // A validation/import failure is a fatal stage "config" KilnError — it
  // escapes unchanged (src/commands/build.ts prints the single line).
  const config = await loadConfig(options?.cwd);

  // Discovery (T007) — path-sorted pages; setup failures throw, while every
  // broken document is recorded and skipped so N broken files yield N
  // collected errors and the good pages still build.
  const site = await discover({
    contentDir: config.contentDir,
    onError: (error) => errors.push(error),
  });
  // Seed the site bag as a mutable copy of config.site ({title, url,
  // description?}); features own it from here (rule 5).
  site.data = { ...config.site };

  // Feature discovery — an invalid module is a recorded load failure, not a
  // throw; a non-FeatureLoadError (unexpected fs trouble) still throws.
  let entries: FeatureEntry[];
  try {
    entries = await discoverFeatures({
      flags,
      featureOptions: config.features,
    });
  } catch (error) {
    if (error instanceof FeatureLoadError) {
      report.featureErrors.push(error.featureError);
      errors.push(
        wrapFeatureError(error.featureError.feature, error),
      );
      return finish();
    }
    throw error;
  }

  // Markdown seam: wrap each feature's extendMarkdown in filename order.
  // T009 applies these to a fresh renderer once per rendered page, so the
  // hook must be pure plugin registration; a synchronous throw aborts emit
  // (caught below), while an async rejection cannot interrupt the sync
  // render seam and is checked right after emit instead.
  const extensions: MarkdownExtension[] = [];
  const extendFailures: { entry: FeatureEntry; error: unknown }[] = [];
  for (const entry of entries) {
    const hook = entry.feature.extendMarkdown;
    if (hook === undefined) continue;
    extensions.push((md) => {
      let result: void | Promise<void>;
      try {
        result = hook.call(entry.feature, md, entry.ctx);
      } catch (error) {
        throw new FeatureHookFailure(entry.file, "extendMarkdown", error);
      }
      if (result instanceof Promise) {
        result.then(undefined, (error: unknown) => {
          extendFailures.push({ entry, error });
        });
      }
    });
  }

  // onDocument: each discovered page in path order, all features in
  // filename order per page, BEFORE markdown/layout render; doc.data edits
  // are legal (rule 5). First failure stops the build.
  for (const page of site.pages) {
    for (const entry of entries) {
      const hook = entry.feature.onDocument;
      if (hook === undefined) continue;
      try {
        await hook.call(entry.feature, page, entry.ctx);
      } catch (error) {
        report.featureErrors.push({
          feature: entry.file,
          hook: "onDocument",
          message: errorMessage(error),
          doc: page.path,
        });
        errors.push(wrapFeatureError(entry.file, error, page.path));
        return finish();
      }
    }
  }

  // onSite: once after all pages, filename order — may remove entries from
  // site.pages (visibility) or append Page-shaped entries, all of which must
  // be visible to collections and emit below.
  for (const entry of entries) {
    const hook = entry.feature.onSite;
    if (hook === undefined) continue;
    try {
      await hook.call(entry.feature, site, entry.ctx);
    } catch (error) {
      report.featureErrors.push({
        feature: entry.file,
        hook: "onSite",
        message: errorMessage(error),
      });
      errors.push(wrapFeatureError(entry.file, error));
      return finish();
    }
  }

  // Collections after onSite so visibility fixes and appended pages count.
  const collections = computeCollections(site);

  // Cache load: absent module → no cache (normal W2–W3 state);
  // --no-cache → never loaded; a present-but-broken module throws.
  const cache = await loadCache(config, flags);

  // Emit (T010): render+write every page (cache skips included). Template/
  // markdown/emit failures are recorded per page (that page is skipped,
  // every other page still renders); a sync extendMarkdown failure arrives
  // as FeatureHookFailure and takes the report path.
  let emitted: EmittedPage[];
  let skipped: EmittedPage[];
  try {
    const result = await emitPages(site, {
      distDir: config.outDir,
      extensions,
      extra: { collections, flags },
      shouldSkip:
        cache === undefined ? undefined : (page) => cache.shouldSkip(page),
      onError: (error) => errors.push(error),
    });
    emitted = result.emitted;
    skipped = result.skipped;
  } catch (error) {
    if (error instanceof FeatureHookFailure) {
      report.featureErrors.push({
        feature: error.feature,
        hook: error.hook,
        message: errorMessage(error.hookError),
      });
      errors.push(wrapFeatureError(error.feature, error.hookError));
      return finish();
    }
    throw error;
  }
  report.emitted = emitted;
  report.skipped = skipped;

  // Async extendMarkdown rejections (honored as soon as emit finishes):
  // no further stages run.
  if (extendFailures.length > 0) {
    const failure = extendFailures[0];
    report.featureErrors.push({
      feature: failure.entry.file,
      hook: "extendMarkdown",
      message: errorMessage(failure.error),
    });
    errors.push(wrapFeatureError(failure.entry.file, failure.error));
    return finish();
  }

  // Assets (T011): emitted ∪ skipped are both protected — cache-skipped
  // outputs exist on disk and must not be clobbered by a colliding source.
  await copyAssets({
    publicDir: config.publicDir,
    distDir: config.outDir,
    emitted: new Set([...emitted, ...skipped].map((out) => out.file)),
    hashBust: config.assets.hashBust,
  });

  // Cache record: emitted pages only, after every write (incl. asset copy)
  // succeeded. site.pages is unchanged since emit — onBuildEnd runs next.
  if (cache !== undefined) {
    const pageByFile = new Map<string, Page>();
    for (const page of site.pages) pageByFile.set(pageOutputFor(page).file, page);
    for (const out of emitted) {
      const page = pageByFile.get(out.file);
      if (page !== undefined) cache.record(page, out.file);
    }
  }

  // onBuildEnd: once per build, filename order, after emit + asset copy;
  // may write files into distDir. First failure is recorded, the rest of
  // the loop is skipped, counts stay intact.
  const buildEnd: BuildEnd = { distDir: config.outDir, site, emitted, skipped };
  for (const entry of entries) {
    const hook = entry.feature.onBuildEnd;
    if (hook === undefined) continue;
    try {
      await hook.call(entry.feature, buildEnd, entry.ctx);
    } catch (error) {
      report.featureErrors.push({
        feature: entry.file,
        hook: "onBuildEnd",
        message: errorMessage(error),
      });
      errors.push(wrapFeatureError(entry.file, error));
      break;
    }
  }

  return finish();
}

/**
 * Load T029's cache module unless `flags.noCache`. The specifier is computed
 * so `tsc --noEmit` stays green before `src/pipeline/cache.ts` exists:
 * absent file → `undefined` (no cache, normal W2–W3 state); present but
 * failing to import or missing `createCache` → throws with an error naming
 * `src/pipeline/cache.ts` (wiring errors are loud).
 */
async function loadCache(
  config: KilnConfig,
  flags: BuildFlags,
): Promise<BuildCache | undefined> {
  if (flags.noCache) return undefined;
  const url = new URL("./cache.ts", import.meta.url);
  // Runtime-selected specifier + a file that may not exist yet — a static
  // import cannot name it.
  let exists = true;
  try {
    await access(fileURLToPath(url));
  } catch {
    exists = false;
  }
  if (!exists) return undefined;

  let mod: CacheModule;
  try {
    mod = (await import(url.href)) as CacheModule;
  } catch (error) {
    throw new Error(`src/pipeline/cache.ts: ${errorMessage(error)}`, { cause: error });
  }
  if (typeof mod.createCache !== "function") {
    throw new Error("src/pipeline/cache.ts: missing createCache export");
  }
  try {
    return (mod.createCache as CreateCache)({
      siteDir: config.root,
      distDir: config.outDir,
      templatesDir: config.templatesDir,
      flags,
    });
  } catch (error) {
    throw new Error(`src/pipeline/cache.ts: ${errorMessage(error)}`, { cause: error });
  }
}
