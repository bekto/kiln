#!/usr/bin/env node
import { glob } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Contract every module in `src/commands/` must satisfy. */
export interface Command {
  name: string;
  run: (args: string[]) => void | Promise<void>;
  description?: string;
}

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(SRC_DIR);
const COMMANDS_DIR = join(SRC_DIR, "commands");

function fail(code: number, msg: string): void {
  process.stderr.write(`kiln: ${msg}\n`);
  process.exitCode = code;
}

/**
 * Glob `src/commands/*.ts` (resolved from this file, not cwd), import each
 * file, and validate its named exports. Throws naming the offending file on
 * any malformed module or duplicate command name — never a silent skip.
 */
export async function discoverCommands(): Promise<Command[]> {
  const files: string[] = [];
  for await (const entry of glob("*.ts", { cwd: COMMANDS_DIR })) {
    files.push(join(COMMANDS_DIR, entry));
  }
  files.sort();

  const commands: Command[] = [];
  const owners = new Map<string, string>();
  for (const file of files) {
    const rel = relative(PROJECT_ROOT, file);
    let mod: Record<string, unknown>;
    try {
      // Runtime-selected: file list comes from the glob, so no static import can name it.
      mod = await import(pathToFileURL(file).href);
    } catch (err) {
      throw new Error(
        `${rel}: failed to load (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    if (typeof mod.name !== "string" || mod.name === "") {
      throw new Error(`${rel}: 'name' must be a non-empty string export`);
    }
    if (typeof mod.run !== "function") {
      throw new Error(
        `${rel}: 'run' must be a function export (got ${typeof mod.run})`,
      );
    }
    if (mod.description !== undefined && typeof mod.description !== "string") {
      throw new Error(
        `${rel}: 'description' must be a string export (got ${typeof mod.description})`,
      );
    }
    const prior = owners.get(mod.name);
    if (prior !== undefined) {
      throw new Error(
        `${rel} and ${prior}: duplicate command name '${mod.name}'`,
      );
    }
    owners.set(mod.name, rel);
    commands.push({
      name: mod.name,
      run: mod.run as Command["run"],
      ...(typeof mod.description === "string"
        ? { description: mod.description }
        : {}),
    });
  }
  return commands;
}

async function main(): Promise<void> {
  let commands: Command[];
  try {
    commands = await discoverCommands();
  } catch (err) {
    fail(1, err instanceof Error ? err.message : String(err));
    return;
  }

  const tokens = process.argv.slice(2);
  const name = tokens[0] ?? "help";
  const command = commands.find((c) => c.name === name);
  if (command === undefined) {
    const names = commands.map((c) => c.name).sort();
    fail(2, `unknown command '${name}'\ncommands: ${names.join(", ")}`);
    return;
  }

  try {
    await command.run(tokens.slice(1));
  } catch (err) {
    fail(1, err instanceof Error ? err.message : String(err));
  }
  // A command's own process.exitCode is honored: left untouched on success.
}

// No top-level await: this module must finish evaluating before dispatch
// reaches help.ts, which statically imports discoverCommands back from here.
const isEntry =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main().catch((err) =>
    fail(1, err instanceof Error ? err.message : String(err)),
  );
}
