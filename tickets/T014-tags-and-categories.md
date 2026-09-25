# T014 — Tags & category archives

|            |                                                                              |
| ---------- | ---------------------------------------------------------------------------- |
| Wave/batch | W3·B1                                                                        |
| Depends on | T012                                                                         |
| Blocks     | T015, T033, T034                                                             |
| Owns       | `src/features/taxonomy.ts`, `templates/partials/taxonomy-list.html`, `test/taxonomy.test.ts` |
| Size       | M                                                                            |

## Goal

Every tag and category that has visible posts gets an archive page at
`/tags/<slug>/` or `/categories/<slug>/`, plus `/tags/` and `/categories/`
index pages listing all terms with counts — all rendered through T009's
existing layouts using one new partial.

## Requirements

- Feature module `src/features/taxonomy.ts` default-exporting a `Feature`
  with an `onSite(site, ctx)` hook (T012 contract). No config key — default
  on; reads its own open-frontmatter fields: `tags` (array of strings) and
  `category` (single string).
- Archive URLs follow T005's unicode-safe slugger and pretty-path mapping:
  `/tags/<slug>/`, `/categories/<slug>/`; index pages at `/tags/` and
  `/categories/`.
- Archives and indexes are added by appending `Page`-shaped objects
  (`{ path, content, data: { permalink, layout } }`) to `site.pages` in
  `onSite` — `path` is a unique synthetic identifier; T010 computes each
  page's `url` at emit from `data.permalink`, and the pages flow through
  emit and the build report like discovered pages. No file writes outside
  `dist/` via emit.
- Listing markup lives in the new partial
  `templates/partials/taxonomy-list.html` (new file each — shared layouts
  and partials are never edited); the archive pages reuse T009's index
  layout. Each entry shows the post title (linked to its URL) and date,
  sorted newest first, identical to collection order.
- Page-1 slicing seam for T015: `pagination.ts` filename-sorts before
  `taxonomy.ts`, so T015's `onSite` publishes the resolved
  `site.data.pagination = { pageSize }` before this feature's `onSite`
  runs. When that value is present, an archive with more visible posts
  than `pageSize` sets `data.posts` to the first `pageSize` entries
  (overflow pages are T015's job). When it is absent — T014 standalone,
  before T015 lands — the full list renders. The partial always renders
  `page.posts`.
- Only posts with `data.published !== false` participate (T013 visibility is
  resolved in `onDocument`, before any `onSite`).
- Validation — each of the following fails the build (exit 1) with an error
  naming the offending tag/category and the source document:
  - empty or whitespace-only tag string (e.g. `tags: [""]`).
  - non-string entry in `tags` (e.g. `tags: [42]`).
  - slug collision: two distinct terms slugify to the same path (e.g.
    `Web dev` and `web-dev` → `web-dev`); the error names **both** terms.
  - a term whose archive would contain zero visible posts (e.g. its only
    posts are drafts) — the error names the tag exactly as written in
    frontmatter.
- Unicode terms (e.g. `tags: ["技術"]`) slugify via T005's unicode-safe
  slugger; links are percent-encoded consistently with T005's path→URL
  mapping.
- Index pages list each term, its count, and a link; terms sorted by slug
  for deterministic output.

## Acceptance criteria

- [ ] Three posts tagged `kilo` → `dist/tags/kilo/index.html` lists exactly
      those three, newest first; `dist/tags/index.html` shows `kilo` with
      count 3.
- [ ] A post with `category: news` → `dist/categories/news/index.html`
      exists; `dist/categories/index.html` lists it.
- [ ] `tags: [""]` fails the build naming the tag and the document; exit 1.
- [ ] Two tags `Web dev` and `web-dev` fail the build with an error naming
      both.
- [ ] A tag carried only by draft posts fails a default build with an error
      naming the tag (drafts hidden per T013).
- [ ] A unicode tag builds its archive; its URL equals T005's slug output
      and the index link resolves.
- [ ] Archive pages appear in the build report's emitted list with their
      pretty-path URLs.
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
npm test -- test/taxonomy.test.ts         # unit: slugs, validation errors, archive lists
node src/cli.ts build && ls dist/tags dist/categories   # index dir + one directory per term
```

## Non-goals

- No pagination of archives (T015), no tag descriptions/fancy term pages,
  no per-tag feeds (T018 covers the main feed only), no taxonomy config
  keys, no renaming/merging of terms.
