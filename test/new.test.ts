import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDocument } from "../src/content/document.ts";
import { slugify } from "../src/content/slug.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(path.dirname(TEST_DIR), "src", "cli.ts");

const tempRoots: string[] = [];

/** Create a unique temp project root; cleanup runs even if a test fails. */
async function makeProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kiln-new-test-"));
  tempRoots.push(root);
  return root;
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

after(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("kiln new creates a post with valid frontmatter, exit 0", async () => {
  const root = await makeProject();
  const res = runCli(["new", "Hello World"], root);
  assert.equal(res.code, 0);
  assert.equal(res.stdout, "created content/posts/hello-world.md\n");
  assert.equal(res.stderr, "");

  const target = path.join(root, "content", "posts", "hello-world.md");
  const doc = await readDocument(target);
  assert.equal(doc.data.title, "Hello World");
  assert.equal(doc.data.draft, true);
  const date = doc.data.date;
  assert.ok(date instanceof Date, "date must parse as a Date");
  assert.ok(
    Math.abs(Date.now() - date.getTime()) < 60_000,
    "date must be within the last minute",
  );
  assert.equal(doc.content, "", "body must be empty");

  // Full byte contract: verbatim title, second-precision ISO timestamp,
  // draft flag, closing fence, trailing newline — nothing after it.
  const raw = await readFile(target, "utf8");
  assert.match(
    raw,
    /^---\ntitle: Hello World\ndate: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\ndraft: true\n---\n$/,
  );
});

test("re-running the same title refuses with exit 1, file unchanged", async () => {
  const root = await makeProject();
  const first = runCli(["new", "Hello World"], root);
  assert.equal(first.code, 0);
  const target = path.join(root, "content", "posts", "hello-world.md");
  const before = await readFile(target);

  const second = runCli(["new", "Hello World"], root);
  assert.equal(second.code, 1);
  assert.equal(
    second.stderr,
    "kiln: content/posts/hello-world.md already exists\n",
  );
  assert.equal(second.stdout, "");
  const afterBytes = await readFile(target);
  assert.deepEqual(afterBytes, before, "refused file must stay byte-identical");
});

test("unicode title slugs through T005's slugify", async () => {
  const root = await makeProject();
  const res = runCli(["new", "Café ☕ Ñ"], root);
  assert.equal(res.code, 0);
  const filename = slugify("Café ☕ Ñ") + ".md";
  assert.match(filename, /[^\x00-\x7F]/, "non-ASCII must survive in the filename");
  assert.equal(res.stdout, `created content/posts/${filename}\n`);
  const doc = await readDocument(path.join(root, "content", "posts", filename));
  assert.equal(doc.data.title, "Café ☕ Ñ");
});

test("--dir pages creates the page collection", async () => {
  const root = await makeProject();
  const res = runCli(["new", "--dir", "pages", "About"], root);
  assert.equal(res.code, 0);
  assert.equal(res.stdout, "created content/pages/about.md\n");
  const doc = await readDocument(path.join(root, "content", "pages", "about.md"));
  assert.equal(doc.data.title, "About");
});

test("--dir with any other value exits 2 naming pages and posts", async () => {
  const root = await makeProject();
  const res = runCli(["new", "--dir", "tags", "X"], root);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /^kiln: new: /);
  assert.match(res.stderr, /\bpages\b/);
  assert.match(res.stderr, /\bposts\b/);
  await assert.rejects(access(path.join(root, "content")), { code: "ENOENT" });
});

test("usage errors: no title, empty title, bad flags all exit 2, write nothing", async () => {
  const root = await makeProject();
  for (const args of [["new"], ["new", ""], ["new", "--dir"], ["new", "--bogus", "X"]]) {
    const res = runCli(args, root);
    assert.equal(res.code, 2, `expected exit 2 for: ${JSON.stringify(args)}`);
    assert.match(res.stderr, /usage: kiln new <title> \[--dir <pages\|posts>\]/);
  }
  await assert.rejects(access(path.join(root, "content")), { code: "ENOENT" });
});

test("punctuation-only title creates untitled.md, then is refused", async () => {
  const root = await makeProject();
  const first = runCli(["new", "!!!"], root);
  assert.equal(first.code, 0);
  assert.equal(first.stdout, "created content/posts/untitled.md\n");

  const second = runCli(["new", "!!!"], root);
  assert.equal(second.code, 1);
  assert.equal(second.stderr, "kiln: content/posts/untitled.md already exists\n");
});

test("titles that look like YAML literals stay verbatim strings", async () => {
  const root = await makeProject();
  for (const title of ["123", "null", "true"]) {
    const res = runCli(["new", title], root);
    assert.equal(res.code, 0, `expected exit 0 for title ${JSON.stringify(title)}`);
    const doc = await readDocument(
      path.join(root, "content", "posts", `${slugify(title)}.md`),
    );
    assert.equal(doc.data.title, title);
    assert.equal(typeof doc.data.title, "string");
  }
});

test("contentDir from kiln.config.ts is honored", async () => {
  const root = await makeProject();
  await writeFile(
    path.join(root, "kiln.config.ts"),
    'export default { contentDir: "src/content" };\n',
    "utf8",
  );
  const res = runCli(["new", "Configured"], root);
  assert.equal(res.code, 0);
  assert.equal(res.stdout, "created src/content/posts/configured.md\n");
  const doc = await readDocument(
    path.join(root, "src", "content", "posts", "configured.md"),
  );
  assert.equal(doc.data.title, "Configured");
});
