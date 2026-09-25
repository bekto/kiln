import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseDocument, readDocument } from "../src/content/document.ts";
import type { Document, Page, Site } from "../src/content/document.ts";

const FIXTURE_PATH = "/site/content/post.md";
const tempDirs: string[] = [];

/** Create a temp dir that is removed when the suite finishes. */
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kiln-document-test-"));
  tempDirs.push(dir);
  return dir;
}

/** Run parseDocument and return the throw, failing if it returns. */
function expectParseError(raw: string): Error {
  try {
    parseDocument(FIXTURE_PATH, raw);
  } catch (error) {
    assert.ok(error instanceof Error, `expected an Error, got ${typeof error}`);
    return error;
  }
  return assert.fail("parseDocument() returned but was expected to throw");
}

/** Run readDocument and return the rejection, failing if it resolves. */
async function expectReadError(filePath: string): Promise<Error> {
  try {
    await readDocument(filePath);
  } catch (error) {
    assert.ok(error instanceof Error, `expected an Error, got ${typeof error}`);
    return error;
  }
  return assert.fail("readDocument() resolved but was expected to reject");
}

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("frontmatter parses into open data, normalized date, and body content", () => {
  const doc = parseDocument(FIXTURE_PATH, '---\ntitle: Hi\ndate: "2024-05-01"\n---\nHello');
  assert.equal(doc.path, FIXTURE_PATH);
  assert.equal(doc.data.title, "Hi");
  assert.ok(doc.data.date instanceof Date);
  // Date-only strings parse as UTC, so this pin is timezone-independent.
  assert.equal((doc.data.date as Date).toISOString(), "2024-05-01T00:00:00.000Z");
  assert.equal(doc.content, "Hello");
});

test("file without frontmatter: empty data bag, content is the whole file", () => {
  const raw = "Hello **world**\n\nSecond paragraph.\n";
  const doc = parseDocument("/site/content/plain.md", raw);
  assert.deepEqual(doc.data, {});
  assert.equal(doc.content, raw);
});

test("empty file: exactly { path, data: {}, content: '' }", () => {
  const doc = parseDocument("/site/content/empty.md", "");
  assert.deepEqual(doc, { path: "/site/content/empty.md", data: {}, content: "" });
});

test("broken YAML: error names the file and the parser's line position", () => {
  const quote = expectParseError('---\ntitle: "unclosed\n---\nBody\n');
  assert.ok(quote.message.startsWith(`${FIXTURE_PATH}: invalid frontmatter at line 3: `), quote.message);

  // js-yaml lines line up with file lines: the offending ` b: 2` is file line 3.
  const indent = expectParseError("---\na: 1\n b: 2\n---\nbody\n");
  assert.ok(indent.message.startsWith(`${FIXTURE_PATH}: invalid frontmatter at line 3: `), indent.message);
});

test("non-mapping frontmatter: sequence and scalar are rejected", () => {
  const seq = expectParseError("---\n- a\n---\nbody\n");
  assert.equal(seq.message, `${FIXTURE_PATH}: frontmatter must be a YAML mapping`);

  const scalar = expectParseError("---\njust a scalar\n---\nbody\n");
  assert.equal(scalar.message, `${FIXTURE_PATH}: frontmatter must be a YAML mapping`);
});

test("date: not-a-date throws with the path and the field name", () => {
  const error = expectParseError("---\ndate: not-a-date\n---\nBody\n");
  assert.equal(error.message, `${FIXTURE_PATH}: "date" must be a valid date (got string)`);
});

test("date of the wrong type names its type", () => {
  const number = expectParseError("---\ndate: 1714521600000\n---\nBody\n");
  assert.equal(number.message, `${FIXTURE_PATH}: "date" must be a valid date (got number)`);

  const bool = expectParseError("---\ndate: true\n---\nBody\n");
  assert.equal(bool.message, `${FIXTURE_PATH}: "date" must be a valid date (got boolean)`);
});

test("unquoted YAML date already arrives as a Date", () => {
  const doc = parseDocument(FIXTURE_PATH, "---\ndate: 2024-05-01\n---\nBody\n");
  assert.ok(doc.data.date instanceof Date);
  assert.equal((doc.data.date as Date).toISOString(), "2024-05-01T00:00:00.000Z");
});

test("absent date stays absent", () => {
  const doc = parseDocument(FIXTURE_PATH, "---\ntitle: Hi\n---\nBody\n");
  assert.ok(!("date" in doc.data));
});

test("extra frontmatter passes through: arrays, nesting, unicode", () => {
  const raw = '---\ntitle: 你好，世界 🚀\ntags: [a, b]\nmodified: "2024-05-01"\nauthor:\n  name: Ada\n  links: [one, two]\n---\nBody\n';
  const doc = parseDocument(FIXTURE_PATH, raw);
  assert.deepEqual(doc.data.tags, ["a", "b"]);
  assert.ok(Array.isArray(doc.data.tags));
  assert.deepEqual(doc.data.author, { name: "Ada", links: ["one", "two"] });
  assert.equal(doc.data.title, "你好，世界 🚀");
  // Only `date` is normalized; identical strings in other keys stay strings.
  assert.equal(doc.data.modified, "2024-05-01");
});

test("repeated parses yield independent data bags", () => {
  const raw = "---\ntitle: Hi\n---\nBody\n";
  const first = parseDocument(FIXTURE_PATH, raw);
  first.data.title = "Mutated";
  const second = parseDocument(FIXTURE_PATH, raw);
  assert.equal(second.data.title, "Hi");
});

test("readDocument on a fixture matches parseDocument on its raw text", async () => {
  const dir = await makeTempDir();
  const file = path.join(dir, "post.md");
  const raw = '---\ntitle: Hi\ndate: "2024-05-01"\n---\nHello\n';
  await writeFile(file, raw, "utf8");
  const fromDisk = await readDocument(file);
  assert.deepEqual(fromDisk, parseDocument(file, raw));
  assert.equal(fromDisk.path, file);
});

test("readDocument surfaces parse errors carrying the file's path", async () => {
  const dir = await makeTempDir();
  const file = path.join(dir, "broken.md");
  await writeFile(file, "---\ndate: nope\n---\nBody\n", "utf8");
  const error = await expectReadError(file);
  assert.equal(error.message, `${file}: "date" must be a valid date (got string)`);
});

test("Page extends Document; Site carries pages plus open site data", () => {
  const doc: Document = parseDocument("/site/content/hello.md", "---\ntitle: Hi\n---\nHello");
  const page: Page = { ...doc, url: "/hello/" };
  const site: Site = { pages: [page], data: { title: "Site" } };
  assert.equal(site.pages[0].url, "/hello/");
  assert.equal(site.pages[0].content, "Hello");
  assert.equal(site.pages[0].path, "/site/content/hello.md");
  assert.equal(site.data.title, "Site");
});
