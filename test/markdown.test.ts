import { test } from "node:test";
import assert from "node:assert/strict";
import type { RendererRule } from "markdown-it";
import { createRenderer, renderMarkdown } from "../src/content/markdown.ts";
import type { MarkdownExtension } from "../src/content/markdown.ts";

const MARK = "%%hi%%";

/**
 * Seam-proof plugin: an inline rule turning `%%hi%%` into
 * `<mark>hi</mark>`, shaped `(md) => void` like T012's
 * `Feature.extendMarkdown` hook. Registered only through
 * `RenderOptions.extensions` — the core module cannot know about it.
 */
const markHi: MarkdownExtension = (md) => {
  md.inline.ruler.before("emphasis", "mark-hi", (state, silent) => {
    if (state.pos + MARK.length > state.posMax) return false;
    if (!state.src.startsWith(MARK, state.pos)) return false;
    if (!silent) {
      state.push("mark_open", "mark", 1);
      state.push("text", "", 0).content = "hi";
      state.push("mark_close", "mark", -1);
    }
    state.pos += MARK.length;
    return true;
  });
};

/**
 * Extension appending `marker` after every rendered `</p>`. Two of these
 * prove both extensions reach the instance and that application follows
 * array order: the outer wrapper's marker lands last in the output, and the
 * wrapper applied first is the inner one. Four call sites below.
 */
function tagWith(marker: string): MarkdownExtension {
  return (md) => {
    const previous: RendererRule | undefined =
      md.renderer.rules.paragraph_close;
    md.renderer.rules.paragraph_close = (tokens, idx, options, env, renderer) =>
      (previous?.(tokens, idx, options, env, renderer) ??
        renderer.renderToken(tokens, idx, options)) + marker;
  };
}

test("GFM: table source renders a <table>", () => {
  const html = renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
  assert.ok(html.includes("<table>"), html);
  assert.ok(html.includes("<th>a</th>"), html);
  assert.ok(html.includes("<td>1</td>"), html);
});

test("GFM: ~~old~~ renders <del>old</del>", () => {
  const html = renderMarkdown("this is ~~old~~ text");
  assert.ok(html.includes("<del>old</del>"), html);
});

test("GFM: ```ts fence renders a pre/code block, no highlighting yet", () => {
  const html = renderMarkdown("```ts\nexport const x = 1;\n```");
  assert.ok(html.includes('<pre><code class="language-ts">'), html);
  assert.ok(html.includes("export const x = 1;"), html);
  assert.ok(html.includes("</code></pre>"), html);
});

test("GFM: unknown or absent fence language never crashes", () => {
  const unknown = renderMarkdown("```zzz-nope\ncode here\n```");
  assert.ok(unknown.includes('<pre><code class="language-zzz-nope">'), unknown);
  assert.ok(unknown.includes("code here"), unknown);

  const absent = renderMarkdown("```\nbare fence\n```");
  assert.ok(absent.includes("<pre><code>"), absent);
  assert.ok(absent.includes("bare fence"), absent);

  const unclosed = renderMarkdown("```zzz-nope\nno closing fence");
  assert.ok(unclosed.includes("no closing fence"), unclosed);
});

test("html: false — raw HTML in source is escaped, not passed through", () => {
  const html = renderMarkdown("before <em>x</em> after");
  assert.ok(!html.includes("<em>"), html);
  assert.ok(html.includes("&lt;em&gt;x&lt;/em&gt;"), html);
});

test("weird or malformed markdown degrades without throwing", () => {
  for (const source of [
    "unclosed ``` fence",
    "| a |",
    "~~",
    "[broken](",
    "<div>raw block</div>",
    "\uD800",
    "# \uD800 heading",
    "]()",
    "\\",
    "**unbalanced *stars",
  ]) {
    assert.equal(typeof renderMarkdown(source), "string", source);
  }
});

test("seam: extension markup appears only when passed in extensions", () => {
  const without = renderMarkdown("%%hi%%");
  assert.ok(!without.includes("<mark>"), without);

  const rendered = renderMarkdown("%%hi%%", { extensions: [markHi] });
  assert.ok(rendered.includes("<mark>hi</mark>"), rendered);
});

test("two extensions are both applied, in array order", () => {
  const forward = renderMarkdown("one\n\ntwo", {
    extensions: [tagWith("[A]"), tagWith("[B]")],
  });
  assert.ok(forward.includes("</p>\n[A][B]"), forward);

  const reversed = renderMarkdown("one\n\ntwo", {
    extensions: [tagWith("[B]"), tagWith("[A]")],
  });
  assert.ok(reversed.includes("</p>\n[B][A]"), reversed);
});

test("createRenderer: configured instance applies extensions, reused", () => {
  const md = createRenderer({ extensions: [markHi] });
  assert.ok(md.render("~~gone~~").includes("<del>gone</del>"));
  assert.ok(md.render("%%hi%%").includes("<mark>hi</mark>"));

  const plain = createRenderer();
  assert.ok(!plain.render("%%hi%%").includes("<mark>"));
});

test("link rewriting: relative .md resolves against currentUrl's directory", () => {
  const relative = renderMarkdown("[a](../about.md)", {
    currentUrl: "/posts/hi/",
  });
  assert.ok(relative.includes('href="/about/"'), relative);

  const fragment = renderMarkdown("[s](setup.md#steps)", {
    currentUrl: "/guide/intro/",
  });
  assert.ok(fragment.includes('href="/guide/setup/#steps"'), fragment);

  const query = renderMarkdown("[q](setup.md?v=2)", {
    currentUrl: "/guide/intro/",
  });
  assert.ok(query.includes('href="/guide/setup/?v=2"'), query);

  const markdownExt = renderMarkdown("[h](./notes.markdown)", {
    currentUrl: "/guide/intro/",
  });
  assert.ok(markdownExt.includes('href="/guide/notes/"'), markdownExt);
});

test("link rewriting: root-relative .md becomes pretty URL always", () => {
  const html = renderMarkdown("[g](/guide/setup.md)");
  assert.ok(html.includes('href="/guide/setup/"'), html);
});

test("link rewriting: external, anchor, and non-markdown targets unchanged", () => {
  const cases: Array<[string, string]> = [
    ["[b](https://example.com/x.md)", "https://example.com/x.md"],
    ["[b](http://example.com/x.md)", "http://example.com/x.md"],
    ["[m](mailto:notes.md)", "mailto:notes.md"],
    ["[p](//example.com/x.md)", "//example.com/x.md"],
    ["[c](notes.txt)", "notes.txt"],
    ["[d](#sec)", "#sec"],
    ["[r](/guide/setup.txt)", "/guide/setup.txt"],
  ];
  for (const [source, href] of cases) {
    const html = renderMarkdown(source, { currentUrl: "/posts/hi/" });
    assert.ok(html.includes(`href="${href}"`), `${source} → ${html}`);
  }
});

test("link rewriting: linkify autolinks are covered too", () => {
  const html = renderMarkdown("See https://example.com/x.md today");
  assert.ok(html.includes('href="https://example.com/x.md"'), html);
});

test("link rewriting: relative .md with no currentUrl is unchanged", () => {
  const html = renderMarkdown("[e](setup.md)");
  assert.ok(html.includes('href="setup.md"'), html);
});
