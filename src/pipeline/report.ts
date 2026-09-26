/**
 * The build report — `build()`'s single result shape and its one canonical
 * stdout rendering, so every caller (CLI, watch mode) reports identically.
 */
import type { FeatureError } from "../feature.ts";
import type { EmittedPage } from "../render/emit.ts";
import { formatKilnError } from "../errors.ts";
import type { KilnError } from "../errors.ts";

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

/**
 * Render the collected errors of a failed build to **stderr** (the normal
 * build report stays on stdout):
 *
 * ```text
 * kiln: build failed with 3 errors:
 *   1. [frontmatter] content/posts/broken.md: invalid frontmatter at line 4: …
 *   2. [template] templates/post.html:12 — unknown block tag "include"
 *   3. [feature src/features/feed.ts] feed.xml: cannot write feed — ENOSPC
 * ```
 *
 * The header counts every recorded error (pluralized at 1); identical
 * rendered lines — same stage, file, line, and message — collapse to one
 * entry suffixed ` (×N)`. Entries keep the pipeline order they were
 * recorded in; nothing is dropped as a "duplicate of an earlier stage".
 * A zero-length list prints nothing.
 */
export function printErrors(errors: readonly KilnError[]): void {
  if (errors.length === 0) return;

  const rendered: string[] = [];
  const counts = new Map<string, number>();
  for (const error of errors) {
    const line = formatKilnError(error);
    const seen = counts.get(line);
    if (seen === undefined) {
      counts.set(line, 1);
      rendered.push(line);
    } else {
      counts.set(line, seen + 1);
    }
  }

  const lines = [
    `kiln: build failed with ${errors.length} error${errors.length === 1 ? "" : "s"}:`,
  ];
  rendered.forEach((line, index) => {
    const count = counts.get(line) ?? 1;
    lines.push(`  ${index + 1}. ${line}${count > 1 ? ` (×${count})` : ""}`);
  });
  process.stderr.write(`${lines.join("\n")}\n`);
}
