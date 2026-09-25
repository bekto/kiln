# T010 — Permalink emission

|            |                                    |
| ---------- | ---------------------------------- |
| Wave/batch | W2·B2                              |
| Depends on | T005, T009                         |
| Blocks     | T012                               |
| Owns       | `src/render/emit.ts`, `test/emit.test.ts` |
| Size       | M                                  |

## Goal

Every `Page` of the `Site` renders to HTML and lands under `dist/` at its
pretty URL path (`/posts/my-post/` → `dist/posts/my-post/index.html`), with a
hard guarantee that nothing is ever written outside `dist/`.

## Requirements

- Export from `src/render/emit.ts`:
  - `interface EmittedPage { url: string; file: string }` — `file` is
    dist-relative POSIX.
  - `interface EmitResult { emitted: EmittedPage[]; skipped: EmittedPage[] }`.
  - `pageOutputFor(page: Page): EmittedPage` — pure URL→file pairing:
    `url = page.url ?? (data.permalink
    ? applyPermalink(data.permalink, { slug: slugFromPath(path), date: data.date })
    : urlForPath(path))` (T005 fallback, so feature-appended pages that
    carry only `data.permalink`/`path` emit correctly),
    `file = filePathForUrl(url)`. T012 reuses this for cache-skip report
    entries.
  - `emitPages(site: Site, options: EmitOptions): Promise<EmitResult>` with
    `EmitOptions { distDir?: string /* default 'dist' */; extensions?:
    MarkdownExtension[]; extra?: Record<string, unknown>; shouldSkip?:
    (page: Page) => boolean }`.
- Per `site.pages`, in order:
  - Resolve output via `pageOutputFor`. If `shouldSkip(page)` returns true
    **and** `dist/<file>` already exists → record in `skipped`, render/write
    nothing (cache-hit seam for T012/T029; a missing target file defeats the
    skip and forces a render, so a lying cache can never leave a hole).
  - Otherwise `renderDocument(page, { url, site, extensions, extra })` via
    T009, create parent directories (`mkdir -p` semantics), write UTF-8,
    overwrite an existing file (normal rebuild), record in `emitted`.
- Safety (the central invariant): before any render or write, a pre-scan of
  every page resolves its absolute target and requires it to be strictly
  inside `path.resolve(distDir)`; otherwise throw
  `refusing to write outside dist: <url> → <file> (<page path>)` naming the
  page. A `permalink` like `/../../escape/` (which T005 normalizes but does
  not neutralize) must fail the build with nothing written outside `dist/`.
- Duplicate guard: pre-scan all pages; two pages resolving to the same
  `file` → throw `duplicate output file: <file> (urls: <a>, <b>)` before
  anything is written.
- Site template context (built once per `emitPages` call, O(n)): `site` =
  `{ ...site.data, pages: site.pages.map(pageView) }`; every page's context
  additionally gets `extra` (T012 passes `collections` and `flags`) merged
  top-level — `page`/`site`/`content` keys cannot be shadowed.
- Write failures (EACCES, ENOSPC, path occupied by a file) → reject with an
  error naming the target path.
- Zero pages → no writes and no `dist/` creation; result is all-empty,
  success.
- `emitted`/`skipped` preserve page order; files land exactly at
  `dist/<file>` with POSIX separators on all platforms.

## Acceptance criteria

- [ ] Fixture pages with urls `/` and `/posts/my-post/` →
      `dist/index.html` and `dist/posts/my-post/index.html` exist, contain
      the layout output (doctype + rendered body), and `result.emitted`
      lists both pairs in site order.
- [ ] `pageOutputFor`: directory url → `…/index.html`; a page with no
      `url` but `data.permalink` → T005-expanded url; neither →
      `urlForPath(path)` fallback.
- [ ] Page with frontmatter `permalink: '/../../escape/'` → rejects with
      `refusing to write outside dist`, naming the page; a sentinel check
      confirms nothing was created outside the dist root.
- [ ] Two pages resolving to the same file → `duplicate output file`
      naming both urls, and neither file was written (pre-scan).
- [ ] `shouldSkip` returning true for a page whose output file exists →
      listed in `skipped`, file bytes untouched (sentinel content survives).
- [ ] `shouldSkip` true but output file missing → page is rendered and
      listed in `emitted` instead.
- [ ] An `extensions` entry's markup appears in written HTML (T012 seam
      passes through); `extra: { collections }` is readable by the layout.
- [ ] Site with zero pages → empty result, no `dist/` directory created.
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
npm test -- test/emit.test.ts    # pretty paths, safety refusal, dup guard, skip seam, zero-page
npm run typecheck && npm test    # both exit 0
```

## Non-goals

- No URL assignment for discovered pages (T007), no asset copying (T011),
  no cache/hash logic itself (`emitPages` only exposes the `shouldSkip`
  callback; hashing is T029), no extension-bearing URL mapping beyond T005's
  `filePathForUrl` rules, no pruning of stale output files (`kiln clean`,
  T025), no minification (T030), no feeds/sitemaps (T018/T019 features).
