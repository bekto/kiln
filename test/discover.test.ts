import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discover } from "../src/content/discover.ts";

const tempDirs: string[] = [];

/** Create a temp dir that is removed when the suite finishes. */
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kiln-discover-test-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * Write `files` (relPath → contents) under a fresh `content/` directory and
 * return that directory's absolute path.
 */
async function makeContentDir(files: Record<string, string>): Promise<string> {
  const contentDir = path.join(await makeTempDir(), "content");
  await mkdir(contentDir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(contentDir, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body, "utf8");
  }
  return contentDir;
}

/** Run discover and return the rejection, failing if it resolves. */
async function expectDiscoverError(contentDir: string): Promise<Error> {
  try {
    await discover({ contentDir });
  } catch (error) {
    assert.ok(error instanceof Error, `expected an Error, got ${typeof error}`);
    return error;
  }
  return assert.fail("discover() resolved but was expected to reject");
}

/** One-file fixture → discover must reject naming that file per T004. */
async function assertParseFailure(
  body: string,
  pattern: RegExp,
): Promise<void> {
  const contentDir = await makeContentDir({ "bad.md": body });
  const error = await expectDiscoverError(contentDir);
  assert.ok(
    error.message.includes(path.join(contentDir, "bad.md")),
    `expected ${JSON.stringify(error.message)} to name the source file`,
  );
  assert.match(error.message, pattern);
}

after(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

test("minimal fixture: both pages found, path sorted ascending, default urls", async () => {
  const contentDir = await makeContentDir({
    "index.md": "# Home\n",
    "posts/hello.md": "# Hello\n",
  });
  const site = await discover({ contentDir });
  assert.deepEqual(
    site.pages.map((page) => page.path),
    [
      path.join(contentDir, "index.md"),
      path.join(contentDir, "posts", "hello.md"),
    ],
  );
  assert.deepEqual(
    site.pages.map((page) => page.url),
    ["/", "/posts/hello/"],
  );
  assert.deepEqual(site.data, {});
});

test("underscore/hidden segments and non-markdown files are excluded", async () => {
  const contentDir = await makeContentDir({
    "about.md": "# About\n",
    "_partials/intro.md": "not content\n",
    ".hidden.md": "not content\n",
    "notes.txt": "not markdown\n",
  });
  const site = await discover({ contentDir });
  assert.deepEqual(
    site.pages.map((page) => path.relative(contentDir, page.path)),
    ["about.md"],
  );
});

test("collection defaults by relPath; a user-provided value is preserved", async () => {
  const contentDir = await makeContentDir({
    "about.md": "# About\n",
    "index.md": "# Home\n",
    "posts/hello.md": "# Hello\n",
  });
  const site = await discover({ contentDir });
  const collectionOf = (rel: string): unknown =>
    site.pages.find((page) => page.path === path.join(contentDir, rel))?.data
      .collection;
  assert.equal(collectionOf("posts/hello.md"), "posts");
  assert.equal(collectionOf("about.md"), "pages");
  assert.equal(collectionOf("index.md"), "pages");

  const customDir = await makeContentDir({
    "about.md": "---\ncollection: posts\n---\n# About\n",
  });
  const customSite = await discover({ contentDir: customDir });
  assert.equal(customSite.pages[0].data.collection, "posts");
});

test("permalink template expands through T005 with the document date", async () => {
  const contentDir = await makeContentDir({
    "posts/hello.md": '---\npermalink: "/posts/:year/:slug/"\ndate: 2026-09-25\n---\nHello\n',
  });
  const site = await discover({ contentDir });
  assert.equal(site.pages[0].url, "/posts/2026/hello/");
});

test("non-string permalink rejects naming the file and the field", async () => {
  const contentDir = await makeContentDir({
    "posts/hello.md": "---\npermalink: 42\n---\nHello\n",
  });
  const error = await expectDiscoverError(contentDir);
  assert.ok(
    error.message.includes(path.join(contentDir, "posts", "hello.md")),
    `expected ${JSON.stringify(error.message)} to name the source file`,
  );
  assert.match(error.message, /"permalink" must be a string \(got number\)/);
});

test("unknown permalink placeholder rejects naming the file and the placeholder", async () => {
  const contentDir = await makeContentDir({
    "posts/hello.md": '---\npermalink: "/:nope/"\n---\nHello\n',
  });
  const error = await expectDiscoverError(contentDir);
  assert.ok(
    error.message.includes(path.join(contentDir, "posts", "hello.md")),
    `expected ${JSON.stringify(error.message)} to name the source file`,
  );
  assert.ok(error.message.includes(":nope"), error.message);
});

test("date-requiring placeholder failure names the file too", async () => {
  const contentDir = await makeContentDir({
    "posts/hello.md": '---\npermalink: "/posts/:year/"\n---\nHello\n',
  });
  const error = await expectDiscoverError(contentDir);
  assert.ok(
    error.message.includes(path.join(contentDir, "posts", "hello.md")),
    `expected ${JSON.stringify(error.message)} to name the source file`,
  );
  assert.ok(
    error.message.includes('placeholder ":year" requires a date'),
    error.message,
  );
});

test("missing contentDir rejects with content directory not found", async () => {
  const contentDir = path.join(await makeTempDir(), "content");
  const error = await expectDiscoverError(contentDir);
  assert.ok(error.message.includes("content directory not found"), error.message);
  assert.ok(error.message.includes(contentDir), error.message);
});

test("empty contentDir rejects with no markdown files found", async () => {
  const contentDir = await makeContentDir({});
  const error = await expectDiscoverError(contentDir);
  assert.ok(error.message.includes("no markdown files found"), error.message);
  assert.ok(error.message.includes(contentDir), error.message);
});

test("zero matching files (only excluded ones) also rejects", async () => {
  const contentDir = await makeContentDir({
    "notes.txt": "not markdown\n",
    "_partials/intro.md": "excluded\n",
  });
  const error = await expectDiscoverError(contentDir);
  assert.ok(error.message.includes("no markdown files found"), error.message);
});

test("contentDir may be cwd-relative; page paths stay absolute", async () => {
  const contentDir = await makeContentDir({ "index.md": "# Home\n" });
  const previous = process.cwd();
  process.chdir(path.dirname(contentDir));
  try {
    const site = await discover({ contentDir: "content" });
    assert.equal(site.pages.length, 1);
    assert.equal(site.pages[0].path, path.join(contentDir, "index.md"));
    assert.ok(path.isAbsolute(site.pages[0].path));
    assert.equal(site.pages[0].url, "/");
  } finally {
    process.chdir(previous);
  }
});

test("broken YAML frontmatter aborts with T004's message naming the file", async () => {
  await assertParseFailure('---\ntitle: "unclosed\n---\nBody\n', /invalid frontmatter/);
});

test("non-mapping frontmatter aborts with T004's message naming the file", async () => {
  await assertParseFailure("---\n- one\n- two\n---\nBody\n", /frontmatter must be a YAML mapping/);
});

test("unparseable date aborts with T004's message naming the file", async () => {
  await assertParseFailure("---\ndate: nope\n---\nBody\n", /"date" must be a valid date/);
});

test("two invocations return identical path sequences", async () => {
  const contentDir = await makeContentDir({
    "index.md": "# Home\n",
    "about.md": "# About\n",
    "posts/hello.md": "# Hello\n",
    "posts/archive/older.md": "# Older\n",
    "_partials/intro.md": "excluded\n",
    "notes.txt": "not markdown\n",
  });
  const first = await discover({ contentDir });
  const second = await discover({ contentDir });
  assert.deepEqual(
    first.pages.map((page) => page.path),
    second.pages.map((page) => page.path),
  );
});
