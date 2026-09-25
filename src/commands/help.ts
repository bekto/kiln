import type { Command } from "../cli.ts";
import { discoverCommands } from "../cli.ts";

export const name = "help";
export const description = "Show available commands";

function renderHelp(commands: readonly Command[]): string {
  const sorted = [...commands].sort((a, b) => a.name.localeCompare(b.name));
  const width = Math.max(...sorted.map((c) => c.name.length));
  const lines = sorted.map(
    (c) =>
      `  ${c.name.padEnd(width)}${
        c.description === undefined ? "" : `  ${c.description}`
      }`.trimEnd(),
  );
  return `Usage: kiln <command> [args]\n\nCommands:\n${lines.join("\n")}\n`;
}

export async function run(_args: string[]): Promise<void> {
  process.stdout.write(renderHelp(await discoverCommands()));
}
