# T013 — Drafts & scheduled publishing

|            |                                                                              |
| ---------- | ---------------------------------------------------------------------------- |
| Wave/batch | W3·B1                                                                        |
| Depends on | T012                                                                         |
| Blocks     | T033, T034                                                                   |
| Owns       | `src/features/publish.ts`, `templates/partials/publish-meta.html`, `test/publish.test.ts` |
| Size       | M                                                                            |

## Goal

Posts marked `draft: true` or dated in the future never appear in any build
output (pages, collections, feed, sitemap, related, search, archives) unless
the build is run with `--drafts` / `--future`; a draft built with `--drafts`
is still emitted with a `noindex` meta so it can be previewed safely.

## Requirements

- Feature module `src/features/publish.ts` default-exporting a `Feature` with
  `onDocument(doc, ctx)` and `onSite(site, ctx)` hooks (T012 contract). No
  config key — behavior is driven entirely by CLI flags.
- A document is **hidden** when `draft: true` and `!ctx.flags.drafts`, or its
  frontmatter `date` is strictly later than the build start time (UTC) and
  `!ctx.flags.future`. A `date` exactly equal to build time counts as
  published. `draft` must be boolean `true` to hide; any other truthy type
  (e.g. `draft: "yes"`) is a build error naming the document path and the
  field `draft`.
- Flags reach the feature through `ctx.flags.drafts` / `ctx.flags.future`
  (booleans, default `false`), parsed by `kiln build` in T012's build
  command. `src/features/publish.ts` never reads `process.argv`.
- `onDocument` resolves `doc.data.published` (boolean) for **every** document
  before any markdown/layout render, and — for raw drafts (frontmatter
  `draft: true`, regardless of flags) — appends the partial file name
  `"publish-meta.html"` to `doc.data.injectHead`. The new partial
  `templates/partials/publish-meta.html` renders
  `<meta name="robots" content="noindex">`, so a draft built with `--drafts`
  carries a `noindex` meta through the base layout's head slot.
- `onSite` removes hidden entries from `site.pages` before T012 computes
  collections, so the emitter (T010) never writes their pages, the
  collections (home, tag/category archives, pagination) are derived from
  the filtered set, and no list contains them. (Flow: `onDocument` →
  `onSite` → compute collections → emit — hiding in `onSite` is
  sufficient.)
- **Ordering guarantee (owned by this ticket, pinned by its tests):**
  1. `onDocument` runs before all rendering and before every `onSite` /
     `onBuildEnd` (T012 lifecycle), so `data.published` exists before any
     consumer can act on a document.
  2. All `onSite` hooks complete before any `onBuildEnd` hook, so features
     that write files at build end — T018 feed, T019 sitemap — read filtered
     collections and cannot leak hidden documents even though their module
     names sort before/after `publish.ts`.
  3. A feature whose `onSite` filename-sorts before `publish` and enumerates
     posts there (T015 `pagination.ts`) must skip documents with
     `data.published === false`.
  4. T014/T022/T023, whose `onSite` sorts after `publish`, see hidden
     documents already removed.
- Excluded documents produce no output at all by default (their page is not
  emitted, not merely delinked).

## Acceptance criteria

- [ ] Plain `kiln build`: a `draft: true` post's URL is absent from `dist/`,
      absent from the home list, absent from `/feed.xml` and
      `/sitemap.xml`, and absent from related/search data.
- [ ] `kiln build --drafts`: the draft page exists in `dist/`, contains
      `<meta name="robots" content="noindex">`, and appears in collections.
- [ ] A post dated tomorrow is excluded by default and emitted by
      `kiln build --future`; `--drafts --future` includes both classes.
- [ ] A plain build with one draft and one future post produces `feed.xml`
      and `sitemap.xml` containing neither URL (ordering-guarantee test).
- [ ] `draft: "yes"` fails the build with an error naming the document path
      and `draft`, exit code 1.
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
npm test -- test/publish.test.ts          # unit: visibility flag + collection filtering
node src/cli.ts build                     # draft/future URLs not under dist/, no hits in feed.xml/sitemap.xml
node src/cli.ts build --drafts            # draft URL present under dist/; grep -q noindex <draft page>
node src/cli.ts build --future            # future-dated URL present under dist/
```

## Non-goals

- No scheduled rebuild/cron — Kiln does not publish a future post when its
  date arrives; the next build with default flags emits it.
- No per-post override of the flags, no timezone config (comparison is UTC),
  no `publishAt`/`unpublish` fields, no config key.
