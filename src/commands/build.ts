/**
 * `kiln build` — the command half of the build: parse the flags T013's
 * publishing feature consumes through `ctx.flags`, run the orchestrator, and
 * map outcomes to T002's exit codes (usage error → 2, any recorded error →
 * 1, clean run → untouched). Discovered by T002's auto-discovery;
 * `src/cli.ts` never names this file.
 *
 * T031's failure mapping, in one place:
 * - fatal (`KilnError`, e.g. a broken `kiln.config.ts` or an unexpected
 *   orchestrator failure) → one `kiln: [stage] <message>` line on stderr,
 *   no report, `exitCode = 1`;
 * - collected (`BuildErrors`) → the numbered `printErrors` block on stderr
 *   after the normal stdout report, `exitCode = 1`;
 * - feature-only failures → T012's stdout report block unchanged,
 *   `exitCode = 1`; a clean run prints nothing extra.
 */
import type { BuildFlags } from "../feature.ts";
import { build } from "../pipeline/build.ts";
import { BuildErrors, formatKilnError, KilnError } from "../errors.ts";
import { printErrors } from "../pipeline/report.ts";

export const name = "build";
export const description = "Build the site";

const USAGE = "usage: kiln build [--drafts] [--future] [--no-cache]";

export async function run(args: string[]): Promise<void> {
  const flags: BuildFlags = { drafts: false, future: false, noCache: false };
  for (const arg of args) {
    if (arg === "--drafts") flags.drafts = true;
    else if (arg === "--future") flags.future = true;
    else if (arg === "--no-cache") flags.noCache = true;
    else {
      // Usage error (unknown flag or any positional): stderr listing the
      // supported flags, exit 2 — build never runs.
      process.stderr.write(
        `kiln: ${name}: unknown argument '${arg}'\n${USAGE}\n`,
      );
      process.exitCode = 2;
      return;
    }
  }

  try {
    const report = await build({ flags });
    if (report.featureErrors.length > 0) process.exitCode = 1;
  } catch (error) {
    if (error instanceof BuildErrors) {
      // Collected failures: the report already printed to stdout; the
      // numbered block goes to stderr, one entry per distinct failure.
      printErrors(error.errors);
      process.exitCode = 1;
      return;
    }
    if (error instanceof KilnError) {
      // Fatal (config/setup): a single line, no report, no numbered block.
      process.stderr.write(`kiln: ${formatKilnError(error)}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}
