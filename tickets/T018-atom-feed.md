# T018 — RSS/Atom feed

|            |                                                                              |
| ---------- | ---------------------------------------------------------------------------- |
| Wave/batch | W3·B1                                                                        |
| Depends on | T012                                                                         |
| Blocks     | T033, T034                                                                   |
| Owns       | `src/features/feed.ts`, `templates/partials/feed.xml`, `test/feed.test.ts`   |
| Size       | M                                                                            |

## Goal

A valid Atom 1.0 feed at `/feed.xml` containing the latest posts with full
rendered content and absolute URLs, honoring T013's visibility rules and
failing loudly when `site.url` cannot produce absolute links.

## Requirements

- Feature module `src/features/feed.ts` default-exporting a `Feature` with
  an `onBuildEnd(result, ctx)` hook that writes `dist/feed.xml` directly
  (T012 contract: `onBuildEnd` may write files into `dist`). The XML body
  is produced by the new partial `templates/partials/feed.xml` — shared
  files are never edited.
- Output starts with `<?xml version="1.0" encoding="utf-8"?>`; root is
  `<feed xmlns="http://www.w3.org/2005/Atom">` with `<title>`, `<id>`,
  `<updated>`, and `<link rel="self" href="…/feed.xml">`.
- Every entry contains `<title>`, `<id>`, `<updated>`, `<link
  rel="alternate" href="…">`, and `<content type="html">` holding the
  post's **full rendered HTML** (same markup the page emits), XML-escaped
  — not an excerpt, not raw markdown.
- Absolute URLs: all `href`/`id` values are built by resolving paths
  against `site.url` (origin + path; trailing slash normalized, no
  double slashes). `site.url` missing, empty, or relative (e.g. `/blog`,
  `blog.example.com`, `//host`) → build error naming `site.url`, exit 1.
  Only `http://` / `https://` origins with a host are accepted.
- Entries: posts sorted by date descending, newest first, capped at
  `features.feed.limit` — positive integer, default `20`; `0`, negative,
  fractional, or non-number → build error containing `features.feed`,
  exit 1. Fewer posts than the limit → all of them; limit larger than the
  count → no padding, no error.
- T013 exclusions: the feed reads `site.pages` in `onBuildEnd`, which
  runs after every `onSite` (including `publish`'s removal of drafts and
  future posts) — hidden posts cannot appear. `--drafts` / `--future`
  builds include them, since `publish` keeps them in `site.pages`.
- Zero published posts → a **valid** empty feed: root element with
  `<title>`/`<id>`/`<updated>`, zero `<entry>` elements, build exits 0.
  Feed-level `<updated>` falls back to the build timestamp (UTC, ISO 8601)
  only in this case; with entries it is the newest post's date.
- Per-entry `<updated>` is the post's frontmatter date as ISO 8601 with
  timezone (UTC). Titles and content are XML-escaped (`&`, `<`, `>`,
  quotes); unicode passes through as UTF-8.

## Acceptance criteria

- [ ] Build with ≥ 2 posts → `dist/feed.xml` exists, parses as XML, root
      namespace is `http://www.w3.org/2005/Atom`, entry count is
      `min(20, postCount)`.
- [ ] Every `<id>` and `<link href>` starts with the configured `site.url`
      origin; no relative hrefs (regex `href="/` finds nothing).
- [ ] An entry's `<content type="html">` contains the post's full rendered
      markup (e.g. a `<h2>`/`<code>` block from the source post), escaped.
- [ ] Draft post absent from a default build's feed; present with
      `--drafts`. Future-dated post follows `--future` the same way.
- [ ] Removing `site.url` fails the build with an error naming `site.url`,
      exit 1; `site.url: "/blog"` fails the same way.
- [ ] Empty site (zero posts) → `dist/feed.xml` parses, has zero
      `<entry>`, build exits 0.
- [ ] `features.feed.limit: 0` fails the build with an error containing
      `features.feed`, exit 1; `features.feed.limit: 1` yields exactly one
      entry (newest post).
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
npm test -- test/feed.test.ts            # unit: Atom structure, escaping, limit validation, empty feed
node src/cli.ts build && grep -q '<feed xmlns="http://www.w3.org/2005/Atom">' dist/feed.xml && echo FEED-OK   # prints FEED-OK
```

## Non-goals

- No RSS 2.0 output, no JSON Feed, no per-tag/per-author feeds, no feed
  pagination beyond `features.feed.limit`, no `<link rel="alternate">`
  head injection into pages (that would edit shared layouts), no
  CDATA sections (entity escaping instead).
