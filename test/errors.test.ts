/**
 * T031 acceptance — structured `KilnError`, the fatal-vs-collected policy,
 * the numbered stderr block, dedupe, and T002's exit codes.
 *
 * Command behavior is exercised in-process (streams + `process.exitCode`
 * captured) exactly like `test/build.test.ts`, so no test spawns the CLI
 * except the unknown-command exit-2 pin.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, after } from "node:test";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.ts";
import { run as runBuildCommand } from "../src/commands/build.ts";
import { parseDocument } from "../src/content/document.ts";
import { discover } from "../src/content/discover.ts";
import { formatKilnError, KilnError } from "../src/errors.ts";
import { loadTemplates } from "../src/render/templates.ts";
import { printErrors } from "../src/pipeline/report.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(TEST_DIR);
const CLI = path.join(REPO, "src", "cli.ts");
const FEATURES_DIR = path.join(REPO, "src", "features");

const LAYOUT =
  '<!doctype html>\n<html lang="en"><head><title>{{ site.title }}</title></head>' +
  "<body>{{ content | safe }}</body></html>\n";

const tempRoots: string[] = [];

after(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

/**
 * Run `fn` with `process.stdout`/`process.stderr` writes captured (withheld
 * from the runner's stream); the originals are restored even when `fn`
 * throws.
 */
async function capture<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const previousOut = process.stdout.write;
  const previousErr = process.stderr.write;
  process.stdout.write = ((chunk: unknown): boolean => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown): boolean => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const value = await fn();
    return { value, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = previousOut;
    process.stderr.write = previousErr;
  }
}

/** Invoke `kiln build`'s `run` in-process with streams + exitCode captured. */
async function runCommand(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | string | undefined;
}> {
  const previousExit = process.exitCode;
  process.exitCode = undefined;
  try {
    const captured = await capture(() => runBuildCommand(args));
    return {
      stdout: captured.stdout,
      stderr: captured.stderr,
      exitCode: process.exitCode,
    };
  } finally {
    process.exitCode = previousExit;
  }
}

/**
 * Materialize a project in the OS temp dir, chdir into it (the pipeline
 * resolves `templates/` against the cwd), run `fn`, then restore the cwd and
 * clean up — even when `fn` throws.
 */
async function withProject<T>(
  files: Record<string, string>,
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "kiln-errors-"));
  tempRoots.push(root);
  for (const [name, source] of Object.entries(files)) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source, "utf8");
  }
  const previous = process.cwd();
  process.chdir(root);
  try {
    return await fn(root);
  } finally {
    process.chdir(previous);
  }
}

/**
 * Write probe feature modules into the repo's `src/features/`, run `fn`,
 * then delete them — cleanup runs even when `fn` or an assertion throws.
 */
async function withFeatures<T>(
  files: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  await mkdir(FEATURES_DIR, { recursive: true });
  const targets = Object.keys(files).map((file) => path.join(FEATURES_DIR, file));
  for (const [file, source] of Object.entries(files)) {
    await writeFile(path.join(FEATURES_DIR, file), source, "utf8");
  }
  try {
    return await fn();
  } finally {
    await Promise.all(targets.map((target) => rm(target, { force: true })));
    if ((await readdir(FEATURES_DIR)).length === 0) {
      await rm(FEATURES_DIR, { recursive: true });
    }
  }
}

/** Three broken posts (bad YAML on line 2) and two good ones. */
function brokenPostsFixture(): Record<string, string> {
  const files: Record<string, string> = {
    "templates/post.html": LAYOUT,
    "content/posts/good1.md": "---\ntitle: Good One\ndate: 2026-01-01\n---\nHello **world**.\n",
    "content/other.md": "---\ntitle: Other\n---\nSecond.\n",
  };
  for (const name of ["broken1.md", "broken2.md", "broken3.md"]) {
    files[`content/posts/${name}`] = "---\ntitle: a: b\n---\nBody\n";
  }
  return files;
}

// ---------------------------------------------------------------------------
// The error type itself.
// ---------------------------------------------------------------------------

test("KilnError: stage, structured position, cause; omitted fields stay undefined", () => {
  const cause = new Error("root");
  const error = new KilnError("template", "t.html: boom", {
    file: "templates/t.html",
    line: 7,
    col: 3,
    cause,
  });
  assert.ok(error instanceof Error);
  assert.equal(error.stage, "template");
  assert.equal(error.file, "templates/t.html");
  assert.equal(error.line, 7);
  assert.equal(error.col, 3);
  assert.equal(error.cause, cause);
  assert.equal(error.message, "t.html: boom");

  // No position → omitted, never -1.
  const bare = new KilnError("build", "boom");
  assert.equal(bare.file, undefined);
  assert.equal(bare.line, undefined);
  assert.equal(bare.col, undefined);
  assert.equal(bare.cause, undefined);
});

test("formatKilnError: [stage] tag, feature tag carries the module path", () => {
  assert.equal(
    formatKilnError(new KilnError("frontmatter", "a.md: bad")),
    "[frontmatter] a.md: bad",
  );
  assert.equal(
    formatKilnError(
      new KilnError("feature", "cannot write feed", {
        featureFile: "src/features/feed.ts",
      }),
    ),
    "[feature src/features/feed.ts] cannot write feed",
  );
  assert.equal(
    formatKilnError(new KilnError("feature", "no file")),
    "[feature] no file",
  );
});

// ---------------------------------------------------------------------------
// Structured sources: frontmatter and discovery.
// ---------------------------------------------------------------------------

test("frontmatter failure: stage frontmatter, file, exact line (col from the parser), T004 message intact", () => {
  const source = "---\nok: 1\ntitle: a: b\n---\nBody\n";
  const filePath = path.join(REPO, "content", "posts", "broken.md");
  let caught: unknown;
  try {
    parseDocument(filePath, source);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof KilnError, "parseDocument throws a KilnError");
  const error = caught;
  assert.equal(error.stage, "frontmatter");
  assert.equal(error.file, path.join("content", "posts", "broken.md"));
  assert.equal(error.line, 3, "the bad mapping value sits on line 3");
  assert.equal(typeof error.col, "number");
  assert.ok(error.col! >= 1);
  // T004's contract: path + line substring, byte-identical.
  assert.ok(error.message.includes(filePath), error.message);
  assert.ok(error.message.includes("line 3"), error.message);
  assert.ok(error.cause instanceof Error, "parser exception kept as cause");
});

test("discover's sink: every broken document recorded in sorted order, good pages kept", async () => {
  await withProject(brokenPostsFixture(), async (root) => {
    const contentDir = path.join(root, "content");
    const errors: unknown[] = [];
    const site = await discover({
      contentDir,
      onError: (error) => errors.push(error),
    });

    // Three collected frontmatter errors, discovery order = sorted paths.
    assert.equal(errors.length, 3);
    const names = errors.map(
      (error) => (error as KilnError).file,
    );
    assert.deepEqual(names, [
      path.join("content", "posts", "broken1.md"),
      path.join("content", "posts", "broken2.md"),
      path.join("content", "posts", "broken3.md"),
    ]);
    for (const error of errors) {
      assert.ok(error instanceof KilnError);
      assert.equal((error as KilnError).stage, "frontmatter");
      assert.match((error as KilnError).message, /invalid frontmatter at line 2: /);
    }

    // The good documents still became pages, path-sorted.
    assert.deepEqual(
      site.pages.map((page) => page.path),
      [
        path.join(contentDir, "other.md"),
        path.join(contentDir, "posts", "good1.md"),
      ],
    );
  });
});

// ---------------------------------------------------------------------------
// Fatal vs collected, end to end through `kiln build`.
// ---------------------------------------------------------------------------

test("three broken posts: exit 1, numbered [frontmatter] block, good pages still emitted", async () => {
  await withProject(brokenPostsFixture(), async (root) => {
    const run = await runCommand([]);
    assert.equal(run.exitCode, 1);
    assert.match(run.stderr, /^kiln: build failed with 3 errors:$/m);
    const entries = run.stderr.split("\n").filter((line) => /^  \d+\. /.test(line));
    assert.equal(entries.length, 3);
    entries.forEach((entry, index) => {
      assert.ok(
        entry.includes(`broken${index + 1}.md`),
        `entry ${index + 1} must name broken${index + 1}.md: ${entry}`,
      );
      assert.ok(entry.includes("[frontmatter]"), entry);
      assert.ok(entry.includes("invalid frontmatter at line 2"), entry);
    });

    // The normal report still prints to stdout; good pages are on disk.
    assert.match(run.stdout, /^kiln build$/m);
    assert.match(run.stdout, /^ {2}pages emitted: 2$/m);
    await readFile(path.join(root, "dist", "posts", "good1", "index.html"), "utf8");
    await readFile(path.join(root, "dist", "other", "index.html"), "utf8");
    await assert.rejects(
      readFile(path.join(root, "dist", "posts", "broken1", "index.html"), "utf8"),
      { code: "ENOENT" },
    );
  });
});

test("one page's template failure: [template] entry with the line, every other page emitted", async () => {
  const files: Record<string, string> = {
    "templates/post.html": LAYOUT,
    // The typo sits on line 2 of the failing layout.
    "templates/bad.html": "<!doctype html>\n<html><body>{{ titel }}</body></html>\n",
    "content/posts/uses-bad.md": "---\ntitle: Uses Bad\nlayout: bad\n---\nHi\n",
    "content/posts/uses-good.md": "---\ntitle: Uses Good\n---\nHi\n",
  };
  await withProject(files, async (root) => {
    // Structured fields on the caught error…
    const templates = await loadTemplates(path.join(root, "templates"));
    let caught: unknown;
    try {
      await templates.renderDocument(
        {
          path: path.join(root, "content", "posts", "uses-bad.md"),
          data: { layout: "bad" },
          content: "Hi",
          url: "/uses-bad/",
        },
        { url: "/uses-bad/", site: {} },
      );
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof KilnError);
    assert.equal((caught as KilnError).stage, "template");
    assert.equal((caught as KilnError).file, path.join("templates", "bad.html"));
    assert.equal((caught as KilnError).line, 2);

    // …and through the command: one entry, the good page emitted.
    const run = await runCommand([]);
    assert.equal(run.exitCode, 1);
    assert.match(run.stderr, /^kiln: build failed with 1 error:$/m);
    assert.match(
      run.stderr,
      /^ {2}1\. \[template\] bad\.html: line 2: undefined variable "titel"$/m,
    );
    assert.equal(run.stderr.split("\n").filter((line) => /^  \d+\. /.test(line)).length, 1);
    assert.match(run.stdout, /^ {2}pages emitted: 1$/m);
    await readFile(path.join(root, "dist", "posts", "uses-good", "index.html"), "utf8");
    await assert.rejects(
      readFile(path.join(root, "dist", "posts", "uses-bad", "index.html"), "utf8"),
      { code: "ENOENT" },
    );
  });
});

test("the same template error on three pages collapses to one (×3) entry", async () => {
  const files: Record<string, string> = {
    "templates/post.html": "<!doctype html>\n<html><body>{{ titel }}</body></html>\n",
    "content/posts/a.md": "---\ntitle: A\n---\nHi\n",
    "content/posts/b.md": "---\ntitle: B\n---\nHi\n",
    "content/posts/c.md": "---\ntitle: C\n---\nHi\n",
  };
  await withProject(files, async () => {
    const run = await runCommand([]);
    assert.equal(run.exitCode, 1);
    assert.match(run.stderr, /^kiln: build failed with 3 errors:$/m);
    const entries = run.stderr.split("\n").filter((line) => /^  \d+\. /.test(line));
    assert.equal(entries.length, 1, `expected one collapsed entry:\n${run.stderr}`);
    assert.match(entries[0], /^ {2}1\. \[template\] post\.html: line 2: undefined variable "titel" \(×3\)$/);
  });
});

test("a feature hook that throws: stdout report tags the file, siblings' outputs intact, exit 1", async () => {
  const PROBE = [
    "export default {",
    "  onBuildEnd() {",
    "    throw new Error('boom');",
    "  },",
    "};",
    "",
  ].join("\n");
  await withProject(
    {
      "templates/post.html": LAYOUT,
      "content/posts/a.md": "---\ntitle: A\ndate: 2026-01-01\n---\nHi\n",
    },
    async (root) => {
      await withFeatures({ "zzprobe.ts": PROBE }, async () => {
        const run = await runCommand([]);
        assert.equal(run.exitCode, 1);
        // Feature-only failures keep T012's contract: stdout report, no
        // stderr block (T013 pins stderr empty for exactly this shape).
        assert.equal(run.stderr, "");
        assert.match(run.stdout, /^ {2}feature errors: 1$/m);
        assert.match(
          run.stdout,
          /^ {4}src\/features\/zzprobe\.ts \(onBuildEnd\): boom$/m,
        );
        // Every other feature's outputs exist — sitemap and feed write in
        // their own onBuildEnd hooks, sorted before the probe.
        await readFile(path.join(root, "dist", "sitemap.xml"), "utf8");
        await readFile(path.join(root, "dist", "feed.xml"), "utf8");
        await readFile(path.join(root, "dist", "posts", "a", "index.html"), "utf8");
      });
    },
  );
});

test("mixed failures: [frontmatter] then [feature …] in one block, pipeline order", async () => {
  const PROBE =
    "export default { onBuildEnd() { throw new Error('boom'); } };\n";
  await withProject(brokenPostsFixture(), async () => {
    await withFeatures({ "zzprobe.ts": PROBE }, async () => {
      const run = await runCommand([]);
      assert.equal(run.exitCode, 1);
      assert.match(run.stderr, /^kiln: build failed with 4 errors:$/m);
      assert.match(
        run.stderr,
        /^ {2}1\. \[frontmatter\] .*broken1\.md: invalid frontmatter at line 2: /m,
      );
      assert.match(
        run.stderr,
        /^ {2}4\. \[feature src\/features\/zzprobe\.ts\] boom$/m,
      );
      // The stdout feature block is still there too.
      assert.match(run.stdout, /^ {2}feature errors: 1$/m);
    });
  });
});

test("invalid config: single [config] line, no numbered block, no dist, exit 1", async () => {
  await withProject(
    {
      "kiln.config.ts": "export default { port: 70000 };\n",
      "templates/post.html": LAYOUT,
      "content/posts/a.md": "---\ntitle: A\n---\nHi\n",
    },
    async (root) => {
      const run = await runCommand([]);
      assert.equal(run.exitCode, 1);
      assert.equal(
        run.stderr,
        'kiln: [config] kiln.config.ts: "port" must be an integer in 1..65535 (got number)\n',
      );
      assert.ok(!run.stderr.includes("build failed with"), run.stderr);
      assert.equal(run.stdout, "", "no report for a fatal config failure");
      await assert.rejects(stat(path.join(root, "dist")), { code: "ENOENT" });
    },
  );
});

test("config syntax failure records the stage, file, and an extractable line", async () => {
  await withProject(
    { "kiln.config.ts": "export default { site: {\n" },
    async (root) => {
      let caught: unknown;
      try {
        await loadConfig(root);
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof KilnError, "loadConfig throws a KilnError");
      const error = caught;
      assert.equal(error.stage, "config");
      assert.equal(error.file, "kiln.config.ts");
      assert.equal(typeof error.line, "number");
      assert.ok(error.line! >= 1);
      // T003's contract: the absolute config path is still in the message.
      assert.ok(error.message.includes(path.join(root, "kiln.config.ts")), error.message);
      assert.equal(formatKilnError(error).startsWith("[config] "), true);
    },
  );
});

test("emit write failure: [emit] entry with the code, other writes proceed", async () => {
  const files: Record<string, string> = {
    "templates/post.html": LAYOUT,
    "content/index.md": "---\ntitle: Home\n---\nHome.\n",
    "content/posts/b.md": "---\ntitle: B\n---\nBody.\n",
  };
  await withProject(files, async (root) => {
    // A directory squatting on the index target: that one write fails
    // (EISDIR), every other write must still land.
    await mkdir(path.join(root, "dist", "index.html"), { recursive: true });
    const run = await runCommand([]);
    assert.equal(run.exitCode, 1);
    assert.match(run.stderr, /^kiln: build failed with 1 error:$/m);
    assert.match(run.stderr, /^ {2}1\. \[emit\] /m);
    assert.ok(run.stderr.includes("EISDIR"), run.stderr);
    assert.ok(run.stderr.includes(path.join("dist", "index.html")), run.stderr);
    assert.match(run.stdout, /^ {2}pages emitted: 1$/m);
    await readFile(path.join(root, "dist", "posts", "b", "index.html"), "utf8");
  });
});

test("markdown fence crash: [markdown] entry naming the source .md; other pages emit", async () => {
  const FENCE = [
    "export default {",
    "  extendMarkdown(md) {",
    '    md.renderer.rules.fence = () => { throw new Error("fence boom"); };',
    "  },",
    "};",
    "",
  ].join("\n");
  const files: Record<string, string> = {
    "templates/post.html": LAYOUT,
    "content/posts/fenced.md": "---\ntitle: Fenced\n---\n```js\ncode\n```\n",
    "content/plain.md": "---\ntitle: Plain\n---\nNo fences here.\n",
  };
  await withProject(files, async (root) => {
    await withFeatures({ "zzfence.ts": FENCE }, async () => {
      const run = await runCommand([]);
      assert.equal(run.exitCode, 1);
      assert.match(run.stderr, /^kiln: build failed with 1 error:$/m);
      assert.match(run.stderr, /^ {2}1\. \[markdown\] /m);
      assert.ok(
        run.stderr.includes(path.join(root, "content", "posts", "fenced.md")),
        run.stderr,
      );
      assert.ok(run.stderr.includes("fence boom"), run.stderr);
      // The fenceless page still rendered and emitted; a render-time
      // extension crash is not recorded as a feature error.
      assert.doesNotMatch(run.stdout, /feature errors/);
      assert.match(run.stdout, /^ {2}pages emitted: 1$/m);
      await readFile(path.join(root, "dist", "plain", "index.html"), "utf8");
    });
  });
});

test("zero errors: no error block, exit 0; unknown command still exits 2", async () => {
  await withProject(
    {
      "templates/post.html": LAYOUT,
      "content/posts/good1.md": "---\ntitle: Good One\ndate: 2026-01-01\n---\nHello **world**.\n",
      "content/other.md": "---\ntitle: Other\n---\nSecond.\n",
    },
    async () => {
      const run = await runCommand([]);
      assert.equal(run.exitCode, undefined, "untouched exit code → success");
      assert.equal(run.stderr, "");
      assert.match(run.stdout, /^kiln build$/m);
      assert.doesNotMatch(run.stderr, /build failed/);
    },
  );

  const result = spawnSync(process.execPath, [CLI, "bogus"], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command 'bogus'/);
});

// ---------------------------------------------------------------------------
// printErrors rendering.
// ---------------------------------------------------------------------------

test("printErrors: silent when empty, singular/plural header, dedupe (×N), stable order", async () => {
  const frontmatter = new KilnError(
    "frontmatter",
    "content/broken.md: invalid frontmatter at line 2: boom",
    { file: "content/broken.md", line: 2 },
  );
  const template = new KilnError("template", "post.html: line 9: nope", {
    file: "templates/post.html",
    line: 9,
  });
  const feature = new KilnError("feature", "cannot write feed", {
    featureFile: "src/features/feed.ts",
  });

  const none = await capture(async () => printErrors([]));
  assert.equal(none.stderr, "");

  const one = await capture(async () => printErrors([frontmatter]));
  assert.equal(
    one.stderr,
    "kiln: build failed with 1 error:\n" +
      "  1. [frontmatter] content/broken.md: invalid frontmatter at line 2: boom\n",
  );

  // Identical rendered lines collapse; order follows first occurrence.
  const many = await capture(async () =>
    printErrors([frontmatter, template, frontmatter, feature, template, frontmatter]),
  );
  assert.equal(
    many.stderr,
    "kiln: build failed with 6 errors:\n" +
      "  1. [frontmatter] content/broken.md: invalid frontmatter at line 2: boom (×3)\n" +
      "  2. [template] post.html: line 9: nope (×2)\n" +
      "  3. [feature src/features/feed.ts] cannot write feed\n",
  );
});
