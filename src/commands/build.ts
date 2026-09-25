/**
 * `kiln build` — the command half of the build: parse the flags T013's
 * publishing feature consumes through `ctx.flags`, run the orchestrator, and
 * map outcomes to T002's exit codes (usage error → 2, feature failures → 1,
 * non-feature failures propagate to the CLI's `kiln: <message>` / exit 1).
 * Discovered by T002's auto-discovery; `src/cli.ts` never names this file.
 */
import type { BuildFlags } from "../feature.ts";
import { build } from "../pipeline/build.ts";

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

  const report = await build({ flags });
  if (report.featureErrors.length > 0) process.exitCode = 1;
}
