# Features

Every feature is one auto-discovered module in `src/features/*.ts` wired
into the build through the [feature hook contract](architecture.md#feature-hooks).
This page is the prose guide: what each feature does, which config key it
owns, and its default. Configured through `kiln.config.ts` — see the
[configuration reference](../README.md#configuration-reference) for the
tables.

## Publishing and visibility

**No config keys** — publishing is flag-gated (T013). `draft: true`
documents are hidden unless the build runs with `--drafts`; documents
whose `date` is later than the build start time (UTC) are hidden unless
`--future` is set. Hidden documents are removed before collections,
archives, feed, and search are computed, so nothing downstream lists
them. Drafts that are emitted under `--drafts` still get a `noindex`
robots tag. Details: [content model](content.md#drafts-and-scheduled-publishing),
[`kiln build` flags](cli.md#kiln-build).

## Taxonomy archives (tags and categories)

**No config keys** — taxonomy is always on (T014). Frontmatter `tags`
(array of strings) and `category` (single string) drive archive pages:
`/tags/<slug>/` and `/categories/<slug>/` per term, plus `/tags/` and
`/categories/` index pages listing each term with its visible-post
count. Only visible posts participate (draft/future rules apply); terms
match exactly after trimming, slugs are unicode-safe, and rendered hrefs
are percent-encoded. Empty terms, non-string tags, two terms colliding
on one slug, or a term whose archive would be empty all fail the build
naming the document or terms. With pagination enabled, archives show
their first `pageSize` posts and overflow onto pagination pages.

## Pagination

`features.pagination.pageSize` — number, default `10` (positive integer;
`0`, negative, fractional, or non-number values fail the build naming the
key).

The home list and every tag/category archive are split into pages: page 1
keeps its canonical URL, overflow pages land at `/page/2/` … and
`/tags/<slug>/page/2/` …, with working prev/next navigation injected
through the body slot (a single-page list renders no nav at all). List
layouts read the sliced entries from `page.posts` and navigation state
from `page.pagination` (`{ page, totalPages, prevUrl?, nextUrl? }` —
`prevUrl` is absent on page 1 and `nextUrl` on the last page; page 2's
`prevUrl` is the canonical list URL, never `/page/1/`). Overflow pages
mirror the home document's layout and title. Single posts and static
pages are never paginated.

## Heading anchors and table of contents

`features.toc.depth` — number, default `3`, valid values 2–3 (anything
else fails the build naming the key).

Every Markdown heading gets a slugified, unicode-safe `id`, so headings
are linkable. The depth-limited table of contents — `{ level, text, id,
url }` entries — is available to layouts as `page.toc`. Anchors are
assigned at every heading depth; only the TOC list is filtered to
`level <= features.toc.depth`. When (and only when) the TOC is non-empty,
the `templates/partials/toc.html` partial is appended to the document's
body injection list, so it renders through `base.html`'s body slot
without touching shared layouts.

## Atom feed

`features.feed.limit` — number, default `20` (positive integer).

A valid Atom 1.0 document is written to `/feed.xml` on every build: one
entry per visible post, newest first, capped at `limit`, each carrying
the post's full rendered HTML content. Entries inherit visibility for
free — hidden drafts and future-dated posts are already gone by build
end, and `--drafts`/`--future` builds include them exactly as pages do.

**Requirement:** `site.url` must be an absolute `http(s)://` origin with
a host — every `<id>` and `<link>` is resolved against it, so missing,
empty, or relative values (`/blog`, `blog.example.com`, `//host`) fail
the build with an error naming `site.url`. A site with zero posts still
yields a valid empty feed. The feed is rendered through
`templates/partials/feed.xml`; a copy ships with the package and your
project's partial overrides it.

## Sitemap

**No config keys** (T019). `/sitemap.xml` gets one `<url>` entry per
HTML page emitted in this build — including cache-skipped pages that
still exist in `dist/` — with `<loc>` resolved to an absolute URL against
`site.url` (the same absolute-URL requirement as the feed) and `<lastmod>`
taken from the source page's frontmatter `date`. Non-HTML outputs
(`feed.xml`, the search index, assets) are never listed, hidden
drafts/future posts never reach it, and entries are sorted
lexicographically for byte-stable output.

## Excerpts

`features.excerpt.length` — number, default `260` (positive integer,
counted in Unicode code points).

Every document gets a one-line, plain-text summary — raw markup can never
leak into it — available as `page.excerpt` (and `doc.excerpt` for other
features). Precedence: a frontmatter `excerpt` string wins verbatim
(trimmed of surrounding whitespace only, never truncated, never given an
ellipsis); a non-string value fails the build naming the field and file.
Otherwise the first prose paragraph is flattened to text, cut at the last
whitespace at or before `features.excerpt.length`, and `…` is appended.
Empty document → `""`, never `undefined`. Listings, archives, the feed,
and the search index all reuse it.

## Reading time

`features.readingTime.wordsPerMinute` — number, default `200` (positive
integer).

Every document gets an integer word count `page.words` (Unicode
whitespace split, CJK-aware) and a conservative estimate
`page.readingTime` in minutes: `max(1, ceil(words / wordsPerMinute))`.
Both are computed before render, so templates and other features read
them with no client-side work. An invalid value fails the build naming
the key.

## Related posts

`features.related.limit` — number, default `5` (positive integer).

Every post gets `page.related`: up to `limit` entries of
`{ title, url, date }`. Scoring is pure tag overlap with other posts —
the candidate pool is the `posts` collection minus posts hidden by the
draft/future rules, a post is never related to itself, and untagged posts
simply score 0 everywhere. Ranking: score descending, then newest date,
then URL — fully deterministic. Render it as a list in your post layout;
no config beyond the limit.

## Client-side search

`features.search.indexPath` — string, default `search-index.json`
(relative to `dist/`; never absolute, never containing `..`, never
empty — the build fails naming the key otherwise).

On every build the feature writes one JSON entry per visible document —
exactly `{ title, url, excerpt, tags }`, plain text with HTML stripped —
to `dist/<indexPath>`, and copies its no-dependency matcher to
`dist/assets/search.js`. The UI is opt-in: include the partial as
documented in [templates](templates.md#opt-in-search-partial) and the
page gets an input, results list, and the script. Everything runs in the
browser: no server, no network beyond fetching your own index file.

## Syntax highlighting

`features.highlight.theme` — string, default `github-dark`.

Fenced code blocks are highlighted at render time through the
[markdown seam](architecture.md#markdown-seam) using highlight.js; the
theme names a bundled `highlight.js/styles/` style and is validated at
build start — an unknown theme or a non-string value fails the build
naming the key. When at least one block was highlighted, the theme's CSS
is emitted to `dist/assets/hljs.css` (and removed when a rebuild
highlights nothing), so highlighted blocks always carry their `hljs` /
`language-*` classes and token spans.

## HTML minification

`features.minify` — object; **disabled** (absent) by default. Setting it
to an object enables minification for the whole build; a non-object
value fails the build naming `features.minify`.

Once enabled, every `.html` file in the build output — freshly emitted or
carried over from the cache — is rewritten in place at build end:
collapsed whitespace and stripped comments by default, while `<pre>` and
`<code>` contents stay byte-for-byte identical, so indentation and
highlighted code survive. Keys (all optional booleans):

| Key | Default | Meaning |
| --- | --- | --- |
| `features.minify.collapseWhitespace` | `true` | Collapse inter-tag whitespace runs. |
| `features.minify.removeComments` | `true` | Remove HTML comments. |
| `features.minify.minifyCSS` | `false` | Also minify inline `<style>` contents. |
| `features.minify.minifyJS` | `false` | Also minify inline `<script>` contents. |

Canonical opt-in config:

```ts
// kiln.config.ts
export default {
  features: {
    minify: { collapseWhitespace: true, removeComments: true, minifyCSS: true },
  },
};
```

Non-HTML outputs (`feed.xml`, `sitemap.xml`, `search-index.json`,
`assets/**`) are never opened or rewritten, `<!doctype html>` is
preserved, and output is deterministic — identical input
→ byte-identical output. A non-boolean value fails the build naming the
exact key. Minification is per-build work: use `kiln clean` or a fresh
build when benchmarking sizes.

## Internal link checker

`features.linkCheck.allow` — string[], default `[]`.
`features.linkCheck.exclude` — string[], default `[]`.

After every build the emitted HTML is scanned — offline, no exceptions:
external URLs (`http(s)://`, protocol-relative, `mailto:`, `tel:`,
`javascript:`, `data:`) are never fetched. Raw-text regions (comments,
`<pre>`, `<code>`, `<script>`) are stripped first so escaped samples and
JS strings produce no phantom links. Then every internal `href`/`src`
is resolved against the containing page's emitted URL:

- the target file must exist in `dist/` (existence is case-sensitive);
- a `#fragment` on an HTML target must match an `id` (e.g. a heading
  anchor) or `<a name>` in that file; fragment-only links check the
  current page.

The scan always completes, then one aggregated error lists every broken
link as `source page → broken target (raw href)` and the build exits 1;
zero broken links means no output and exit 0. The two glob keys
(Node's built-in glob syntax):

- `features.linkCheck.allow` — globs matched against the **resolved
  target URL** of a would-be-broken link; a match excuses it (use case:
  `/admin/` served by the host, intentionally never emitted).
- `features.linkCheck.exclude` — globs matched against the **raw href or
  the source page URL**; a match skips that link entirely (never
  resolved, never checked).

Example: `allow: ['/sponsor/**', '/admin']`, `exclude: ['/legacy/**']`.
A non-array value or a non-string element fails the build naming the
exact key.
