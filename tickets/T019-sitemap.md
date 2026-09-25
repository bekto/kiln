# T019 — Sitemap.xml

|            |                                                                              |
| ---------- | ---------------------------------------------------------------------------- |
| Wave/batch | W3·B1                                                                        |
| Depends on | T012                                                                         |
| Blocks     | T033, T034                                                                   |
| Owns       | `src/features/sitemap.ts`, `test/sitemap.test.ts`                            |
| Size       | S                                                                            |

## Goal

`dist/sitemap.xml` lists exactly the HTML pages T010 emitted in this build,
as absolute URLs from `site.url`, with `<lastmod>` from each page's
frontmatter date — never including hidden drafts/future posts.

## Requirements

- Feature module `src/features/sitemap.ts` default-exporting a `Feature`
  with an `onBuildEnd(result, ctx)` hook that writes `dist/sitemap.xml`
  directly from `result.emitted` (T012 contract: `{ url, file }[]`, `file`
  dist-relative POSIX). No partial needed — markup is assembled in the
  feature; no shared files edited.
- The `<loc>` set **equals** the emitted URL set of the current build:
  every emitted `.html` page (home, posts, static pages, and
  feature-appended list pages that reached emit), once each, no
  duplicates. Non-HTML emissions (e.g. `/feed.xml`, JSON indexes) are not
  `.html` and are excluded, as is `sitemap.xml` itself.
- URLs are absolute: each emitted `url` resolved against `site.url`
  (trailing-slash normalized, no double slashes). `site.url` missing,
  empty, or relative (`/blog`, `blog.example.com`, `//host`) → build error
  naming `site.url`, exit 1; only `http://` / `https://` origins with a
  host are accepted (same rule as T018).
- T013 exclusions hold automatically: hidden drafts/future posts are
  removed from `site.pages` in `onSite`, never reach emit, so they cannot
  appear in `emitted` — and this ticket pins that with a test rather than
  re-filtering. A `--drafts` build does list the draft's URL (it was
  emitted).
- `<lastmod>` comes from the source page's frontmatter `date`: ISO 8601
  (`YYYY-MM-DD` when the date is date-only, full timestamp with timezone
  otherwise). Pages without a `date` (e.g. home, tag archives) omit
  `<lastmod>` — valid sitemap, not an error.
- Root: `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;
  one `<url>` per page with `<loc>` first, then optional `<lastmod>`.
  Entries sorted lexicographically by `<loc>` for deterministic output
  (golden-site snapshots depend on byte stability). Unicode URLs are
  percent-encoded consistently with T005's path→URL mapping.
- Zero/one-page site still writes a valid `sitemap.xml` (home at minimum),
  exit 0.

## Acceptance criteria

- [ ] After a plain build, `grep -c '<loc>' dist/sitemap.xml` equals the
      number of HTML pages under `dist/` from that build; the loc set and
      the emitted-URL set are identical (no `feed.xml`, no `sitemap.xml`,
      no `dist/` non-HTML files).
- [ ] All `<loc>` values start with the configured `site.url`; entries are
      lexicographically sorted with no duplicates.
- [ ] A post with `date: 2026-01-02` emits `<lastmod>2026-01-02</lastmod>`;
      a page without `date` has no `<lastmod>` element.
- [ ] Draft post's URL absent from a default build's sitemap; present with
      `--drafts` (matches what T010 emitted).
- [ ] Missing `site.url` → build error naming `site.url`, exit 1;
      relative `site.url: "/blog"` → same.
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
npm test -- test/sitemap.test.ts         # unit: loc/emitted set equality, lastmod, site.url validation
node src/cli.ts build && grep -c '<loc>' dist/sitemap.xml   # count equals emitted HTML page count
```

## Non-goals

- No `robots.txt`, no sitemap index files (`sitemap-index.xml`), no
  image/video/news/mobile extensions, no priority/change-frequency
  attributes, no inclusion of non-HTML outputs, no separate config key
  (driven entirely by `site.url` + emitted pages).
