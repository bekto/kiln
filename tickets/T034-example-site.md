# T034 — Example site

|            |              |
| ---------- | ------------ |
| Wave/batch | W5·B1        |
| Depends on | T013–T023 (all of W3) |
| Blocks     | —            |
| Owns       | `site/**`    |
| Size       | M            |

## Goal

A polished demo site under `site/` — 8 published posts across 3 tags, 2
static pages, code samples, and one tiny image — that visibly proves every
Wave-3 feature (search UI, pagination nav, feed link, TOC, tag archives,
excerpts, reading time, related posts, highlighting, sitemap, drafts hidden),
built with one documented command used verbatim by the README quickstart
(T035) and CI (T036).

## Requirements

### Site layout (`site/`)

- `site/kiln.config.ts`:
  - `site: { title: 'Kiln example site', url: 'https://example.com',
    description: … }` — absolute `site.url` (T018's hard requirement for
    the feed).
  - Directory keys stay at their defaults (`content/`, `templates/`,
    `public/`, `dist/`) so everything resolves inside `site/` when the
    build runs with `site/` as cwd; output lands in `site/dist/`.
  - Feature keys (each validated by its own feature; publish/taxonomy/
    sitemap need no key — default on):

```ts
features: {
  highlight: { theme: 'github-dark' },   // T016
  toc: { depth: 3 },                     // T017
  feed: { limit: 10 },                   // T018
  pagination: { pageSize: 3 },           // T015 — 8 posts → 3 list pages
  excerpt: { length: 200 },              // T020
  readingTime: { wordsPerMinute: 200 },  // T021
  related: { limit: 3 },                 // T022
  search: { indexPath: 'search-index.json' }, // T023
}
```

- Posts (`site/content/posts/`, all past dates, all distinct):
  `hello-kiln.md` (tags `guides`, `ts` code block),
  `writing-markdown.md` (tags `guides`, `reference` — GFM table,
  strikethrough, `bash` fence), `frontmatter-fields.md` (tags `reference`),
  `template-layouts.md` (tags `reference`, `html` fence),
  `café-münster-日本語.md` (tags `showcase` — unicode filename → unicode
  URL, unicode title), `syntax-highlighting-tour.md` (tags `showcase` —
  `ts` + `css` fences, long enough for TOC + related),
  `feeds-and-sitemaps.md` (tags `reference`), `search-tips.md` (tags
  `guides`) → 8 published posts, 3 tags: `guides` (3), `reference` (3),
  `showcase` (2).
- Hidden-post demos: `site/content/posts/draft-in-progress.md`
  (`draft: true`) and `site/content/posts/next-year.md`
  (`date: 2999-12-31`) — present in content, absent from `site/dist/`.
- Pages: `site/content/index.md` (paginated home list) plus exactly two
  static pages `site/content/about.md` and `site/content/projects.md`.
- `site/public/`: `images/dot.png` — one 1×1 PNG placeholder (~70 bytes),
  referenced from a post as `![dot](/images/dot.png)` (proves T011
  passthrough → `site/dist/images/dot.png`); plus a minimal
  `styles.css` for readability (a few dozen lines, no framework).
- `site/templates/`: `base.html` (head with
  `<link rel="alternate" type="application/atom+xml" href="/feed.xml">`;
  nav includes the T023 search partial via `{% include "search.html" %}`
  — resolved through T009's partial auto-load), `post.html` (renders TOC
  from the TOC data, reading time, tag links, related-posts list),
  `index.html` (post cards with excerpt + date + reading time, pagination
  prev/next nav from the pagination data).

### Visible feature proof (all 11 W3 features, observable in `site/dist/`)

1. **Publish (T013)** — draft + future posts in content, zero bytes of
   them anywhere in `site/dist/`.
2. **Taxonomy (T014)** — `dist/tags/guides/`, `dist/tags/reference/`,
   `dist/tags/showcase/` exist; posts link to them.
3. **Highlighting (T016)** — `hljs` spans in `syntax-highlighting-tour`.
4. **TOC (T017)** — TOC nav on that post; every TOC `#anchor` has a
   matching heading `id` in the page.
5. **Feed (T018)** — `dist/feed.xml` + the head `<link rel="alternate">`.
6. **Sitemap (T019)** — `dist/sitemap.xml`; every `<loc>` resolves inside
   `dist/`.
7. **Excerpt (T020)** — home cards show excerpt prose (no raw markdown).
8. **Reading time (T021)** — post layout renders reading time/word count.
9. **Related (T022)** — related-posts list with ≥ 1 entry on
   `syntax-highlighting-tour` (shares tags with others).
10. **Search (T023)** — search input + results container on every page,
    `dist/search-index.json` containing the 8 post URLs and none of the
    hidden slugs.
11. **Pagination (T015)** — 8 posts / `pageSize: 3` → 3 list pages;
    prev/next nav on the home list, and the "next" target exists in
    `dist/`.

### Build command (canonical, used identically by T035 + T036)

- `cd site && node ../src/cli.ts build` → exits 0, emits `site/dist/`.
  This exact string appears in this ticket, the README quickstart (T035),
  and the CI workflow (T036) — no `--config` flag variant anywhere.
- Dev: `cd site && node ../src/cli.ts serve` for browsing the result.

## Acceptance criteria

- [ ] `cd site && node ../src/cli.ts build` exits 0;
      `site/dist/index.html` exists.
- [ ] `find site/dist/posts -name index.html | wc -l` → `8`;
      `site/dist/tags/{guides,reference,showcase}/index.html`,
      `site/dist/about/index.html`, `site/dist/projects/index.html` exist.
- [ ] `grep -rE 'draft-in-progress|next-year' site/dist/` → no output;
      `cmp site/public/images/dot.png site/dist/images/dot.png` → no
      output (byte-identical passthrough).
- [ ] `site/dist/feed.xml`, `site/dist/sitemap.xml`,
      `site/dist/search-index.json` exist; sitemap `<loc>`s all resolve
      inside `dist/`; search index JSON parses and contains
      `/posts/hello-kiln/` but no hidden slug.
- [ ] Home renders 3 pagination pages' worth of nav — the "next" link on
      `index.html` resolves to an emitted page; excerpt text visible on
      cards.
- [ ] On `syntax-highlighting-tour/index.html`: `hljs` spans present, TOC
      anchors all match in-page heading ids, reading-time text present,
      related-posts section has ≥ 1 link.
- [ ] Search partial rendered on pages (`data-index` attribute present in
      `index.html`).
- [ ] README quickstart (T035) documents exactly this build command
      (string-identical), and it is what T036's CI runs.
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
(cd site && node ../src/cli.ts build)                  # exit 0
ls site/dist/index.html site/dist/feed.xml site/dist/sitemap.xml site/dist/search-index.json   # all exist
find site/dist/posts -name index.html | wc -l           # → 8
grep -rE 'draft-in-progress|next-year' site/dist/       # expected: no output
cmp site/public/images/dot.png site/dist/images/dot.png # no output = byte-identical
grep -c 'hljs-' site/dist/posts/syntax-highlighting-tour/index.html   # ≥ 1
node -e "const i=require('./site/dist/search-index.json'); if(!i.some(e=>e.url==='/posts/hello-kiln/')) process.exit(1)"  # exit 0
```

TOC anchor matching, pagination nav targets, excerpt/reading-time/related
markup are verified by inspecting the built pages listed above (they are
rendered by this ticket's own templates, so the built HTML is the proof).

## Non-goals

- No W5 features in the demo config (`features.minify`,
  `features.linkCheck` — their tickets land in the same batch; the demo
  ships configured for W3 only).
- No deployment config (no CNAME, Netlify/gh-pages settings), no custom
  domain, no analytics, no comments system, no CMS/import pipeline.
- No i18n, multi-author, or themed variants; no bespoke design system or
  CSS framework — clean minimal templates only.
- No client-side JavaScript beyond the features' shipped assets
  (`assets/search.js`); no tests for site content itself (T033 owns the
  golden suite, T036 builds this site in CI).
- No README or docs edits (T035); no content beyond the listed posts and
  pages.
