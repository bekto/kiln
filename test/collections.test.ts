import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allTags,
  byTag,
  computeCollections,
  isDraft,
  sortByDate,
  withoutDrafts,
} from "../src/content/collections.ts";
import type { Collections } from "../src/content/collections.ts";
import type { Page, Site } from "../src/content/document.ts";

/** Build a page with an explicit absolute `path` (T004 shape, no I/O). */
function page(path: string, data: Record<string, unknown> = {}): Page {
  return { path, data, content: "", url: "/" };
}

/** Wrap `pages` in a `Site`. */
function site(pages: Page[]): Site {
  return { pages, data: {} };
}

/** The date strings used across fixtures. */
const MAR = new Date("2024-03-01T00:00:00Z");
const FEB = new Date("2024-02-01T00:00:00Z");
const JAN = new Date("2024-01-15T00:00:00Z");

test("posts are strictly newest-first; equal dates tie-break by path ascending", () => {
  const mar = page("/content/posts/mar.md", { collection: "posts", date: MAR });
  const feb = page("/content/posts/feb.md", { collection: "posts", date: FEB });
  const tieZ = page("/content/posts/z-tie.md", { collection: "posts", date: JAN });
  const tieA = page("/content/posts/a-tie.md", { collection: "posts", date: JAN });

  // Feed them in a scrambled order to prove the output does not depend on it.
  const { posts } = computeCollections(site([tieZ, mar, tieA, feb]));

  assert.deepEqual(posts, [mar, feb, tieA, tieZ]);
});

test("missing and unparseable dates count as oldest (epoch) without throwing", () => {
  const dated = page("/content/posts/dated.md", { date: MAR });
  const noDate = page("/content/posts/zzz-no-date.md");
  const badDate = page("/content/posts/aaa-bad-date.md", { date: "not-a-date" });

  const sorted = sortByDate([noDate, badDate, dated]);

  // `dated` first; the two epoch-ties fall last, path-ascending among themselves.
  assert.deepEqual(sorted, [dated, badDate, noDate]);
});

test("membership: posts stamp, pages default, explicit override, and appended pages", () => {
  const post = page("/content/posts/x.md", { collection: "posts", date: MAR });
  const about = page("/content/about.md", { date: FEB });
  const explicitPages = page("/content/posts/handbook.md", { collection: "pages", date: JAN });
  const appended = page("/content/appended.md"); // feature-appended: no `collection` at all

  const { posts, pages } = computeCollections(
    site([post, appended, explicitPages, about]),
  );

  assert.deepEqual(posts, [post]);
  // `about` has no stamp (default pages) and lands first by date; `appended`
  // (epoch) and `handbook` (explicit pages) trail it.
  assert.deepEqual(pages, [about, explicitPages, appended]);
});

test("collection: zine rejects with a message naming the file and the value", () => {
  const bad = page("/content/posts/zine.md", { collection: "zine" });
  assert.throws(
    () => computeCollections(site([bad])),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        '/content/posts/zine.md: "collection" must be "posts" or "pages" (got "zine")',
      );
      return true;
    },
  );
});

test("drafts stay in collections; withoutDrafts hides them; non-boolean draft rejects", () => {
  const draft = page("/content/posts/draft.md", {
    collection: "posts",
    date: MAR,
    draft: true,
  });
  const live = page("/content/posts/live.md", { collection: "posts", date: FEB });

  const { posts } = computeCollections(site([live, draft]));
  assert.deepEqual(posts, [draft, live]);
  assert.equal(isDraft(draft), true);
  assert.equal(isDraft(live), false);
  assert.equal(isDraft(page("/content/posts/no-field.md")), false);
  assert.deepEqual(withoutDrafts(posts), [live]);

  const badDraft = page("/content/posts/bad.md", { draft: "yes" });
  assert.throws(
    () => isDraft(badDraft),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        '/content/posts/bad.md: "draft" must be a boolean (got string)',
      );
      return true;
    },
  );
  assert.throws(() => withoutDrafts([badDraft]), /"draft" must be a boolean/);
});

test("byTag matches exact tags, skips case mismatches, and trims both sides", () => {
  const news = page("/content/posts/news.md", { tags: ["news", " tips "] });
  const uppercase = page("/content/posts/upper.md", { tags: ["News"] });
  const untagged = page("/content/posts/plain.md");

  const pages = [news, uppercase, untagged];
  assert.deepEqual(byTag(pages, "news"), [news]);
  assert.deepEqual(byTag(pages, "News"), [uppercase]); // case-sensitive
  assert.deepEqual(byTag(pages, "tips"), [news]); // stored tag trimmed
  assert.deepEqual(byTag(pages, "missing"), []);
});

test("tags: a bare string rejects naming the file and tags", () => {
  const bad = page("/content/posts/bad-tags.md", { tags: "news" });
  assert.throws(
    () => byTag([bad], "news"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        '/content/posts/bad-tags.md: "tags" must be an array of strings (got string)',
      );
      return true;
    },
  );
  assert.throws(() => allTags([bad]), /"tags" must be an array of strings/);
});

test("allTags preserves first-seen order without duplicates", () => {
  const a = page("/content/posts/a.md", { tags: ["news", "tips"] });
  const b = page("/content/posts/b.md", { tags: ["tips", "news", "events"] });
  assert.deepEqual(allTags([a, b]), ["news", "tips", "events"]);
  assert.deepEqual(allTags([b, a]), ["tips", "news", "events"]);
  assert.deepEqual(allTags([page("/content/posts/none.md")]), []);
});

test("two calls agree and inputs are never mutated", () => {
  const pages = [
    page("/content/posts/b.md", { collection: "posts", date: FEB, tags: ["news"] }),
    page("/content/posts/a.md", { collection: "posts", date: FEB, tags: ["news"] }),
    page("/content/about.md", { date: MAR }),
  ];
  const inputOrder = pages.map((p) => p.path);
  const input = site(pages);

  const first: Collections = computeCollections(input);
  const second: Collections = computeCollections(input);

  assert.deepEqual(first.posts.map((p) => p.path), second.posts.map((p) => p.path));
  assert.deepEqual(first.pages.map((p) => p.path), second.pages.map((p) => p.path));
  // The date tie on posts resolves to path order both times.
  assert.deepEqual(first.posts.map((p) => p.path), [
    "/content/posts/a.md",
    "/content/posts/b.md",
  ]);
  // Input array order is untouched by every helper.
  assert.deepEqual(pages.map((p) => p.path), inputOrder);
  assert.notEqual(first.posts, pages);
  assert.notEqual(first.posts, input.pages);
});

test("empty site yields empty collections; empty queries yield empty arrays", () => {
  const { posts, pages } = computeCollections(site([]));
  assert.deepEqual(posts, []);
  assert.deepEqual(pages, []);
  assert.deepEqual(byTag([], "news"), []);
  assert.deepEqual(allTags([]), []);
  assert.deepEqual(withoutDrafts([]), []);
  assert.deepEqual(sortByDate([]), []);
});
