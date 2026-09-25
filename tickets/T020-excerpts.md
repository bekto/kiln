# T020 — Excerpts

|            |                                                   |
| ---------- | ------------------------------------------------- |
| Wave/batch | W3·B1                                             |
| Depends on | T012                                              |
| Blocks     | T033, T034                                        |
| Owns       | `src/features/excerpt.ts`, `test/excerpt.test.ts` |
| Size       | S                                                 |

## Goal

Every document exposes a plain-text `excerpt` on its `Document` for templates:
a frontmatter `excerpt` wins verbatim, otherwise the first non-empty body
paragraph is stripped of all markup and capped on a word boundary — so
listings, archives, feeds, and search always have a safe one-line summary and
raw HTML can never leak into one.

## Requirements

- Feature module `src/features/excerpt.ts` exporting a `Feature` whose
  `onDocument(doc, cfg)` sets `doc.excerpt` (a string) on every document.
- Precedence: a frontmatter `excerpt` is used as written — trimmed of
  surrounding whitespace only, never truncated, never given an ellipsis, even
  when it is longer than the body or longer than the cap.
- Frontmatter `excerpt` must be a string. A non-string value (number, object,
  array) fails the build with an error naming the `excerpt` field and the
  source file. An empty or whitespace-only value counts as absent.
- Derivation: take the first non-empty paragraph — the first blank-line-separated
  block that is prose (does not start with a heading marker, list marker,
  blockquote, table pipe, or code fence). Strip HTML tags, inline markup
  (emphasis markers, link syntax keeps its link text, code-span backticks),
  decode HTML entities, and collapse internal whitespace to single spaces. The
  result is plain text; raw markup never appears in `doc.excerpt`.
- Cap: `features.excerpt.length` — positive integer, default `260`, counted in
  Unicode code points (an emoji counts once; never slice a surrogate pair).
  Longer excerpts cut at the last whitespace at or before the cap, trailing
  whitespace trimmed, and `…` (U+2026) appended; if there is no whitespace
  inside the cap, cut at the cap exactly and append `…`. A paragraph at or
  under the cap is returned whole, with no ellipsis.
- Invalid `features.excerpt.length` (non-number, `0`, negative, non-integer)
  fails the build with an error naming `features.excerpt.length`.
- Empty document (or no prose paragraph at all) → `doc.excerpt === ""`; never
  `undefined`, never a crash.
- Self-contained: uses only its own config key and the Document it is handed;
  no coupling to other features regardless of auto-discovery order.

## Acceptance criteria

- [ ] Frontmatter `excerpt: "Frontmatter wins"` → `doc.excerpt` is exactly
      `"Frontmatter wins"` even when the first body paragraph differs — and
      still wins when the frontmatter excerpt is longer than the entire body.
- [ ] First paragraph containing `<em>`, `<a href="x">`, `**bold**`, and
      `[label](url)` → `doc.excerpt` contains no `<`, `>`, `**`, `](`, or
      `&amp;` — visible text only (`label` kept for the link).
- [ ] First paragraph of 300 chars → `doc.excerpt` is ≤ 261 code points, ends
      at a word boundary, and ends with `…`.
- [ ] First paragraph under 260 chars → returned whole, no `…`.
- [ ] Body starting with a heading, then a paragraph → excerpt comes from the
      paragraph; body with only a heading → `""`.
- [ ] `features.excerpt.length: 40` → cap applied at 40; `features.excerpt.length: 0`
      → build fails with an error naming `features.excerpt.length`.
- [ ] Frontmatter `excerpt: 42` → build fails naming the `excerpt` field and
      the file.
- [ ] Empty document → `doc.excerpt === ""`, build exits 0.
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
npm run typecheck && npm test      # both exit 0
npm test -- test/excerpt.test.ts   # passes: precedence, markup stripping, word-boundary cap, empty body, bad config
node src/cli.ts build              # exits 0 on a fixture with frontmatter excerpt, derived excerpt, and an empty post
```

## Non-goals

- No truncation or rewriting of author-supplied frontmatter excerpts.
- No multi-paragraph or summary-length tuning, no image/media picking, no
  "read more" link generation.
- No edits to feeds, archives, or search (T018/T014/T023 consume `excerpt`
  through the Document; this ticket only sets the field).
