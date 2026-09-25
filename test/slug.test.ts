import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPermalink,
  filePathForUrl,
  slugFromPath,
  slugify,
  urlForPath,
} from "../src/content/slug.ts";

test("slugify: unicode letters survive, punctuation is dropped", () => {
  assert.equal(slugify("Café Münster — 日本語"), "café-münster-日本語");
  assert.equal(slugify("你好，世界！"), "你好世界");
  assert.equal(slugify("Hello, World!"), "hello-world");
  assert.equal(slugify(" --Hello__World-- "), "hello-world");
  assert.equal(slugify("Post 2024"), "post-2024");
});

test("slugify: NFC normalization composes combining marks", () => {
  assert.equal(slugify("Café"), "café");
  // Decomposed input (e + U+0301): without NFC the combining mark is not
  // \p{L}/\p{N} and would be dropped, yielding "cafe" instead.
  assert.equal(slugify("Cafe\u0301"), "caf\u00e9");
});

test("slugify: empty and punctuation-only input → untitled", () => {
  assert.equal(slugify(""), "untitled");
  assert.equal(slugify("!!!"), "untitled");
  assert.equal(slugify("—…，！"), "untitled");
});

test("slugify: whitespace and underscore runs collapse to one hyphen", () => {
  assert.equal(slugify("a _ b"), "a-b");
  assert.equal(slugify("one\t\n  two"), "one-two");
  assert.equal(slugify("already-a-slug"), "already-a-slug");
});

test("slugFromPath: basename minus extension, index maps to parent", () => {
  assert.equal(slugFromPath("about/index.md"), "about");
  assert.equal(slugFromPath("index.md"), "untitled");
  assert.equal(slugFromPath("posts/hello world.md"), "hello-world");
  assert.equal(slugFromPath("notes/things.markdown"), "things");
  assert.equal(slugFromPath("plain-name"), "plain-name");
});

test("slugFromPath: Windows-style separators", () => {
  assert.equal(slugFromPath("posts\\hello.md"), "hello");
  assert.equal(slugFromPath("about\\index.md"), "about");
});

test("urlForPath: acceptance examples", () => {
  assert.equal(urlForPath("posts/Hello World.md"), "/posts/hello-world/");
  assert.equal(urlForPath("about/index.md"), "/about/");
  assert.equal(urlForPath("index.md"), "/");
  assert.equal(urlForPath("posts\\hello.md"), "/posts/hello/");
  assert.equal(urlForPath("2024/hello.md"), "/2024/hello/");
});

test("urlForPath: ./ prefixes and .markdown extension are handled", () => {
  assert.equal(urlForPath("./about/index.md"), "/about/");
  assert.equal(urlForPath("/posts/hello.md"), "/posts/hello/");
  assert.equal(urlForPath("notes/Thing.MARKDOWN"), "/notes/thing/");
  assert.equal(urlForPath("notes/Thing.MD"), "/notes/thing/");
  assert.equal(urlForPath(".\\about\\index.md"), "/about/");
});

test("filePathForUrl: pretty URL → outDir-relative index.html", () => {
  assert.equal(filePathForUrl("/posts/hello-world/"), "posts/hello-world/index.html");
  assert.equal(filePathForUrl("/"), "index.html");
  // A missing trailing slash is still a directory URL.
  assert.equal(filePathForUrl("/about"), "about/index.html");
  assert.equal(filePathForUrl("/posts/hello-world"), "posts/hello-world/index.html");
});

test("applyPermalink: date placeholders with zero padding", () => {
  assert.equal(
    applyPermalink("/posts/:year/:month/:slug/", {
      slug: "hi",
      date: new Date("2024-05-01"),
    }),
    "/posts/2024/05/hi/",
  );
  assert.equal(
    applyPermalink("/:year/:month/:day/:slug/", {
      slug: "hi",
      date: new Date("2024-02-03"),
    }),
    "/2024/02/03/hi/",
  );
});

test("applyPermalink: date is read with UTC getters", () => {
  // 2024-12-31 23:30 at UTC-5 is already 2025-01-01 in UTC.
  const date = new Date("2024-12-31T23:30:00-05:00");
  assert.equal(
    applyPermalink("/:year/:month/:day/", { slug: "x", date }),
    "/2025/01/01/",
  );
});

test("applyPermalink: missing slashes are normalized onto the output", () => {
  assert.equal(applyPermalink("posts/:slug", { slug: "hi" }), "/posts/hi/");
  assert.equal(applyPermalink("/tags/:slug", { slug: "a-b" }), "/tags/a-b/");
  assert.equal(applyPermalink("tags/:slug/", { slug: "a-b" }), "/tags/a-b/");
});

test("applyPermalink: a colon not followed by letters is literal", () => {
  assert.equal(
    applyPermalink("posts/:slug/page:2", { slug: "hi" }),
    "/posts/hi/page:2/",
  );
  assert.equal(
    applyPermalink("posts/:slug/http:", { slug: "hi" }),
    "/posts/hi/http:/",
  );
});

test("applyPermalink: unknown placeholder throws naming it and the template", () => {
  assert.throws(
    () => applyPermalink("/blog/:foo/", { slug: "hi" }),
    new Error('unknown permalink placeholder ":foo" in "/blog/:foo/"'),
  );
});

test("applyPermalink: date placeholder without a date throws", () => {
  assert.throws(
    () => applyPermalink("/posts/:year/:slug/", { slug: "hi" }),
    new Error('placeholder ":year" requires a date'),
  );
  assert.throws(
    () => applyPermalink("/posts/:month/", { slug: "hi" }),
    new Error('placeholder ":month" requires a date'),
  );
  assert.throws(
    () => applyPermalink("/posts/:day/", { slug: "hi" }),
    new Error('placeholder ":day" requires a date'),
  );
});
