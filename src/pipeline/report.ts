/**
 * The build report — `build()`'s single result shape and its one canonical
 * stdout rendering, so every caller (CLI, watch mode) reports identically.
 */
import type { FeatureError } from "../feature.ts";
import type { EmittedPage } from "../render/emit.ts";

/** What one `build()` produces; printed to stdout through {@link formatReport}. */
export interface BuildReport {
  emitted: EmittedPage[];
  skipped: EmittedPage[];
  /** Wall-clock build time including hooks, in milliseconds. */
  durationMs: number;
  featureErrors: FeatureError[];
}

/**
 * The report as printed by `build()` before returning:
 *
 * ```text
 * kiln build
 *   pages emitted: 12
 *   pages skipped (cache): 3
 *   duration: 412ms
 *   feature errors: 1
 *     src/features/feed.ts (onSite): features.feed: bad option
 *     src/features/toc.ts (onDocument): boom [doc /abs/content/post.md]
 * ```
 *
 * The `feature errors:` block (including its count line) is omitted when
 * there are none; the lines above it are always present. No trailing
 * newline — `build()` adds it when writing to stdout.
 */
export function formatReport(report: BuildReport): string {
  const lines = [
    "kiln build",
    `  pages emitted: ${report.emitted.length}`,
    `  pages skipped (cache): ${report.skipped.length}`,
    `  duration: ${report.durationMs}ms`,
  ];
  if (report.featureErrors.length > 0) {
    lines.push(`  feature errors: ${report.featureErrors.length}`);
    for (const error of report.featureErrors) {
      const doc = error.doc === undefined ? "" : ` [doc ${error.doc}]`;
      lines.push(`    ${error.feature} (${error.hook}): ${error.message}${doc}`);
    }
  }
  return lines.join("\n");
}
