# T021 — Reading time & word count

|            |                                                         |
| ---------- | ------------------------------------------------------- |
| Wave/batch | W3·B1                                                   |
| Depends on | T012                                                    |
| Blocks     | T033, T034                                              |
| Owns       | `src/features/readingTime.ts`, `test/readingTime.test.ts` |
| Size       | S                                                       |

## Goal

Every document exposes `words` (unicode-aware word count) and `readingTime`
(conservative minutes) on its `Document` for templates, so a post layout can
show "5 min read" and listings can show word counts with no client-side work.

## Requirements

- Feature module `src/features/readingTime.ts` exporting a `Feature` whose
  `onDocument(doc, cfg)` sets `doc.words` (integer ≥ 0) and `doc.readingTime`
  (integer ≥ 1) on every document.
- Count over plain visible text: HTML tags and markdown syntax are removed
  before counting, so markup never counts as words (`**bold**` → 1 word,
  `# Heading` → 2 words, `<code>x</code>` → 1 word).
- Unicode word rule:
  1. Split the text on Unicode whitespace (`\s` with the `u` flag — spaces,
     tabs, newlines, Unicode space separators) into non-empty tokens.
  2. Inside a token, every CJK character (Han, Hiragana, Katakana, Hangul)
     counts as one word on its own.
  3. Each maximal run of non-CJK characters inside a token counts as one word.
  Examples: `hello world` → 2; `你好世界` → 4; `Hello, 世界` → 3;
  `中文abc` → 3; `don't` → 1.
- Reading time: `max(1, ceil(words / wordsPerMinute))` — ceiling rounding
  (conservative, never rounds down) and never below 1 minute. Empty document →
  `words: 0`, `readingTime: 1`.
- Config: `features.readingTime.wordsPerMinute` — positive integer, default
  `200`. Invalid value (non-number, `0`, negative, non-integer) fails the
  build with an error naming `features.readingTime.wordsPerMinute`.
- Self-contained: uses only its own config key and the Document it is handed;
  no coupling to other features regardless of auto-discovery order.

## Acceptance criteria

- [ ] English body of exactly 200 whitespace-separated words → `words: 200`,
      `readingTime: 1`; 201 words → `readingTime: 2`.
- [ ] Body `你好世界` → `words: 4`, `readingTime: 1`.
- [ ] Body `Hello, 世界` → `words: 3` (unicode rule verified with mixed
      CJK/Latin tokens).
- [ ] Markdown/HTML markup is not counted: `**bold** and <em>x</em>` contributes
      exactly 3 words.
- [ ] Empty body → `words: 0`, `readingTime: 1`, build exits 0.
- [ ] `features.readingTime.wordsPerMinute: 100` with 150 words →
      `readingTime: 2`.
- [ ] `features.readingTime.wordsPerMinute: 0` (or `"fast"`) → build fails
      with an error naming `features.readingTime.wordsPerMinute`.
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
npm run typecheck && npm test                # both exit 0
npm test -- test/readingTime.test.ts         # passes: unicode/CJK counting, ceil math, min-1, invalid config
node src/cli.ts build                        # exits 0; fixture posts get words >= 0 and readingTime >= 1
```

## Non-goals

- No per-language or per-content-type reading speeds — one global
  `wordsPerMinute` only.
- No fractional/rounded display formats, no client-side JS, no caching layer,
  no word count of code blocks or frontmatter values.
