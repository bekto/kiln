# T004 — Frontmatter & Document model

|            |                                                  |
| ---------- | ------------------------------------------------ |
| Wave/batch | W1·B1                                            |
| Depends on | T003                                             |
| Blocks     | T006, T007                                       |
| Owns       | `src/content/document.ts`, `test/document.test.ts` |
| Size       | M                                                |

## Goal

A content module that turns a Markdown file into a typed `Document` — YAML
frontmatter parsed with `gray-matter@4` into an open `data` bag, the markdown
body as `content`, dates normalized to `Date`, and malformed frontmatter
rejected with an error that names the file and line.

## Requirements

- Export the pipeline's core types (types only — no rendering, no I/O beyond
  reading one file):
  - `Document { path: string; data: Record<string, unknown>; content: string }`
    — `path` is the absolute source file path; `data` is fully open (frontmatter
    stays open — concurrency rule 5: features read their own fields, T004 never
    narrows them).
  - `Page extends Document { url: string }` — a document plus its final site
    URL (URL production is T005/T007/T010's job; T004 only defines the type).
  - `Site { pages: Page[]; data: Record<string, unknown> }` — site-level
    container with an open `data` bag for site metadata.
- Parsing API:
  - `parseDocument(filePath: string, raw: string): Document` — pure/sync.
  - `readDocument(filePath: string): Promise<Document>` — reads the file, then
    delegates to `parseDocument`.
- Frontmatter via `gray-matter@4`:
  - File with `---` fences → `data` = parsed YAML mapping, `content` = body
    with fences removed and a single leading newline after the closing `---`
    stripped.
  - File without frontmatter → `data` = `{}`, `content` = the entire file.
  - Empty file → `data` = `{}`, `content` = `''`.
- Frontmatter must be a YAML mapping. A sequence/scalar frontmatter (e.g.
  `---\n- a\n- b\n---`) → error `<path>: frontmatter must be a YAML mapping`.
- Date handling: `data.date`, when present, must be a `Date` or a string
  parseable by `new Date()`; strings are normalized to `Date` in the returned
  `data`. `new Date('2024-05-01')` semantics (UTC) are acceptable — tests must
  pin one timezone-independent expectation. Invalid value (bad string, number,
  boolean) → error `<path>: "date" must be a valid date (got <type>)`. Absent
  `date` is legal and left absent (later tickets decide fallbacks).
- Precise errors for invalid YAML: wrap `gray-matter`'s exception so the
  message contains the file path and the YAML `line N` position — e.g.
  `content/post.md: invalid frontmatter at line 3: unexpected end of stream`.
- All other frontmatter values pass through untouched: arrays stay arrays,
  nested objects stay objects, unicode is not mangled.

## Acceptance criteria

- [ ] `---\ntitle: Hi\ndate: "2024-05-01"\n---\nHello` → `data.title === 'Hi'`,
      `data.date instanceof Date`, `content === 'Hello'`.
- [ ] A file with no frontmatter → `data` deep-equals `{}` and `content` equals
      the whole file.
- [ ] Empty file → `{ data: {}, content: '' }`.
- [ ] Broken YAML (e.g. unclosed quote) → throws; message contains the file
      path and `line`.
- [ ] Sequence frontmatter (`---\n- a\n---`) → throws with
      `frontmatter must be a YAML mapping` and the path.
- [ ] `date: not-a-date` → throws with the path and `"date"` in the message.
- [ ] Extra fields preserved: `tags: [a, b]` stays an array, a nested object
      stays deep-equal, a CJK/emoji title passes through unchanged.
- [ ] `readDocument` on a temp fixture file returns the same result as
      `parseDocument` on its raw text.
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
npm test -- test/document.test.ts  # unit: parsing, date normalization, 3 error shapes
npm run typecheck && npm test      # both exit 0
```

## Non-goals

- No file discovery/globbing (T007), no excerpt extraction (T020), no URL
  assignment (`Page.url` is just declared), no draft/date filtering (T013),
  no rendering (T006), no schema validation of `data` contents.
