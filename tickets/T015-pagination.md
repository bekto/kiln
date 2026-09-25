# T015 — Pagination

|            |                                                                              |
| ---------- | ---------------------------------------------------------------------------- |
| Wave/batch | W3·B2                                                                        |
| Depends on | T014                                                                         |
| Blocks     | T033, T034                                                                   |
| Owns       | `src/features/pagination.ts`, `templates/partials/pagination.html`, `test/pagination.test.ts` |
| Size       | M                                                                            |

## Goal

The home list and every tag/category archive are split into pages of
`features.pagination.pageSize` posts (default 10): page 1 at the canonical
URL, overflow at `/page/2/` …, with working prev/next navigation — and
single posts are never paginated.

## Requirements

- Feature module `src/features/pagination.ts` default-exporting a `Feature`
  with an `onSite(site, ctx)` hook. Overflow pages are appended as
  `Page`-shaped objects (`{ path, content, data: { permalink, layout,
  posts, pagination } }`) to `site.pages` — `path` is a unique synthetic
  identifier, T010 derives each page's `url` at emit from `data.permalink`
  — and flow through T010's emit like discovered pages.
- Config key `features.pagination.pageSize`, read via `ctx.options(...)`:
  positive integer, default `10`. `0`, negative, fractional, or non-number
  → build error containing `features.pagination` and `pageSize`, exit 1.
- Paginates exactly two kinds of list: the home list (`/`) and T014's
  tag/category archives (`/tags/<slug>/`, `/categories/<slug>/`).
  Single posts and static pages are never paginated — no post page ever
  renders a `/page/` navigation link.
- Page 1 keeps the canonical URL (`/`, `/tags/<slug>/`, …); overflow pages
  live at `/page/2/` … `/page/<n>/` and `/tags/<slug>/page/2/` …, using
  T005's pretty-path mapping (trailing slash, directory `index.html`).
- Hook-order constraints (lexicographic filename order is T012's hook
  order: `pagination` < `publish` < `taxonomy`) — all handled inside this
  ticket, no reordering of T012:
  - `pagination`'s `onSite` runs **before** `publish` removes hidden
    documents, so it skips every document with `data.published === false`
    (T013 resolves that flag in `onDocument`, before any `onSite`): a
    draft/future post never occupies a page slot.
  - `pagination`'s `onSite` runs **before** `taxonomy` appends its archive
    documents, so it does not read T014's output. It re-derives the term
    set from the same frontmatter fields (`tags`, `category`) and T005's
    slugger that T014 uses, dedupes terms by slug (a duplicate that T014
    will reject still dedupes here — T014's error aborts the build before
    emit), and skips terms with zero visible posts (T014 owns raising that
    error). Identical derivation ⇒ the overflow paths line up with T014's
    archives.
- Page-1 slicing seam: at the start of its `onSite`, pagination publishes
  the resolved settings as `site.data.pagination = { pageSize }`. T014's
  archives consume it to slice their page-1 list (T014 renders the full
  list when the value is absent, i.e. before T015 lands). Pagination itself
  replaces the home document's post-list view data (the array the index
  layout renders) with the first `pageSize` visible posts.
- Per-page data: every list document gets
  `pagination: { page, totalPages, prevUrl, nextUrl }` (1-based `page`);
  `prevUrl` absent on page 1, `nextUrl` absent on the last page, and the
  `prevUrl` of page 2 is `/` — never `/page/1/`.
- New partial `templates/partials/pagination.html` renders prev/next links
  (root-relative, trailing slash) from `page.pagination`; renders nothing
  when `totalPages` is 1.
- Exactly one page (`visible count ≤ pageSize`) → no `/page/` directory is
  created; canonical list unchanged; partial emits nothing. Exactly
  `pageSize` posts → still one page (no empty `/page/2/`).
- Collision: an existing content document whose permalink already claims
  an overflow URL (e.g. content mapping to `/page/2/`) → build error naming
  the URL, exit 1.
- Watch-mode safe: page sets, slices, and term derivation are recomputed
  from scratch on every `onSite` invocation (T012 lifecycle: hooks re-run
  on each rebuild; no module-level state).

## Acceptance criteria

- [ ] 25 visible posts (default pageSize): `dist/index.html` lists 10 with
      a next link to `/page/2/`; `dist/page/2/index.html` has prev `/` and
      next `/page/3/`; `dist/page/3/index.html` lists the remaining 5 and
      has no next link.
- [ ] Exactly 10 visible posts → no `dist/page/` directory exists.
- [ ] A tag with 12 posts → `dist/tags/<slug>/page/2/index.html` exists with
      2 entries; the page-1 archive renders 10 entries (pageSize seam).
- [ ] Single-post pages contain no pagination navigation (grep for
      `/page/` in a post's HTML finds nothing).
- [ ] 11 posts of which 1 is a draft (no flags) → only one page; adding
      `--drafts` creates `/page/2/`.
- [ ] `features.pagination.pageSize: 0` fails the build with an error
      containing `features.pagination`, exit 1.
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
npm test -- test/pagination.test.ts       # builds a 25-post fixture: asserts dist/page/{2,3}/index.html, prev/next hrefs, slicing, validation error
npm run typecheck && npm test             # both green
```

## Non-goals

- No numbered jump-to-page lists (prev/next only), no infinite scroll or
  client-side paging, no configurable URL pattern (`/page/N/` is fixed),
  no pagination of the `/tags/` and `/categories/` index pages, no
  paginated feeds (T018 caps with `features.feed.limit` instead).
