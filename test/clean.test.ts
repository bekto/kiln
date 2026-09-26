/**
 * T025 acceptance — `kiln clean`.
 *
 * No test spawns the CLI: `test/cli.test.ts` creates temporary command files
 * in `src/commands/`, and command behavior is exercised by importing `run`
 * directly, with stdout/stderr and `process.exitCode` captured and restored
 * around every invocation. Thrown guard errors surface as `error` — the T002
 * CLI maps them to `kiln: <message>` on stderr and exit 1 (wiring already
 * proven in test/cli.test.ts).
 */
import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { run as runBuild } from "../src/commands/build.ts";
import { run as runClean } from "../src/commands/clean.ts";

/** Minimal strict layout, reused from test/build.test.ts's proven fixture. */
const LAYOUT =
  '<!doctype html>\n<html lang="en"><head><title>{{ site.title }}</title></head>' +
  "<body>{{ content | safe }}</body></html>\n";

const BUILD_PROJECT: Record<string, string> = {
  "templates/post.html": LAYOUT,
  "content/index.md": "---\ntitle: Home\n---\nHello **world**.",
  "content/posts/p.md": "---\ntitle: Post\ndate: 2026-01-01\n---\nBody text.",
  "public/app.css": "body{}",
};

interface CommandRun {
  stdout: string;
  stderr: string;
  /** The `process.exitCode` the invocation left behind (`undefined` = 0). */
  exitCode: number | string | undefined;
  /** Thrown by `run`; the CLI reports it as `kiln: <message>`, exit 1. */
  error?: Error;
}

/**
 * Invoke a command's `run` in-process with streams + exitCode captured and
 * restored, so printed output, usage-exit codes, and thrown guard errors are
 * all assertable — even when `fn` throws (the streams are still restored).
 */
async function runInProcess(
  fn: (args: string[]) => void | Promise<void>,
  args: string[],
): Promise<CommandRun> {
  const out: string[] = [];
  const err: string[] = [];
  const previousOut = process.stdout.write;
  const previousErr = process.stderr.write;
  const previousExit = process.exitCode;
  process.exitCode = undefined;
  process.stdout.write = ((chunk: unknown): boolean => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown): boolean => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  let exitCode: number | string | undefined = undefined;
  let error: Error | undefined = undefined;
  try {
    await fn(args);
  } catch (thrown) {
    error = thrown instanceof Error ? thrown : new Error(String(thrown));
  } finally {
    // `?? undefined` maps the declared `null` out of process.exitCode's type.
    exitCode = process.exitCode ?? undefined;
    process.stdout.write = previousOut;
    process.stderr.write = previousErr;
    process.exitCode = previousExit;
  }
  return { stdout: out.join(""), stderr: err.join(""), exitCode, error };
}

/**
 * Materialize `files` under `<base>/project`, chdir into it (`loadConfig`
 * reads the cwd), run `fn(root)`, then restore the cwd and clean up — even
 * when `fn` throws. The extra `project/` level keeps an `outDir:
 * "../outside"` fixture inside the disposable base dir.
 */
async function withProject<T>(
  files: Record<string, string>,
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const base = await mkdtemp(path.join(tmpdir(), "kiln-clean-"));
  const root = path.join(base, "project");
  try {
    await mkdir(root, { recursive: true });
    for (const [name, source] of Object.entries(files)) {
      const target = path.join(root, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, source);
    }
    const previous = process.cwd();
    process.chdir(root);
    try {
      return await fn(root);
    } finally {
      process.chdir(previous);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test("after kiln build, clean removes dist/ (cache file included), one success line, exit 0", async () => {
  await withProject(BUILD_PROJECT, async (root) => {
    // --no-cache keeps this test independent of T029's in-flight module.
    const built = await runInProcess(runBuild, ["--no-cache"]);
    assert.equal(built.error, undefined);
    assert.equal(built.exitCode, undefined);
    const dist = path.join(root, "dist");
    await readFile(path.join(dist, "index.html"), "utf8");
    // T029's cache file lives inside outDir and must go with it.
    await writeFile(path.join(dist, ".kiln-cache.json"), "{}");

    const cleaned = await runInProcess(runClean, []);
    assert.equal(cleaned.error, undefined);
    assert.equal(cleaned.exitCode, undefined);
    assert.equal(cleaned.stderr, "");
    assert.equal(cleaned.stdout, `removed ${dist}\n`);
    assert.equal(await exists(dist), false);
    // Nothing else: sources and templates survive.
    await readFile(path.join(root, "content", "index.md"), "utf8");
    await readFile(path.join(root, "templates", "post.html"), "utf8");
  });
});

test("second consecutive clean exits 0 with the nothing-to-clean note, no error output", async () => {
  await withProject({ "dist/f.txt": "x" }, async (root) => {
    const first = await runInProcess(runClean, []);
    assert.equal(first.error, undefined);
    assert.equal(await exists(path.join(root, "dist")), false);

    const second = await runInProcess(runClean, []);
    assert.equal(second.error, undefined);
    assert.equal(second.exitCode, undefined);
    assert.equal(second.stderr, "");
    assert.equal(
      second.stdout,
      `nothing to clean: ${path.join(root, "dist")} does not exist\n`,
    );
  });
});

test("clean on a project with no dist/ at all is a success no-op with the note", async () => {
  await withProject({ "content/index.md": "irrelevant" }, async (root) => {
    const run = await runInProcess(runClean, []);
    assert.equal(run.error, undefined);
    assert.equal(run.exitCode, undefined);
    assert.equal(run.stderr, "");
    assert.equal(
      run.stdout,
      `nothing to clean: ${path.join(root, "dist")} does not exist\n`,
    );
  });
});

test("--dry-run prints target, children, and 'would remove N entries'; deletes nothing", async () => {
  await withProject(
    { "dist/f.txt": "hello", "dist/sub/g.txt": "nested" },
    async (root) => {
      const dist = path.join(root, "dist");
      const fileBefore = await readFile(path.join(dist, "f.txt"), "utf8");
      const nestedBefore = await readFile(path.join(dist, "sub", "g.txt"), "utf8");

      const run = await runInProcess(runClean, ["--dry-run"]);
      assert.equal(run.error, undefined);
      assert.equal(run.exitCode, undefined);
      assert.equal(run.stderr, "");
      // Resolved target, each *immediate* child, exact summary line.
      assert.ok(run.stdout.includes(dist), `target listed in: ${run.stdout}`);
      assert.ok(run.stdout.includes(path.join(dist, "f.txt")));
      assert.ok(run.stdout.includes(path.join(dist, "sub")));
      assert.doesNotMatch(run.stdout, /g\.txt/, "only immediate children");
      assert.match(run.stdout, /^would remove 2 entries$/m);

      // Byte-identical afterward.
      assert.equal(await readFile(path.join(dist, "f.txt"), "utf8"), fileBefore);
      assert.equal(
        await readFile(path.join(dist, "sub", "g.txt"), "utf8"),
        nestedBefore,
      );
    },
  );
});

test("unknown arguments are usage errors: exit 2, nothing removed", async () => {
  await withProject({ "dist/f.txt": "x" }, async (root) => {
    for (const bad of [["--force"], ["dist"]]) {
      const run = await runInProcess(runClean, bad);
      assert.equal(run.error, undefined);
      assert.equal(run.exitCode, 2);
      assert.equal(run.stdout, "");
      assert.ok(
        run.stderr.includes(`kiln: clean: unknown argument '${bad[0]}'`),
        `stderr: ${run.stderr}`,
      );
      assert.ok(run.stderr.includes("usage: kiln clean [--dry-run]"));
      assert.equal(await exists(path.join(root, "dist", "f.txt")), true);
    }
  });
});

test("outDir '../outside' is refused: message names outDir + resolved path, nothing removed", async () => {
  const config = 'export default { outDir: "../outside" };\n';
  await withProject({ "kiln.config.ts": config }, async (root) => {
    const outside = path.resolve(root, "..", "outside");
    await mkdir(outside, { recursive: true });
    const secret = path.join(outside, "secret.txt");
    await writeFile(secret, "precious");

    const run = await runInProcess(runClean, []);
    const error = run.error;
    assert.ok(error, "clean must throw for an out-of-root target");
    assert.ok(error.message.includes("outDir"), error.message);
    assert.ok(error.message.includes("'../outside'"), error.message);
    assert.ok(error.message.includes(outside), error.message);
    assert.equal(run.stdout, ""); // zero deletions, no success line
    assert.equal(await readFile(secret, "utf8"), "precious");
  });
});

test("outDir '.' is refused: project files intact", async () => {
  const config = 'export default { outDir: "." };\n';
  await withProject(
    { "kiln.config.ts": config, "content/keep.md": "keep me" },
    async (root) => {
      const run = await runInProcess(runClean, []);
      const error = run.error;
      assert.ok(error, "clean must refuse the project root");
      assert.ok(error.message.includes("outDir"), error.message);
      assert.ok(error.message.includes("'.'"), error.message);
      assert.ok(error.message.includes(root), error.message);
      assert.equal(run.stdout, "");
      assert.equal(await readFile(path.join(root, "content", "keep.md"), "utf8"), "keep me");
      await readFile(path.join(root, "kiln.config.ts"), "utf8");
    },
  );
});

test("outDir pointing at an existing regular file: error naming the path, file intact", async () => {
  const config = 'export default { outDir: "build.txt" };\n';
  await withProject(
    { "kiln.config.ts": config, "build.txt": "not a directory" },
    async (root) => {
      const run = await runInProcess(runClean, []);
      const error = run.error;
      assert.ok(error, "clean must refuse a non-directory target");
      assert.ok(
        error.message.includes(path.join(root, "build.txt")),
        error.message,
      );
      assert.equal(run.stdout, "");
      assert.equal(
        await readFile(path.join(root, "build.txt"), "utf8"),
        "not a directory",
      );
    },
  );
});

test("outDir '/' (filesystem root) is refused before anything else", async () => {
  const config = 'export default { outDir: "/" };\n';
  await withProject({ "kiln.config.ts": config }, async (root) => {
    const run = await runInProcess(runClean, []);
    const error = run.error;
    assert.ok(error, "clean must refuse the filesystem root");
    assert.ok(error.message.includes("outDir '/'"), error.message);
    assert.ok(error.message.includes(`filesystem root '/'`), error.message);
    assert.equal(run.stdout, "");
    // The fixture project itself is untouched.
    await readFile(path.join(root, "kiln.config.ts"), "utf8");
  });
});
