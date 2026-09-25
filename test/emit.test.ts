import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Page, Site } from "../src/content/document.ts";
import type { MarkdownExtension } from "../src/content/markdown.ts";
import { emitPages, pageOutputFor } from "../src/render/emit.ts";

/** A fixture page; frontmatter and markdown body are per-test. */
function page(
  spec: {
    path?: string;
    url?: string;
    data?: Record<string, unknown>;
    content?: string;
  } = {},
): Page {
  return {
    path: spec.path ?? "index.md",
    data: spec.data ?? {},
    content: spec.content ?? "Hello **world**.",
    // Omitting `url` leaves it `undefined` at runtime — the page-shaped
    // entries T010's `page.url ?? …` permalink/path fallback serves.
    url: spec.url as string,
  };
}

/** Minimal strict layout: doctype, site title, and the markdown body. */
const LAYOUT =
  '<!doctype html>\n<html lang="en"><head><title>{{ site.title }}</title></head>' +
  "<body>{{ content | safe }}</body></html>\n";

/**
 * Materialize a project (with `templates/`) in the OS temp dir, chdir into
 * it so `emitPages`' default `loadTemplates()` sees the fixture, run `fn`,
 * then restore the cwd and clean up — even when `fn` throws.
 */
async function withProject<T>(
  files: Record<string, string>,
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "kiln-emit-"));
  try {
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
    await rm(root, { recursive: true, force: true });
  }
}

test("emitPages: pretty urls land at dist/index.html and dist/<dir>/index.html, emitted in site order", async () => {
  await withProject({ "templates/post.html": LAYOUT }, async (root) => {
    const site: Site = {
      data: { title: "Kiln Emit" },
      pages: [
        page({
          path: "content/index.md",
          url: "/",
          data: { title: "Home" },
          content: "Home **body**.",
        }),
        page({
          path: "content/posts/my-post.md",
          url: "/posts/my-post/",
          data: { title: "My Post" },
          content: "Post body.",
        }),
      ],
    };
    // No distDir given: the default `'dist'` resolves against the cwd.
    const result = await emitPages(site, {});
    assert.deepEqual(result, {
      emitted: [
        { url: "/", file: "index.html" },
        { url: "/posts/my-post/", file: "posts/my-post/index.html" },
      ],
      skipped: [],
    });
    const home = await readFile(path.join(root, "dist", "index.html"), "utf8");
    assert.ok(home.includes("<!doctype html>"), home);
    assert.ok(home.includes("<title>Kiln Emit</title>"), home);
    assert.ok(home.includes("<p>Home <strong>body</strong>.</p>"), home);
    const post = await readFile(
      path.join(root, "dist", "posts", "my-post", "index.html"),
      "utf8",
    );
    assert.ok(post.includes("<!doctype html>"), post);
    assert.ok(post.includes("<p>Post body.</p>"), post);
  });
});

test("pageOutputFor: directory url, permalink expansion, and urlForPath fallback", () => {
  // Directory url → its index.html.
  assert.deepEqual(pageOutputFor(page({ url: "/posts/my-post/" })), {
    url: "/posts/my-post/",
    file: "posts/my-post/index.html",
  });
  // No url → T005 expands data.permalink with :slug/:year from path and date.
  assert.deepEqual(
    pageOutputFor(
      page({
        path: "posts/my-post.md",
        data: {
          permalink: "/journal/:year/:slug/",
          date: new Date(Date.UTC(2024, 2, 5)),
        },
      }),
    ),
    {
      url: "/journal/2024/my-post/",
      file: "journal/2024/my-post/index.html",
    },
  );
  // Neither url nor permalink → urlForPath(path).
  assert.deepEqual(pageOutputFor(page({ path: "posts/hi.md" })), {
    url: "/posts/hi/",
    file: "posts/hi/index.html",
  });
  assert.deepEqual(pageOutputFor(page({ path: "index.md" })), {
    url: "/",
    file: "index.html",
  });
});

test("hostile permalink: rejects with 'refusing to write outside dist', nothing created", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kiln-emit-"));
  try {
    const distDir = path.join(root, "a", "b", "dist");
    const site: Site = {
      data: {},
      pages: [page({ path: "escape.md", data: { permalink: "/../../escape/" } })],
    };
    await assert.rejects(emitPages(site, { distDir }), (error) => {
      const message = (error as Error).message;
      assert.ok(message.includes("refusing to write outside dist"), message);
      assert.ok(message.includes("/../../escape/"), message);
      assert.ok(message.includes("../../escape/index.html"), message);
      assert.ok(message.includes("escape.md"), message);
      return true;
    });
    // Sentinel: the would-be escape target and the dist root itself are absent.
    const escapeTarget = path.resolve(distDir, "../../escape/index.html");
    await assert.rejects(stat(escapeTarget), { code: "ENOENT" });
    await assert.rejects(stat(distDir), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two pages resolving to one file: 'duplicate output file' names both urls, nothing written", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kiln-emit-"));
  try {
    const distDir = path.join(root, "dist");
    const site: Site = {
      data: {},
      pages: [
        page({ path: "about.md", url: "/about/" }),
        page({ path: "about-alt.md", url: "/about" }),
      ],
    };
    await assert.rejects(emitPages(site, { distDir }), (error) => {
      const message = (error as Error).message;
      assert.ok(
        message.includes(
          "duplicate output file: about/index.html (urls: /about/, /about)",
        ),
        message,
      );
      return true;
    });
    // Pre-scan fires before any mkdir or render.
    await assert.rejects(stat(distDir), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shouldSkip true + existing target: listed in skipped, bytes untouched", async () => {
  await withProject({ "templates/post.html": LAYOUT }, async (root) => {
    const distDir = path.join(root, "dist");
    const target = path.join(distDir, "posts", "hi", "index.html");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "SENTINEL", "utf8");
    const site: Site = {
      data: { title: "Skip" },
      pages: [page({ path: "posts/hi.md", url: "/posts/hi/" })],
    };
    const asked: Page[] = [];
    const result = await emitPages(site, {
      distDir,
      shouldSkip: (candidate) => {
        asked.push(candidate);
        return true;
      },
    });
    assert.deepEqual(result, {
      emitted: [],
      skipped: [{ url: "/posts/hi/", file: "posts/hi/index.html" }],
    });
    assert.equal(asked.length, 1);
    assert.equal(await readFile(target, "utf8"), "SENTINEL");
  });
});

test("shouldSkip true but target missing: rendered and listed in emitted instead", async () => {
  await withProject({ "templates/post.html": LAYOUT }, async (root) => {
    const distDir = path.join(root, "dist");
    const site: Site = {
      data: { title: "Miss" },
      pages: [
        page({
          path: "posts/hi.md",
          url: "/posts/hi/",
          content: "Fresh **render**.",
        }),
      ],
    };
    const result = await emitPages(site, {
      distDir,
      shouldSkip: () => true,
    });
    assert.deepEqual(result, {
      emitted: [{ url: "/posts/hi/", file: "posts/hi/index.html" }],
      skipped: [],
    });
    const html = await readFile(
      path.join(distDir, "posts", "hi", "index.html"),
      "utf8",
    );
    assert.ok(html.includes("<p>Fresh <strong>render</strong>.</p>"), html);
  });
});

test("extensions markup reaches the written HTML; extra collections readable by the layout", async () => {
  const seamLayout =
    '<!doctype html>\n<html lang="en"><body>{{ content | safe }}' +
    "<ul>{% for c in collections.posts %}<li>{{ c }}</li>{% endfor %}</ul>" +
    "</body></html>\n";
  await withProject({ "templates/post.html": seamLayout }, async (root) => {
    const probe: MarkdownExtension = (md) => {
      md.core.ruler.push("emit_probe", (state) => {
        for (const token of state.tokens) {
          if (token.type === "paragraph_open") {
            token.attrSet("data-emit-ext", "yes");
          }
        }
      });
    };
    const site: Site = {
      data: {},
      pages: [
        page({
          path: "posts/seam.md",
          url: "/posts/seam/",
          content: "Seam body.",
        }),
      ],
    };
    const result = await emitPages(site, {
      extensions: [probe],
      extra: { collections: { posts: ["Alpha", "Beta"] } },
    });
    assert.deepEqual(result, {
      emitted: [{ url: "/posts/seam/", file: "posts/seam/index.html" }],
      skipped: [],
    });
    const html = await readFile(
      path.join(root, "dist", "posts", "seam", "index.html"),
      "utf8",
    );
    assert.ok(html.includes('data-emit-ext="yes"'), html);
    assert.ok(html.includes("<li>Alpha</li><li>Beta</li>"), html);
    assert.ok(html.includes('data-emit-ext="yes">Seam body.</p>'), html);
  });
});

test("zero pages: empty result and no dist/ directory created", async () => {
  // No templates/ in the fixture either: nothing may be loaded or written.
  await withProject({}, async (root) => {
    const result = await emitPages({ data: {}, pages: [] }, {});
    assert.deepEqual(result, { emitted: [], skipped: [] });
    await assert.rejects(stat(path.join(root, "dist")), { code: "ENOENT" });
  });
});

test("write failure: rejects with an error naming the target path", async () => {
  await withProject({ "templates/post.html": LAYOUT }, async (root) => {
    // A plain file where `dist/` should be a directory → mkdir fails (ENOTDIR).
    const blocked = path.join(root, "blocked");
    await writeFile(blocked, "not a directory", "utf8");
    const distDir = path.join(blocked, "dist");
    const site: Site = {
      data: { title: "Blocked" },
      pages: [page({ path: "index.md", url: "/" })],
    };
    await assert.rejects(emitPages(site, { distDir }), (error) => {
      const message = (error as Error).message;
      assert.ok(message.includes(path.join(distDir, "index.html")), message);
      return true;
    });
  });
});
