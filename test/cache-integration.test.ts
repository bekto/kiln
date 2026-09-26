/**
 * Cache-interaction regressions (Wave 4 gate): a fully-warm rebuild must
 * not destroy outputs that cache-skipped pages still depend on.
 *
 * Two verified bugs this pins:
 * - sitemap.ts iterated only `result.emitted`, so a second, fully-cached
 *   build rewrote dist/sitemap.xml with zero `<loc>` entries;
 * - highlight.ts removed dist/assets/hljs.css whenever no page rendered
 *   highlighting this build, while skipped pages still carried hljs
 *   classes — broken styles after every warm rebuild.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../src/pipeline/build.ts";

const REPO_ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

const CONFIG = `export default { site: { title: "Warm", url: "https://example.test" } };\n`;
const HOME = `---\ntitle: "Home"\n---\nWelcome.\n`;
const CODE_POST = [
  "---",
  'title: "Code post"',
  'date: "2026-01-05"',
  'tags: ["ts"]',
  "---",
  "",
  "Intro paragraph.",
  "",
  "```ts",
  "const x: number = 1;",
  "```",
  "",
].join("\n");

test("warm rebuild keeps sitemap entries and hljs.css for cache-skipped pages", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kiln-warm-"));
  const previousCwd = process.cwd();
  try {
    await mkdir(path.join(root, "content", "posts"), { recursive: true });
    await writeFile(path.join(root, "kiln.config.ts"), CONFIG, "utf8");
    await writeFile(path.join(root, "content", "index.md"), HOME, "utf8");
    await writeFile(path.join(root, "content", "posts", "code.md"), CODE_POST, "utf8");
    await cp(path.join(REPO_ROOT, "templates"), path.join(root, "templates"), {
      recursive: true,
    });

    process.chdir(root);

    const first = await build();
    assert.equal(first.featureErrors.length, 0, JSON.stringify(first.featureErrors));
    assert.ok(first.emitted.length > 0, "cold build must emit pages");
    const sitemapAfterFirst = await readFile(path.join(root, "dist", "sitemap.xml"), "utf8");
    assert.ok(sitemapAfterFirst.includes("/posts/code/"), "cold sitemap lists the post");
    await readFile(path.join(root, "dist", "assets", "hljs.css"), "utf8");

    const second = await build();
    assert.equal(second.featureErrors.length, 0, JSON.stringify(second.featureErrors));
    // Premise: the rebuild is fully warm — nothing re-rendered.
    assert.equal(second.emitted.length, 0, JSON.stringify(second.skipped));
    assert.ok(second.skipped.length > 0, "all pages skipped via cache");

    const sitemap = await readFile(path.join(root, "dist", "sitemap.xml"), "utf8");
    assert.ok(sitemap.includes("/posts/code/"), "warm sitemap still lists the post");
    assert.ok(sitemap.includes("<loc>"), "warm sitemap has at least one loc");
    const locCount = sitemap.split("<loc>").length - 1;
    assert.equal(locCount, sitemapAfterFirst.split("<loc>").length - 1);

    // hljs.css must survive: skipped pages still carry hljs classes.
    const theme = await readFile(path.join(root, "dist", "assets", "hljs.css"), "utf8");
    assert.ok(theme.includes(".hljs"), "theme bytes intact after warm rebuild");
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});
