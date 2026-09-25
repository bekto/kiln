/**
 * T021 acceptance — unicode/CJK word counting, conservative reading time,
 * `features.readingTime.wordsPerMinute` validation, and the template-visible
 * metrics a build actually renders.
 *
 * Unit tests drive `onDocument` with a FeatureContext standing in for
 * T012's (same `options(validate)` prefix contract, minus the report wiring
 * that belongs to T012's own tests); the build tests use a temp project
 * like `test/build.test.ts`, with command runs in-process (never spawning
 * the CLI, which could race `test/cli.test.ts`'s discovery).
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { run as runBuildCommand } from "../src/commands/build.ts";
import type { Document } from "../src/content/document.ts";
import type { FeatureContext } from "../src/feature.ts";
import readingTime from "../src/features/readingTime.ts";

/** A T004-shaped document with no I/O. */
function makeDoc(
  content: string,
): Document & { words?: number; readingTime?: number } {
  return { path: "/content/doc.md", data: {}, content };
}

/**
 * A FeatureContext standing in for T012's: same `options(validate)` shape
 * and the same `features.readingTime: ` re-throw prefix, so assertions see
 * exactly the message a real build records.
 */
function context(featureOptions: Record<string, unknown>): FeatureContext {
  return {
    name: "readingTime",
    flags: { drafts: false, future: false, noCache: false },
    options<T>(validate: (raw: unknown) => T): T {
      try {
        return validate(featureOptions["readingTime"]);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`features.readingTime: ${reason}`, { cause: error });
      }
    },
  };
}

/** Run `onDocument` over one body; returns the mutated document. */
function run(
  content: string,
  featureOptions: Record<string, unknown> = {},
): Document & { words?: number; readingTime?: number } {
  const doc = makeDoc(content);
  readingTime.onDocument!(doc, context(featureOptions));
  return doc;
}

/** A body of `count` whitespace-separated word tokens. */
function words(count: number): string {
  return Array.from({ length: count }, () => "word").join(" ");
}

test("200 words → words 200, readingTime 1; the 201st word → readingTime 2", () => {
  const body = words(200);
  const at200 = run(body);
  assert.equal(at200.data.words, 200);
  assert.equal(at200.data.readingTime, 1);
  // The ticket's literal `doc.words` / `doc.readingTime` placement, mirrored
  // beside the data-bag values templates render.
  assert.equal(at200.words, 200);
  assert.equal(at200.readingTime, 1);

  const at201 = run(`${body} extra`);
  assert.equal(at201.data.words, 201);
  assert.equal(at201.data.readingTime, 2);
});

test("CJK body 你好世界 → words 4, readingTime 1", () => {
  const doc = run("你好世界");
  assert.equal(doc.data.words, 4);
  assert.equal(doc.data.readingTime, 1);
});

test("mixed CJK/Latin token: Hello, 世界 → words 3", () => {
  assert.equal(run("Hello, 世界").data.words, 3);
});

test("unicode word rule: hello world → 2, 中文abc → 3, don't → 1", () => {
  assert.equal(run("hello world").data.words, 2);
  assert.equal(run("中文abc").data.words, 3);
  assert.equal(run("don't").data.words, 1);
});

test("markup not counted: **bold** and <em>x</em> → exactly 3 words", () => {
  assert.equal(run("**bold** and <em>x</em>").data.words, 3);
});

test("markup examples: **bold** → 1, # Heading → 2, <code>x</code> → 1", () => {
  assert.equal(run("**bold**").data.words, 1);
  assert.equal(run("# Heading").data.words, 2);
  assert.equal(run("<code>x</code>").data.words, 1);
});

test("fenced code blocks contribute no words; prose around them does", () => {
  const doc = run("intro\n```ts\nconst wordy = 1;\n```\noutro here");
  assert.equal(doc.data.words, 3);
  assert.equal(doc.data.readingTime, 1);
});

test("empty body → words 0, readingTime 1", () => {
  const doc = run("");
  assert.equal(doc.data.words, 0);
  assert.equal(doc.data.readingTime, 1);
  assert.equal(doc.words, 0);
  assert.equal(doc.readingTime, 1);
});

test("features.readingTime.wordsPerMinute 100 with 150 words → readingTime 2", () => {
  const doc = run(words(150), { readingTime: { wordsPerMinute: 100 } });
  assert.equal(doc.data.words, 150);
  assert.equal(doc.data.readingTime, 2);
});

test("invalid features.readingTime.wordsPerMinute fails naming the key", () => {
  for (const bad of ["fast", 0, -1, 1.5, null]) {
    assert.throws(
      () => run("Body.", { readingTime: { wordsPerMinute: bad } }),
      /features\.readingTime\.wordsPerMinute/,
      `wordsPerMinute ${String(bad)} must be rejected`,
    );
  }
});

test("a non-object features.readingTime slice fails naming the key", () => {
  assert.throws(
    () => run("Body.", { readingTime: 100 }),
    /features\.readingTime" must be a plain object/,
  );
});

/**
 * A fixture project: layout showing the metrics + one index page carrying
 * `body`; `features` optionally adds a kiln.config.ts whose `features`
 * map holds that value.
 */
const LAYOUT =
  '<!doctype html>\n<html lang="en"><head><title>{{ site.title }}</title></head>' +
  '<body>{{ content | safe }}<span id="stats">{{ page.words }}/{{ page.readingTime }}</span></body></html>\n';

function project(body: string, features?: string): Record<string, string> {
  const files: Record<string, string> = {
    "templates/post.html": LAYOUT,
    "content/index.md": ["---", "title: Home", "---", "", body, ""].join("\n"),
  };
  if (features !== undefined) {
    files["kiln.config.ts"] = `export default { features: ${features} };\n`;
  }
  return files;
}

/**
 * Materialize a project in the OS temp dir, chdir into it (T010 resolves
 * `templates/` against the cwd), run `fn`, then restore the cwd and clean up
 * — even when `fn` throws.
 */
async function withProject<T>(
  files: Record<string, string>,
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "kiln-readingtime-"));
  try {
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Run `fn` with stdout/stderr captured so printed reports stay off-runner. */
async function capture<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; stdout: string }> {
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
    return { value: await fn(), stdout: out.join("") };
  } finally {
    process.stdout.write = previousOut;
    process.stderr.write = previousErr;
  }
}

interface CommandRun {
  stdout: string;
  /** The `process.exitCode` this invocation left behind (`undefined` = 0). */
  exitCode: number | string | undefined;
}

/** Invoke `kiln build`'s `run` in-process with stdout + exitCode captured. */
async function runCommand(args: string[]): Promise<CommandRun> {
  const previousExit = process.exitCode;
  process.exitCode = undefined;
  try {
    const captured = await capture(() => runBuildCommand(args));
    return { stdout: captured.stdout, exitCode: process.exitCode };
  } finally {
    process.exitCode = previousExit;
  }
}

test("build: empty body → exit 0, page renders words 0, readingTime 1", async () => {
  await withProject(project(""), async (root) => {
    const run = await runCommand([]);
    assert.equal(run.exitCode, undefined, run.stdout);

    const html = await readFile(path.join(root, "dist", "index.html"), "utf8");
    assert.ok(html.includes('<span id="stats">0/1</span>'), html);
  });
});

test("build: features.readingTime.wordsPerMinute 100 → 150-word page renders 150/2", async () => {
  const config = "{ readingTime: { wordsPerMinute: 100 } }";
  await withProject(project(words(150), config), async (root) => {
    const run = await runCommand([]);
    assert.equal(run.exitCode, undefined, run.stdout);

    const html = await readFile(path.join(root, "dist", "index.html"), "utf8");
    assert.ok(html.includes('<span id="stats">150/2</span>'), html);
  });
});

test("build: invalid wordsPerMinute fails with exit 1 naming the key", async () => {
  for (const wpm of ["0", '"fast"']) {
    const config = `{ readingTime: { wordsPerMinute: ${wpm} } }`;
    await withProject(project("Body text.", config), async () => {
      const run = await runCommand([]);
      assert.equal(run.exitCode, 1, `wordsPerMinute=${wpm}`);
      assert.match(
        run.stdout,
        /src\/features\/readingTime\.ts \(onDocument\): /,
        `wordsPerMinute=${wpm}`,
      );
      assert.match(
        run.stdout,
        /features\.readingTime\.wordsPerMinute/,
        `wordsPerMinute=${wpm}`,
      );
    });
  }
});
