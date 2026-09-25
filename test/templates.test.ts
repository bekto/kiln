import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Page } from "../src/content/document.ts";
import type { MarkdownExtension } from "../src/content/markdown.ts";
import { loadTemplates, pageView } from "../src/render/templates.ts";

/** A fixture page; frontmatter and markdown body are per-test. */
function page(
  data: Record<string, unknown> = {},
  content = "# Hello\n\nWorld **bold**.",
): Page {
  return { path: "/content/posts/hi.md", data, content, url: "/posts/hi/" };
}

/**
 * Materialize a `templates/` directory (with `partials/`) in the OS temp
 * dir and hand it to `fn`; cleanup runs even if `fn` throws.
 */
async function withFixture<T>(
  files: Record<string, string>,
  fn: (templatesDir: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "kiln-templates-"));
  try {
    const tdir = path.join(root, "templates");
    await mkdir(path.join(tdir, "partials"), { recursive: true });
    for (const [name, source] of Object.entries(files)) {
      const target = path.join(tdir, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, source);
    }
    return await fn(tdir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("renderDocument: post layout renders doctype, site title, markdown body — through base's head", async () => {
  const templates = await loadTemplates();
  const html = await templates.renderDocument(page({ title: "Hello Post" }), {
    url: "/posts/hi/",
    site: { title: "Kiln Test" },
  });
  assert.ok(html.includes("<!doctype html>"), html);
  assert.ok(html.includes("<title>Kiln Test</title>"), html);
  // The charset meta lives in base.html — its presence proves inheritance.
  assert.ok(html.includes('<meta charset="utf-8">'), html);
  assert.ok(html.includes('<h1>Hello Post</h1>'), html);
  assert.ok(html.includes("<h1>Hello</h1>"), html);
  assert.ok(html.includes("<p>World <strong>bold</strong>.</p>"), html);
});

test("a partial in templates/partials/ is included by bare name and by prefixed path", async () => {
  await withFixture(
    {
      "partials/header.html": '<meta name="hdr" content="partial-header">',
      "full.html":
        '<html><head>{% include "header.html" %}' +
        '{% include "partials/header.html" %}</head>' +
        "<body>{{ content | safe }}</body></html>",
    },
    async (tdir) => {
      const templates = await loadTemplates(tdir);
      const html = await templates.renderDocument(page({ layout: "full" }), {
        url: "/posts/hi/",
        site: {},
      });
      // Two include statements, one partial file: both spellings resolve.
      assert.equal(html.split('content="partial-header"').length - 1, 2);
    },
  );
});

test("strict mode: {{ titel }} rejects naming template, line, and variable", async () => {
  // Exactly six lines before the typo — the message must cite `line 7`.
  const strictLayout = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    "<title>strict</title>",
    "</head>",
    "<body>",
    "{{ titel }}",
    "</body>",
    "</html>",
    "",
  ].join("\n");
  await withFixture({ "post.html": strictLayout }, async (tdir) => {
    const templates = await loadTemplates(tdir);
    await assert.rejects(
      templates.renderDocument(page(), { url: "/posts/hi/", site: {} }),
      /post\.html: line 7: undefined variable "titel"/,
    );
  });
});

test("layout: bogus rejects with template not found, the name, and the searched directories", async () => {
  const templates = await loadTemplates();
  await assert.rejects(
    templates.renderDocument(page({ layout: "bogus" }), {
      url: "/posts/hi/",
      site: {},
    }),
    (error) => {
      const message = (error as Error).message;
      assert.ok(message.includes("template not found"), message);
      assert.ok(message.includes("bogus.html"), message);
      assert.ok(
        message.includes("(searched: templates/, templates/partials/)"),
        message,
      );
      return true;
    },
  );
});

test("loadTemplates('/nonexistent-dir') rejects with templates directory not found", async () => {
  await assert.rejects(loadTemplates("/nonexistent-dir"), (error) => {
    const message = (error as Error).message;
    assert.ok(message.includes("templates directory not found"), message);
    assert.ok(
      message.startsWith(`${path.resolve("/nonexistent-dir")}:`),
      message,
    );
    return true;
  });
});

test("autoescape: data is escaped, markdown content survives through |safe", async () => {
  const templates = await loadTemplates();
  const html = await templates.renderDocument(
    page({ title: "<script>x</script>" }),
    { url: "/posts/hi/", site: { title: "Kiln Test" } },
  );
  assert.ok(!html.includes("<script>"), html);
  assert.ok(html.includes("&lt;script&gt;x&lt;/script&gt;"), html);
  assert.ok(html.includes("<strong>bold</strong>"), html);
});

test("injectHead: registered partial lands in <head>, absent array is silent, missing file rejects", async () => {
  // Copy the shipped base at runtime so the slot under test is the one the
  // project actually ships, never a stale duplicate.
  const base = await readFile(
    new URL("../templates/base.html", import.meta.url),
    "utf8",
  );
  await withFixture(
    {
      "base.html": base,
      "slot.html":
        '{% extends "base.html" %}{% block content %}<p>body</p>{% endblock %}',
      "partials/note.html": '<meta name="x-note" content="injected">',
    },
    async (tdir) => {
      const templates = await loadTemplates(tdir);
      const opts = { url: "/posts/hi/", site: {} };

      const withHead = await templates.renderDocument(
        page({ layout: "slot", injectHead: ["note.html"] }),
        opts,
      );
      const head = withHead.slice(0, withHead.indexOf("</head>"));
      assert.ok(head.includes('content="injected"'), withHead);

      const without = await templates.renderDocument(
        page({ layout: "slot" }),
        opts,
      );
      assert.ok(!without.includes("injected"), without);

      await assert.rejects(
        templates.renderDocument(
          page({ layout: "slot", injectHead: ["ghost.html"] }),
          opts,
        ),
        /template not found: "ghost\.html"/,
      );

      // The injectBody twin fires before </body> instead of inside <head>.
      const withBody = await templates.renderDocument(
        page({ layout: "slot", injectBody: ["note.html"] }),
        opts,
      );
      const afterHead = withBody.slice(withBody.indexOf("</head>"));
      assert.ok(afterHead.includes('content="injected"'), withBody);
      assert.ok(!withBody.slice(0, withBody.indexOf("</head>")).includes("injected"), withBody);
    },
  );
});

test("seam: an extension setting doc.data.toc makes page.toc readable by the layout", async () => {
  await withFixture(
    {
      "toc.html":
        '<div class="toc">{% if page.toc %}{{ page.toc }}{% endif %}</div>' +
        "{{ content | safe }}",
    },
    async (tdir) => {
      const templates = await loadTemplates(tdir);
      // T012's shape: a plugin registered only through RenderOptions that
      // attaches per-page data during markdown render.
      const tocExtension: MarkdownExtension = (md) => {
        md.core.ruler.push("kiln-toc", (state) => {
          (state.env as { doc: Page }).doc.data.toc = "seam toc value";
        });
      };
      const html = await templates.renderDocument(page({ layout: "toc" }), {
        url: "/posts/hi/",
        site: {},
        extensions: [tocExtension],
      });
      assert.ok(html.includes("seam toc value"), html);
      assert.ok(html.includes("<strong>bold</strong>"), html);
    },
  );
});

test("date filter: a Date renders YYYY-MM-DD; a string rejects naming its type", async () => {
  const templates = await loadTemplates();
  const html = await templates.renderDocument(
    page({ date: new Date("2026-09-25") }),
    { url: "/posts/hi/", site: { title: "Kiln Test" } },
  );
  assert.ok(
    html.includes('<time datetime="2026-09-25">2026-09-25</time>'),
    html,
  );
  await assert.rejects(
    templates.renderDocument(page({ date: "2026-09-25" }), {
      url: "/posts/hi/",
      site: { title: "Kiln Test" },
    }),
    /date filter: expected Date, got string/,
  );
});

test("index.html lists site.pages with guarded titles falling back to the url", async () => {
  const templates = await loadTemplates();
  const site = {
    title: "Kiln Test",
    pages: [{ url: "/a/", title: "Alpha" }, { url: "/b/" }],
  };
  const html = await templates.renderDocument(page({ layout: "index" }, ""), {
    url: "/",
    site,
  });
  assert.ok(html.includes("<h1>Kiln Test</h1>"), html);
  assert.ok(html.includes('<a href="/a/">Alpha</a>'), html);
  assert.ok(html.includes('<a href="/b/">/b/</a>'), html);
  const own = await templates.renderDocument(
    page({ layout: "index", title: "My Index" }, ""),
    { url: "/", site },
  );
  assert.ok(own.includes("<h1>My Index</h1>"), own);
});

test("layout normalization: 'post' and 'post.html' both load post.html", async () => {
  const templates = await loadTemplates();
  const opts = { url: "/posts/hi/", site: { title: "Kiln Test" } };
  const bare = await templates.renderDocument(
    page({ layout: "post", title: "T" }),
    opts,
  );
  const full = await templates.renderDocument(
    page({ layout: "post.html", title: "T" }),
    opts,
  );
  assert.equal(bare, full);
  assert.ok(bare.includes("<h1>T</h1>"), bare);
});

test("a non-string layout names the source path and the value it rejected", async () => {
  const templates = await loadTemplates();
  await assert.rejects(
    templates.renderDocument(page({ layout: 42 }), {
      url: "/posts/hi/",
      site: {},
    }),
    (error) => {
      const message = (error as Error).message;
      assert.ok(message.includes("/content/posts/hi.md"), message);
      assert.ok(message.includes("number (42)"), message);
      return true;
    },
  );
});

test("extra merges top-level but cannot shadow page, site, or content", async () => {
  const templates = await loadTemplates();
  const html = await templates.renderDocument(page({ title: "Real Title" }), {
    url: "/posts/hi/",
    site: { title: "Kiln Test" },
    extra: { page: "shadowed", site: "shadowed", content: "shadowed" },
  });
  assert.ok(html.includes("<h1>Real Title</h1>"), html);
  assert.ok(html.includes("<title>Kiln Test</title>"), html);
  assert.ok(html.includes("<strong>bold</strong>"), html);
  assert.ok(!html.includes("shadowed"), html);

  await withFixture({ "e.html": "<p>{% if extraKey %}{{ extraKey }}{% endif %}</p>" }, async (tdir) => {
    const custom = await loadTemplates(tdir);
    const merged = await custom.renderDocument(page({ layout: "e" }), {
      url: "/posts/hi/",
      site: {},
      extra: { extraKey: "kept" },
    });
    assert.equal(merged, "<p>kept</p>");
  });
});

test("pageView: computed url and path win over same-named frontmatter", () => {
  const view = pageView({
    path: "/src/real.md",
    data: { title: "T", url: "/wrong/", path: "/wrong" },
    content: "",
    url: "/real/",
  });
  assert.equal(view.url, "/real/");
  assert.equal(view.path, "/src/real.md");
  assert.equal(view.title, "T");
});

test("templates are re-read on every render — edits show up without a reload", async () => {
  await withFixture({ "layout.html": "<p>first</p>" }, async (tdir) => {
    const templates = await loadTemplates(tdir);
    assert.equal(await templates.render("layout.html", {}), "<p>first</p>");
    await writeFile(path.join(tdir, "layout.html"), "<p>second</p>");
    assert.equal(await templates.render("layout.html", {}), "<p>second</p>");
  });
});
