/**
 * Structured build errors — the one error vocabulary every pipeline stage
 * shares (T031). A {@link KilnError} carries the stage that failed plus the
 * source position when the underlying failure knows one; `formatKilnError`
 * renders the one-line `[stage] <message>` form the CLI prints for fatal
 * failures and the numbered block uses for entries.
 *
 * Policy (enforced by `src/pipeline/build.ts` + `src/commands/build.ts`):
 * - fatal stages (`config`, `build`) abort the build immediately — a single
 *   `kiln: [stage] <message>` line on stderr, exit 1;
 * - collected stages (`frontmatter`, `markdown`, `template`, `emit`,
 *   `feature`) are recorded, isolated, and reported as one numbered block
 *   after the normal build report — one broken page never hides the others.
 */
import path from "node:path";

/** The pipeline stage a {@link KilnError} came from. */
export type KilnStage =
  | "config"
  | "frontmatter"
  | "markdown"
  | "template"
  | "emit"
  | "feature"
  | "build";

/** Optional structured position/context fields; absent means "unknown". */
export interface KilnErrorOptions {
  /** Source file the failure names (project-relative when known). */
  file?: string;
  /** 1-based line; omitted — never `-1` — when the failure carries none. */
  line?: number;
  /** 1-based column; omitted when the failure carries none. */
  col?: number;
  /** Feature module path, set when `stage === "feature"`. */
  featureFile?: string;
  /** The original exception, kept verbatim — never swallowed. */
  cause?: unknown;
}

/**
 * One structured build failure. The message is always self-describing: it
 * embeds `file[:line]` where the source position is known, agreeing with the
 * structured fields (any parser position is normalized to 1-based).
 */
export class KilnError extends Error {
  readonly stage: KilnStage;
  readonly file?: string;
  readonly line?: number;
  readonly col?: number;
  readonly featureFile?: string;

  constructor(stage: KilnStage, message: string, options: KilnErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.stage = stage;
    this.file = options.file;
    this.line = options.line;
    this.col = options.col;
    this.featureFile = options.featureFile;
  }
}

/**
 * The one-line rendering of a {@link KilnError}:
 * `[stage] <message>`, with the feature tag carrying the module path
 * (`[feature src/features/feed.ts] <message>`).
 */
export function formatKilnError(error: KilnError): string {
  const tag =
    error.stage === "feature" && error.featureFile !== undefined
      ? `feature ${error.featureFile}`
      : error.stage;
  return `[${tag}] ${error.message}`;
}

/**
 * Every collected (non-fatal) error of one build, carried out of
 * `build()` as a single rejection so callers can print the numbered block
 * (`src/pipeline/report.ts`'s `printErrors`). `message` names the first
 * error so a caller that only prints `reason(error)` still points at a real
 * failure.
 */
export class BuildErrors extends Error {
  readonly errors: readonly KilnError[];

  constructor(errors: readonly KilnError[]) {
    const first = errors[0];
    super(
      first === undefined
        ? "build failed"
        : `build failed with ${errors.length} error${errors.length === 1 ? "" : "s"}: ${formatKilnError(first)}`,
    );
    this.errors = errors;
  }
}

/**
 * Control-flow marker for a feature hook that threw while being applied
 * inside another stage (only `extendMarkdown`, invoked during markdown
 * rendering): `src/render/emit.ts` recognizes it and passes it through
 * untouched so `src/pipeline/build.ts` records it as a feature failure
 * instead of a render failure.
 */
export class FeatureHookFailure extends Error {
  readonly feature: string;
  readonly hook: string;
  readonly hookError: unknown;

  constructor(feature: string, hook: string, hookError: unknown) {
    super(`feature ${feature} failed in ${hook}`);
    this.feature = feature;
    this.hook = hook;
    this.hookError = hookError;
  }
}

/** Failure text for a thrown value, mirroring `src/cli.ts`. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Best-effort project-relative path for structured `file` fields: absolute
 * paths inside the cwd become relative (POSIX separators); paths outside
 * the cwd and already-relative paths are kept as-is. Messages are never
 * rewritten by this helper — pinned message text stays byte-identical.
 */
export function projectRelative(filePath: string): string {
  if (!filePath.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(filePath)) {
    return filePath;
  }
  const relative = path.relative(process.cwd(), filePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return filePath;
  }
  return relative.split(path.sep).join("/");
}
