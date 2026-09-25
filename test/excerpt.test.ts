/**
 * T020 acceptance — excerpts: frontmatter precedence, markup stripping,
 * word-boundary cap, empty bodies, bad config.
 *
 * The hook is exercised directly with a FeatureContext standing in for
 * T012's (same `options(validate)` contract, prefix included, minus the
 * report wiring that belongs to T012's own tests); documents are T004's
 * shape without I/O. The feature is synchronous, so every run below is.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import excerpt from "../src/features/excerpt.ts";
import type { Document } from "../src/content/document.ts";
import type { FeatureContext } from "../src/feature.ts";

const SOURCE = "/site/content/posts/excerpt.md";

/** The Document shape after the hook ran — `excerpt` is always a string. */
interface Excerpted extends Document {
  excerpt: string;
}

/**
 * One FeatureContext for the given `features.excerpt` slice — mirroring
 * T012's `makeContext`, validator failures included.
 */
function context(slice?: unknown): FeatureContext {
  return {
    name: "excerpt",
    flags: { drafts: false, future: false, noCache: false },
    options<T>(validate: (raw: unknown) => T): T {
      try {
        return validate(slice);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`features.excerpt: ${reason}`, { cause: error });
      }
    },
  };
}

/** A bare document — T004's shape without I/O. */
function doc(content: string, data: Record<string, unknown> = {}): Document {
  return { path: SOURCE, data, content };
}

/** Run the hook over a fresh document and return it for assertion. */
function run(
  content: string,
  data: Record<string, unknown> = {},
  slice?: unknown,
): Excerpted {
  const target = doc(content, data);
  const hook = excerpt.onDocument;
  assert.ok(hook !== undefined, "excerpt feature must export onDocument");
  hook.call(excerpt, target, context(slice));
  return target as Excerpted;
}

/** Run the hook and return the throw, failing if it returns. */
function expectHookError(target: Document, slice?: unknown): Error {
  const hook = excerpt.onDocument;
  assert.ok(hook !== undefined, "excerpt feature must export onDocument");
  try {
    hook.call(excerpt, target, context(slice));
  } catch (error) {
    assert.ok(error instanceof Error, `expected an Error, got ${typeof error}`);
    return error;
  }
  return assert.fail("onDocument() returned but was expected to throw");
}

test("frontmatter excerpt wins verbatim — never derived, capped, or ellipsized", () => {
  const body = "A completely different body paragraph.";

  const wins = run(body, { excerpt: "Frontmatter wins" });
  assert.equal(wins.excerpt, "Frontmatter wins");

  // Longer than the entire body and than the 260-code-point cap: still exact.
  const long = run(body, { excerpt: "x".repeat(300) });
  assert.equal(long.excerpt, "x".repeat(300));
  assert.ok(!long.excerpt.includes("…"));

  // Surrounding whitespace only — inner content untouched.
  const padded = run(body, { excerpt: "  padded only  " });
  assert.equal(padded.excerpt, "padded only");
});

test("markup-heavy paragraph yields visible text only", () => {
  const d = run(
    'Some <em>emphasis</em> and <a href="x">anchor</a>, **bold** text, [label](url), and &amp; entities.\n\nSecond paragraph, ignored.',
  );
  assert.equal(
    d.excerpt,
    "Some emphasis and anchor, bold text, label, and & entities.",
  );
  for (const forbidden of ["<", ">", "**", "](", "&amp;"]) {
    assert.ok(
      !d.excerpt.includes(forbidden),
      `${JSON.stringify(forbidden)} leaked into ${JSON.stringify(d.excerpt)}`,
    );
  }
});

test("first non-empty prose paragraph wins; structural blocks never contribute", () => {
  const content = [
    "# Heading",
    "",
    "## Subheading",
    "",
    "- list item",
    "",
    "> quoted line",
    "",
    "| a | b |",
    "| - | - |",
    "| 1 | 2 |",
    "",
    "```js",
    "const code = true;",
    "```",
    "",
    "The real first paragraph.",
    "",
    "Later paragraph.",
  ].join("\n");
  assert.equal(run(content).excerpt, "The real first paragraph.");
});

test("heading-only body, nested-only bodies, and empty documents → empty string", () => {
  const headingOnly = run("# Just a heading\n\n## And a subheading");
  assert.equal(headingOnly.excerpt, "");
  assert.equal(typeof headingOnly.excerpt, "string");
  assert.equal(headingOnly.data.excerpt, "");

  const listOnly = run("- only\n- a list\n\n> and a quote");
  assert.equal(listOnly.excerpt, "");

  const empty = run("");
  assert.equal(empty.excerpt, "");
  assert.equal(empty.data.excerpt, "");
});

test("heading then paragraph — blank line or not — reads from the paragraph", () => {
  assert.equal(run("# Title\n\nFinally, prose.").excerpt, "Finally, prose.");
  assert.equal(
    run("# Title\nParagraph right after the heading.").excerpt,
    "Paragraph right after the heading.",
  );
});

test("paragraph under the cap is returned whole, without an ellipsis", () => {
  const text = "A perfectly ordinary paragraph that stays under the cap.";
  const d = run(text);
  assert.equal(d.excerpt, text);
  assert.ok(!d.excerpt.includes("…"));
});

test("300-character paragraph caps on a word boundary with an ellipsis", () => {
  const words = "word ".repeat(60); // exactly 300 characters
  const d = run(words);
  assert.equal(d.excerpt, "word ".repeat(51) + "word" + "…");
  assert.ok([...d.excerpt].length <= 261);
  assert.ok(d.excerpt.endsWith("…"));
  assert.ok(!d.excerpt.slice(0, -1).endsWith(" "));
});

test("no whitespace inside the cap → cut at the cap exactly", () => {
  const d = run("a".repeat(300));
  assert.equal(d.excerpt, "a".repeat(260) + "…");
  assert.equal([...d.excerpt].length, 261);
});

test("whitespace exactly at the cap still cuts there", () => {
  const d = run("a".repeat(260) + " " + "b".repeat(50));
  assert.equal(d.excerpt, "a".repeat(260) + "…");
});

test("emoji count once and a surrogate pair is never split", () => {
  const d = run("🎉".repeat(300));
  assert.equal(d.excerpt, "🎉".repeat(260) + "…");
  assert.equal([...d.excerpt].length, 261);
  // Every kept unit is the whole emoji — two UTF-16 units, never a half.
  assert.ok([...d.excerpt.slice(0, -1)].every((unit) => unit === "🎉"));
});

test("features.excerpt.length caps at the configured value", () => {
  const words = "word ".repeat(30); // 150 characters
  const d = run(words, {}, { length: 40 });
  assert.equal(d.excerpt, "word ".repeat(7) + "word" + "…");
  assert.equal([...d.excerpt].length, 40);
});

test("frontmatter excerpt ignores the configured cap entirely", () => {
  const d = run("body", { excerpt: "z".repeat(100) }, { length: 10 });
  assert.equal(d.excerpt, "z".repeat(100));
});

test("invalid features.excerpt.length fails naming features.excerpt.length", () => {
  for (const bad of [0, -5, 40.5, "260", null, Number.NaN, [260]]) {
    const error = expectHookError(doc("Body."), { length: bad });
    assert.ok(
      error.message.includes("features.excerpt.length"),
      `${String(bad)}: ${error.message}`,
    );
  }
  // Validation runs before the frontmatter shortcut: bad config never slips
  // through just because this document carries its own excerpt.
  const withFrontmatter = expectHookError(
    doc("Body.", { excerpt: "front" }),
    { length: 0 },
  );
  assert.ok(withFrontmatter.message.includes("features.excerpt.length"));
});

test("non-string frontmatter excerpt fails naming the excerpt field and the file", () => {
  for (const bad of [42, { quoted: true }, ["no"], true]) {
    const error = expectHookError(doc("Body.", { excerpt: bad }));
    assert.ok(error.message.includes(SOURCE), error.message);
    assert.ok(error.message.includes('"excerpt"'), error.message);
    assert.ok(error.message.includes("must be a string"), error.message);
  }
  const number = expectHookError(doc("Body.", { excerpt: 42 }));
  assert.equal(
    number.message,
    `${SOURCE}: frontmatter "excerpt" must be a string (got number)`,
  );
});

test("whitespace-only frontmatter excerpt counts as absent", () => {
  const d = run("Derived from the body.", { excerpt: "   \n  " });
  assert.equal(d.excerpt, "Derived from the body.");
});

test("the excerpt lands on the document and in data for templates", () => {
  const d = run("Visible on cards.");
  assert.equal(d.excerpt, "Visible on cards.");
  assert.equal(d.data.excerpt, "Visible on cards.");
});

test("HTML-block prose contributes its text with tags stripped", () => {
  const d = run(
    '<div class="lead">Lead paragraph &amp; intro</div>\n\nNext paragraph.',
  );
  assert.equal(d.excerpt, "Lead paragraph & intro");
});

test("an HTML block that strips to nothing falls through to the next paragraph", () => {
  const d = run("<!-- just a comment -->\n\nActual prose.");
  assert.equal(d.excerpt, "Actual prose.");
});

test("image alt text reads as its caption; link text and code spans are kept", () => {
  assert.equal(
    run("![the diagram](diagram.png) explains the flow.").excerpt,
    "the diagram explains the flow.",
  );
  assert.equal(
    run("See [the docs](https://example.com/docs) and run `npm test` today.")
      .excerpt,
    "See the docs and run npm test today.",
  );
});

test("HTML entities decode to plain characters", () => {
  const d = run("Caf&eacute; &amp; cr&#232;me bruc&eacute;e &hellip; done.");
  assert.equal(d.excerpt, "Café & crème brucée … done.");
});
