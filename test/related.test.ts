import { test } from "node:test";
import assert from "node:assert/strict";
import related from "../src/features/related.ts";
import type { RelatedEntry } from "../src/features/related.ts";
import type { BuildFlags, FeatureContext } from "../src/feature.ts";
import type { Page } from "../src/content/document.ts";

/** Fixture timestamps — all safely in the past relative to any build clock. */
const JAN1 = new Date("2024-01-01T00:00:00Z");
const FEB1 = new Date("2024-02-01T00:00:00Z");
const MAR1 = new Date("2024-03-01T00:00:00Z");

/** A T004-shaped page with no I/O (mirrors the other feature tests). */
function page(url: string, data: Record<string, unknown> = {}): Page {
  return { path: `/content${url}index.md`, data, content: "", url };
}

/** A post: same shape plus the T008 `posts` membership stamp. */
function post(url: string, data: Record<string, unknown> = {}): Page {
  return page(url, { collection: "posts", ...data });
}

/**
 * Run the feature's only hook over `pages` with a FeatureContext standing in
 * for T012's (same `options(validate)` contract, minus the report wiring that
 * belongs to T012's own tests).
 */
function run(
  pages: Page[],
  flags: Partial<BuildFlags> = {},
  featureOptions: Record<string, unknown> = {},
): void {
  const ctx: FeatureContext = {
    name: "related",
    flags: { drafts: false, future: false, noCache: false, ...flags },
    options<T>(validate: (raw: unknown) => T): T {
      return validate(featureOptions["related"]);
    },
  };
  related.onSite!({ pages, data: {} }, ctx);
}

test("scores by tag overlap: 2 shared tags rank above 1", () => {
  const a = post("/posts/a/", {
    title: "A",
    date: new Date("2024-01-03T00:00:00Z"),
    tags: ["x", "y", "z"],
  });
  const b = post("/posts/b/", {
    title: "B",
    date: new Date("2024-01-02T00:00:00Z"),
    tags: ["x", "y"],
  });
  const c = post("/posts/c/", {
    title: "C",
    date: new Date("2024-01-01T00:00:00Z"),
    tags: ["y"],
  });

  run([a, b, c]);

  // B (score 2) before C (score 1); entries are exactly the template-safe
  // { title, url, date } shape with date as an ISO 8601 string.
  assert.deepEqual(a.data.related as RelatedEntry[], [
    { title: "B", url: "/posts/b/", date: "2024-01-02T00:00:00.000Z" },
    { title: "C", url: "/posts/c/", date: "2024-01-01T00:00:00.000Z" },
  ]);
});

test("a post never appears in its own related list", () => {
  const a = post("/posts/a/", { title: "A", date: MAR1, tags: ["x"] });
  const b = post("/posts/b/", { title: "B", date: FEB1, tags: ["x"] });

  run([a, b]);

  assert.deepEqual(a.data.related as RelatedEntry[], [
    { title: "B", url: "/posts/b/", date: "2024-02-01T00:00:00.000Z" },
  ]);
  assert.deepEqual(b.data.related as RelatedEntry[], [
    { title: "A", url: "/posts/a/", date: "2024-03-01T00:00:00.000Z" },
  ]);
});

test("draft post is absent by default and present with --drafts", () => {
  const a = post("/posts/a/", { date: JAN1, tags: ["x"] });
  const draft = post("/posts/draft/", { date: FEB1, tags: ["x"], draft: true });

  run([a, draft]);
  assert.deepEqual(a.data.related as RelatedEntry[], []);

  run([a, draft], { drafts: true });
  assert.deepEqual(a.data.related as RelatedEntry[], [
    { title: "", url: "/posts/draft/", date: "2024-02-01T00:00:00.000Z" },
  ]);
});

test("future-dated post is absent by default and present with --future", () => {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const a = post("/posts/a/", { date: JAN1, tags: ["x"] });
  const future = post("/posts/future/", { date: tomorrow, tags: ["x"] });

  run([a, future]);
  assert.deepEqual(a.data.related as RelatedEntry[], []);

  run([a, future], { future: true });
  const entries = a.data.related as RelatedEntry[];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].url, "/posts/future/");
});

test("limit 5 caps 10 qualifiers at exactly 5; default limit also 5", () => {
  const a = post("/posts/a/", {
    date: new Date("2024-01-11T00:00:00Z"),
    tags: ["t"],
  });
  const pool: Page[] = [a];
  for (let i = 1; i <= 10; i += 1) {
    const day = String(i).padStart(2, "0");
    pool.push(
      post(`/posts/p${day}/`, {
        date: new Date(`2024-01-${day}T00:00:00Z`),
        tags: ["t"],
      }),
    );
  }

  run(pool, {}, { related: { limit: 5 } });
  // All tie at score 1 → date descending picks the five newest.
  assert.deepEqual(
    (a.data.related as RelatedEntry[]).map((entry) => entry.url),
    ["/posts/p10/", "/posts/p09/", "/posts/p08/", "/posts/p07/", "/posts/p06/"],
  );

  run(pool); // default limit 5
  assert.equal((a.data.related as RelatedEntry[]).length, 5);
});

test("fewer qualifying posts than the limit returns all of them, no error", () => {
  const a = post("/posts/a/", { date: MAR1, tags: ["t"] });
  const q1 = post("/posts/q1/", { date: FEB1, tags: ["t"] });
  const q2 = post("/posts/q2/", { date: JAN1, tags: ["t", "u"] });
  const q3 = post("/posts/q3/", { date: JAN1, tags: ["t"] });

  assert.doesNotThrow(() => run([a, q1, q2, q3]));
  assert.equal((a.data.related as RelatedEntry[]).length, 3);
});

test("equal score, different dates → newer first, regardless of URL order", () => {
  const a = post("/posts/a/", { date: JAN1, tags: ["x"] });
  const older = post("/posts/m-older/", { date: FEB1, tags: ["x"] });
  const newer = post("/posts/z-newer/", { date: MAR1, tags: ["x"] });

  run([a, older, newer]);

  assert.deepEqual(
    (a.data.related as RelatedEntry[]).map((entry) => entry.url),
    ["/posts/z-newer/", "/posts/m-older/"],
  );
});

test("equal score and equal date → lower URL first", () => {
  const a = post("/posts/a/", { date: JAN1, tags: ["x"] });
  const z = post("/posts/z/", { date: MAR1, tags: ["x"] });
  const b = post("/posts/b/", { date: MAR1, tags: ["x"] });

  run([a, z, b]);

  assert.deepEqual(
    (a.data.related as RelatedEntry[]).map((entry) => entry.url),
    ["/posts/b/", "/posts/z/"],
  );
});

test("one post → related []; zero posts → no error", () => {
  const solo = post("/posts/solo/", { date: JAN1, tags: ["x"] });

  run([solo]);
  assert.deepEqual(solo.data.related as RelatedEntry[], []);

  assert.doesNotThrow(() => run([]));
});

test("an untagged post gets [] even beside tag-sharing peers", () => {
  const plain = post("/posts/plain/", { date: JAN1 });
  const tagged = post("/posts/tagged/", { date: FEB1, tags: ["x"] });

  run([plain, tagged]);

  assert.deepEqual(plain.data.related as RelatedEntry[], []);
  assert.deepEqual(tagged.data.related as RelatedEntry[], []);
});

test("pages never get related and never qualify as candidates", () => {
  const a = post("/posts/a/", { date: JAN1, tags: ["x"] });
  const about = page("/about/", { title: "About", date: FEB1, tags: ["x"] });

  run([a, about]);

  assert.deepEqual(a.data.related as RelatedEntry[], []);
  assert.equal(about.data.related, undefined);
});

test("invalid features.related.limit fails with an error naming it", () => {
  const a = post("/posts/a/", { date: JAN1, tags: ["x"] });

  for (const bad of [0, -1, 2.5, "five", null]) {
    assert.throws(
      () => run([a], {}, { related: { limit: bad } }),
      /features\.related\.limit" must be a positive integer/,
      `limit ${String(bad)} must be rejected`,
    );
  }
});
