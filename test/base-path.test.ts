/**
 * Base-path regressions (subpath hosting): `site.url` with a path component
 * must prefix every root-absolute reference the build emits — template
 * links, pagination, taxonomy, TOC anchors, markdown links and images, and
 * search-index URLs — while leaving code-block text and protocol-relative
 * targets untouched, and while keeping the link checker green (it strips
 * the prefix before mapping onto dist/).
 *
 * This pins the fix for the live bug: on a GitHub Pages project site
 * (`bekto.github.io/kiln/`) every unprefixed `href="/…"` escaped the
 * subpath — 404s on navigation and an unstyled page (missing /styles.css).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../src/pipeline/build.ts";

const REPO_ROOT = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);

const HOME = `---\ntitle: "Home"\nlayout: index\n---\nWelcome.\n`;
const ABOUT = `---\ntitle: "About"\n---\nAbout us.\n`;
const POST = [
  "---",
  'title: "Hi"',
  'date: "2026-01-01"',
  'tags: ["greetings"]',
  "---",
  "",
  "## Deep",
  "",
  "See [the about page](/about/) and ![a picture](/images/a.png).",
  "",
  "![cdn](//cdn.example.com/p.png)",
  "",
  "```html",
  '<a href="/example-in-code/">not a real link</a>',
  "```",
  "",
  "Inline: `<a href=\"/x/\">` stays literal.",
  "",
].join("\n");
const SECOND = `---\ntitle: "Bye"\ndate: "2026-01-02"\ntags: ["greetings"]\n---\nBye.\n`;

async function withProject(
  url: string,
  fn: () => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "kiln-basepath-"));
  const previousCwd = process.cwd();
  try {
    await mkdir(path.join(root, "content", "posts"), { recursive: true });
    await mkdir(path.join(root, "public", "images"), { recursive: true });
    await writeFile(
      path.join(root, "kiln.config.ts"),
      `export default {\n  site: { title: "Base", url: ${JSON.stringify(url)} },\n  features: { pagination: { pageSize: 1 } },\n};\n`,
      "utf8",
    );
    await writeFile(path.join(root, "content", "index.md"), HOME, "utf8");
    await writeFile(path.join(root, "content", "about.md"), ABOUT, "utf8");
    await writeFile(path.join(root, "content", "posts", "hi.md"), POST, "utf8");
    await writeFile(
      path.join(root, "content", "posts", "bye.md"),
      SECOND,
      "utf8",
    );
    await writeFile(path.join(root, "public", "images", "a.png"), "x", "utf8");
    await cp(path.join(REPO_ROOT, "templates"), path.join(root, "templates"), {
      recursive: true,
    });

    process.chdir(root);
    await fn();
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

test("subpath site.url prefixes every internal reference", async () => {
  await withProject("https://example.com/sub", async () => {
    const report = await build();
    assert.deepEqual(report.featureErrors, [], JSON.stringify(report.featureErrors));

    const home = await readFile(path.join("dist", "index.html"), "utf8");
    // Template list (repo index.html) + home's own url.
    assert.ok(home.includes('href="/sub/posts/hi/"'), "post link prefixed");
    assert.ok(home.includes('href="/sub/"'), "home self link prefixed");
    assert.ok(home.includes('href="/sub/tags/greetings/"'), "tag link prefixed");
    // Pagination nav flows through base.html's injectBody slot.
    assert.ok(home.includes('href="/sub/page/2/"'), "pagination next prefixed");

    const post = await readFile(
      path.join("dist", "posts", "hi", "index.html"),
      "utf8",
    );
    // Markdown link + image are prefixed at token level …
    assert.ok(post.includes('href="/sub/about/"'), "md link prefixed");
    assert.ok(post.includes('src="/sub/images/a.png"'), "md image prefixed");
    // … TOC anchors (path#frag from T017) are prefixed …
    assert.ok(
      post.includes('href="/sub/posts/hi/#deep"'),
      "toc anchor prefixed",
    );
    // … protocol-relative targets are never prefixed …
    assert.ok(
      post.includes('src="//cdn.example.com/p.png"'),
      "protocol-relative image untouched",
    );
    assert.ok(!post.includes("/sub//cdn"), "no prefix before //");
    // … and code text is NEVER touched (tokens, not string rewriting).
    // highlight.js escapes and segments it, so assert on path fragments
    // rather than on attribute-shaped substrings.
    assert.ok(post.includes("/example-in-code/"), "fence content present");
    assert.ok(!post.includes("/sub/example-in-code"), "no prefix in fence");
    assert.ok(post.includes("/x/"), "inline code present");
    assert.ok(!post.includes("/sub/x/"), "no prefix in inline code");

    // Search index carries prefixed urls so the client links verbatim.
    const index = JSON.parse(
      await readFile(path.join("dist", "search-index.json"), "utf8"),
    ) as { url: string }[];
    assert.ok(index.length > 0, "index has entries");
    for (const entry of index) {
      assert.ok(entry.url.startsWith("/sub/"), `index url prefixed: ${entry.url}`);
    }

    // The Atom feed keeps absolute, site.url-based links.
    const feed = await readFile(path.join("dist", "feed.xml"), "utf8");
    assert.ok(feed.includes("https://example.com/sub/"), "feed absolute");

    // The link checker stays correct under a prefix: inject a broken link
    // and expect the build to fail naming it (proof it ran and resolved).
    await writeFile(
      path.join("content", "posts", "broken.md"),
      `---\ntitle: "Broken"\ndate: "2026-01-03"\n---\n[nope](/nowhere/)\n`,
      "utf8",
    );
    const failed = await build();
    assert.equal(failed.featureErrors.length, 1, JSON.stringify(failed.featureErrors));
    assert.match(failed.featureErrors[0]!.message, /nowhere/);
  });
});

test("pathless site.url stays root-absolute with no double slashes", async () => {
  await withProject("https://example.com", async () => {
    const report = await build();
    assert.deepEqual(report.featureErrors, [], JSON.stringify(report.featureErrors));

    const home = await readFile(path.join("dist", "index.html"), "utf8");
    assert.ok(home.includes('href="/posts/hi/"'), "root link unprefixed");
    assert.ok(home.includes('href="/"'), "home link is bare /");
    assert.ok(!home.includes('href="//'), "no protocol-relative corruption");
    assert.ok(!home.includes('basePath'), "no literal template leakage");

    const index = JSON.parse(
      await readFile(path.join("dist", "search-index.json"), "utf8"),
    ) as { url: string }[];
    assert.ok(index.every((entry) => entry.url.startsWith("/")));
    assert.ok(index.every((entry) => !entry.url.startsWith("//")));
  });
});
