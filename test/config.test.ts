import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CONFIG_FILENAME, loadConfig } from "../src/config.ts";

const tempRoots: string[] = [];

/** Create a unique temp project root, optionally with a kiln.config.ts. */
async function makeProject(configSource?: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kiln-config-test-"));
  tempRoots.push(root);
  if (configSource !== undefined) {
    await writeFile(path.join(root, CONFIG_FILENAME), configSource, "utf8");
  }
  return root;
}

/** Run loadConfig and return the rejection, failing if it resolves. */
async function expectLoadError(root: string): Promise<Error> {
  try {
    await loadConfig(root);
  } catch (error) {
    assert.ok(error instanceof Error, `expected an Error, got ${typeof error}`);
    return error;
  }
  return assert.fail("loadConfig() resolved but was expected to reject");
}

after(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("no config file: documented defaults", async () => {
  assert.equal(CONFIG_FILENAME, "kiln.config.ts");
  const root = await makeProject();
  const config = await loadConfig(root);
  assert.equal(config.root, root);
  assert.ok(config.outDir.endsWith("/dist"));
  assert.equal(config.outDir, path.join(root, "dist"));
  assert.equal(config.contentDir, path.join(root, "content"));
  assert.equal(config.templatesDir, path.join(root, "templates"));
  assert.equal(config.publicDir, path.join(root, "public"));
  assert.equal(config.site.title, "Kiln site");
  assert.equal(config.site.url, "http://localhost:8080");
  assert.equal(config.site.description, undefined);
  assert.equal(config.port, 4173);
  assert.equal(config.watch.debounceMs, 100);
  assert.equal(config.assets.hashBust, false);
  assert.deepEqual(config.features, {});
});

test("relative dirs resolve against root; site merges key-wise over defaults", async () => {
  const root = await makeProject(`export default {
  outDir: "build",
  site: { title: "My site" },
};`);
  const config = await loadConfig(root);
  assert.ok(path.isAbsolute(config.outDir));
  assert.equal(config.outDir, path.join(root, "build"));
  assert.equal(config.site.title, "My site");
  assert.equal(config.site.url, "http://localhost:8080");
});

test("watch and assets merge key-wise over their defaults", async () => {
  const root = await makeProject(`export default {
  watch: { debounceMs: 250 },
  assets: {},
};`);
  const config = await loadConfig(root);
  assert.equal(config.watch.debounceMs, 250);
  assert.equal(config.assets.hashBust, false);
});

test("features map round-trips verbatim without inner validation", async () => {
  const root = await makeProject(
    `export default { features: { highlight: { theme: "x" } } };`,
  );
  const config = await loadConfig(root);
  assert.deepEqual(config.features, { highlight: { theme: "x" } });
  // Verified against the exact nested object, not just a deep-equal shape.
  const highlight = config.features.highlight;
  assert.ok(highlight !== null && typeof highlight === "object");
  assert.equal((highlight as { theme: unknown }).theme, "x");
  // Same reference as the config file's default export.
  const module = (await import(
    pathToFileURL(path.join(root, CONFIG_FILENAME)).href
  )) as { default: { features: unknown } };
  assert.equal(config.features, module.default.features);
  assert.ok(!Object.isFrozen(config.features));
});

test("absolute directory values are kept as-is", async () => {
  const absoluteOut = path.join(os.tmpdir(), "kiln-absolute-out");
  const root = await makeProject(
    `export default { outDir: ${JSON.stringify(absoluteOut)} };`,
  );
  const config = await loadConfig(root);
  assert.equal(config.outDir, absoluteOut);
});

test("directory keys must be strings", async () => {
  for (const key of ["contentDir", "templatesDir", "publicDir", "outDir"]) {
    const root = await makeProject(`export default { ${key}: 123 };`);
    const error = await expectLoadError(root);
    assert.equal(error.message, `kiln.config.ts: "${key}" must be a string (got number)`);
  }
});

test("features must be a plain object", async () => {
  for (const value of [`"nope"`, `[]`, `null`]) {
    const root = await makeProject(`export default { features: ${value} };`);
    const error = await expectLoadError(root);
    assert.match(error.message, /^kiln\.config\.ts:/);
    assert.match(error.message, /"features"/);
  }
});

test("site must be an object with string fields", async () => {
  for (const [source, expected] of [
    [`export default { site: "x" };`, `kiln.config.ts: "site" must be an object (got string)`],
    [`export default { site: null };`, `kiln.config.ts: "site" must be an object (got null)`],
  ] as const) {
    const error = await expectLoadError(await makeProject(source));
    assert.equal(error.message, expected);
  }
  for (const key of ["title", "url", "description"]) {
    const root = await makeProject(`export default { site: { ${key}: 5 } };`);
    const error = await expectLoadError(root);
    assert.equal(error.message, `kiln.config.ts: "site.${key}" must be a string (got number)`);
  }
});

test("port must be an integer in 1..65535", async () => {
  const range = await expectLoadError(await makeProject(`export default { port: 70000 };`));
  assert.equal(range.message, `kiln.config.ts: "port" must be an integer in 1..65535 (got number)`);
  const type = await expectLoadError(await makeProject(`export default { port: "8080" };`));
  assert.equal(type.message, `kiln.config.ts: "port" must be an integer in 1..65535 (got string)`);
});

test("watch.debounceMs must be a positive number", async () => {
  const notNumber = await expectLoadError(
    await makeProject(`export default { watch: { debounceMs: "x" } };`),
  );
  assert.match(notNumber.message, /^kiln\.config\.ts:/);
  assert.match(notNumber.message, /"watch\.debounceMs"/);
  const notPositive = await expectLoadError(
    await makeProject(`export default { watch: { debounceMs: 0 } };`),
  );
  assert.match(notPositive.message, /"watch\.debounceMs"/);
  const notObject = await expectLoadError(await makeProject(`export default { watch: 5 };`));
  assert.match(notObject.message, /"watch"/);
});

test("assets.hashBust must be a boolean", async () => {
  const error = await expectLoadError(
    await makeProject(`export default { assets: { hashBust: 1 } };`),
  );
  assert.match(error.message, /^kiln\.config\.ts:/);
  assert.match(error.message, /"assets\.hashBust"/);
});

test("array default export → must default-export an object", async () => {
  const root = await makeProject(`export default [1, 2, 3];`);
  const error = await expectLoadError(root);
  assert.match(error.message, /kiln\.config\.ts/);
  assert.match(error.message, /default-export/);
  assert.equal(error.message, "kiln.config.ts: must default-export an object (got array)");
});

test("no default export → must default-export an object (got undefined)", async () => {
  const root = await makeProject(`export const other = 1;`);
  const error = await expectLoadError(root);
  assert.equal(error.message, "kiln.config.ts: must default-export an object (got undefined)");
});

test("syntax error → message includes the config file path", async () => {
  const root = await makeProject(`export default { site: `);
  const error = await expectLoadError(root);
  assert.ok(
    error.message.includes(path.join(root, CONFIG_FILENAME)),
    `expected ${JSON.stringify(error.message)} to include ${path.join(root, CONFIG_FILENAME)}`,
  );
});

test("config that throws during evaluation → path plus original message", async () => {
  const root = await makeProject(`throw new Error("boom in config");\nexport default {};`);
  const error = await expectLoadError(root);
  assert.ok(error.message.includes(path.join(root, CONFIG_FILENAME)));
  assert.ok(error.message.includes("boom in config"));
});

test("returned config is frozen at top level and for site; features left alone", async () => {
  const root = await makeProject(`export default { site: { title: "T" }, features: { a: 1 } };`);
  const config = await loadConfig(root);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.site));
  assert.throws(() => {
    config.site.title = "changed";
  }, TypeError);
  assert.throws(() => {
    config.port = 9;
  }, TypeError);
  assert.ok(!Object.isFrozen(config.features));
  config.features.extra = true;
  assert.equal(config.features.extra, true);
});

test("unknown top-level keys are ignored", async () => {
  const root = await makeProject(`export default { mystery: 42, outDir: "out" };`);
  const config = await loadConfig(root);
  assert.equal(config.outDir, path.join(root, "out"));
  assert.ok(!Object.keys(config).includes("mystery"));
});

test("root defaults to process.cwd()", async () => {
  const root = await makeProject(`export default { outDir: "cwd-out" };`);
  const previous = process.cwd();
  process.chdir(root);
  try {
    const config = await loadConfig();
    assert.equal(config.outDir, path.join(root, "cwd-out"));
  } finally {
    process.chdir(previous);
  }
});

test("only root is searched — no upward walk", async () => {
  const root = await makeProject(`export default { outDir: "parent-out" };`);
  const child = path.join(root, "sub");
  await mkdir(child);
  const config = await loadConfig(child);
  assert.equal(config.outDir, path.join(child, "dist"));
});
