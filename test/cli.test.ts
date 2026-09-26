import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(TEST_DIR);
const CLI = path.join(REPO, "src", "cli.ts");
const COMMANDS = path.join(REPO, "src", "commands");

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string = REPO): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Writes a temporary command module; cleanup runs even if `fn` throws. */
async function withCommandFile<T>(
  filename: string,
  source: string,
  fn: () => Promise<T>,
): Promise<T> {
  const file = path.join(COMMANDS, filename);
  await writeFile(file, source);
  try {
    return await fn();
  } finally {
    await rm(file, { force: true });
  }
}

test("no arguments prints help listing help and version, exit 0", () => {
  const { code, stdout, stderr } = runCli([]);
  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.match(stdout, /^Usage: kiln <command> \[args\]$/m);
  assert.match(stdout, /^\s+help\s{2,}Show available commands$/m);
  assert.match(stdout, /^\s+version\s{2,}Print the kiln version$/m);
  assert.ok(
    stdout.indexOf("  help") < stdout.indexOf("  version"),
    "commands listed alphabetically",
  );
  // T012/Wave 4 extended: all discovered commands are listed.
  assert.match(stdout, /^\s+build\s{2,}Build the site$/m);
  assert.match(stdout, /^\s+clean\s{2,}Remove the build output directory$/m);
  assert.match(stdout, /^\s+new\s{2,}Create a new content file$/m);
  assert.match(stdout, /^\s+serve\s{2,}Serve the built site$/m);
  assert.ok(
    stdout.indexOf("  build") < stdout.indexOf("  clean") &&
      stdout.indexOf("  clean") < stdout.indexOf("  help") &&
      stdout.indexOf("  help") < stdout.indexOf("  new") &&
      stdout.indexOf("  new") < stdout.indexOf("  serve") &&
      stdout.indexOf("  serve") < stdout.indexOf("  version"),
    "commands listed alphabetically",
  );
});

test("kiln help prints the same help, exit 0", () => {
  const noArgs = runCli([]);
  const help = runCli(["help"]);
  assert.equal(help.code, 0);
  assert.equal(help.stderr, "");
  assert.equal(help.stdout, noArgs.stdout);
});

test("kiln version prints kiln <version> from package.json, exit 0", async () => {
  const pkg = JSON.parse(
    await readFile(path.join(REPO, "package.json"), "utf8"),
  ) as { version: string };
  const { code, stdout, stderr } = runCli(["version"]);
  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.equal(stdout, `kiln ${pkg.version}\n`);
});

test("unknown command exits 2 and lists discovered commands on stderr", () => {
  const { code, stdout, stderr } = runCli(["bogus"]);
  assert.equal(code, 2);
  assert.equal(stdout, "");
  assert.match(stderr, /^kiln: unknown command 'bogus'$/m);
  // T012/Wave 4 extended: the discovered command list joins help and version.
  assert.match(stderr, /^commands: build, clean, help, new, serve, version$/m);
});

test("auto-discovery runs a dropped-in command file from any cwd", async () => {
  await withCommandFile(
    "__probe.ts",
    `export const name = "__probe";
export function run(args: string[]): void {
  console.log("probe ran:" + args.join("|"));
}
`,
    async () => {
      // cwd is "/", proving discovery resolves from import.meta.url, not cwd.
      const { code, stdout, stderr } = runCli(
        ["__probe", "alpha", "beta"],
        "/",
      );
      assert.equal(code, 0);
      assert.equal(stderr, "");
      assert.equal(stdout, "probe ran:alpha|beta\n");

      const help = runCli([]);
      assert.equal(help.code, 0);
      assert.match(
        help.stdout,
        /^\s+__probe$/m,
        "command without a description is listed name-only",
      );
    },
  );
});

test("a throwing command exits 1 with kiln: <message> on stderr", async () => {
  await withCommandFile(
    "__boom.ts",
    `export const name = "__boom";
export async function run(): Promise<void> {
  throw new Error("kaboom");
}
`,
    async () => {
      const { code, stdout, stderr } = runCli(["__boom"]);
      assert.equal(code, 1);
      assert.equal(stdout, "");
      assert.match(stderr, /^kiln: kaboom$/m);
    },
  );
});

test("a command setting process.exitCode itself is honored", async () => {
  await withCommandFile(
    "__exit.ts",
    `export const name = "__exit";
export function run(): void {
  process.exitCode = 7;
}
`,
    async () => {
      const { code } = runCli(["__exit"]);
      assert.equal(code, 7);
    },
  );
});

test("a module exporting a non-function run errors naming the file, exit 1", async () => {
  await withCommandFile(
    "__badrun.ts",
    `export const name = "__badrun";
export const run = "not a function";
`,
    async () => {
      const { code, stderr } = runCli(["version"]);
      assert.equal(code, 1);
      assert.match(stderr, /^kiln: /m);
      assert.match(stderr, /__badrun\.ts/);
      assert.match(stderr, /'run' must be a function/);
    },
  );
});

test("duplicate command names error naming both files, exit 1", async () => {
  const dup = `export const name = "__dup";
export function run(): void {}
`;
  await withCommandFile("__dup1.ts", dup, async () => {
    await withCommandFile("__dup2.ts", dup, async () => {
      const { code, stderr } = runCli([]);
      assert.equal(code, 1);
      assert.match(stderr, /duplicate command name '__dup'/);
      assert.match(stderr, /__dup1\.ts/);
      assert.match(stderr, /__dup2\.ts/);
    });
  });
});

test("only help and version command files exist; cli.ts never names them", async () => {
  const entries = (await readdir(COMMANDS))
    .filter((f) => !f.startsWith("__"))
    .sort();
  // T012/Wave 4 extended: build/clean/new/serve all ship as command files.
  assert.deepEqual(entries, [
    "build.ts",
    "clean.ts",
    "help.ts",
    "new.ts",
    "serve.ts",
    "version.ts",
  ]);
  const cliSource = await readFile(CLI, "utf8");
  assert.doesNotMatch(cliSource, /commands\/(?:build|serve|new|clean)/);
  assert.doesNotMatch(cliSource, /from ["'][^"']*commands\//);
});
