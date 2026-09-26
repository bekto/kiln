# Templates

Kiln renders pages with nunjucks. This page covers the templates
directory, how a layout is chosen, the data every layout sees, the
layouts shipped with the package, and the opt-in search partial.

## Templates directory

- Layouts live in `templatesDir` (default `templates/`); partials live in
  `templates/partials/` and are on the loader's search path. Reference
  layouts by path (`{% extends "post.html" %}`) and partials either by
  bare name (`{% include "header.html" %}` →
  `templates/partials/header.html`) or prefixed path
  (`partials/header.html`).
- **Strict by construction:** `autoescape` is on (interpolated values are
  escaped) and `throwOnUndefined` is on — a typo like `{{ titel }}` is a
  render error naming the template, line, and variable, never silent
  output. A missing include reports the directories that were searched.
- Templates are re-read on **every render**, so a layout edit shows up on
  the next watch-mode rebuild without restarting the server.
- The Markdown body is rendered first (GFM: tables, `~~strikethrough~~`,
  fenced code; raw HTML in Markdown is escaped; bare URLs autolink;
  relative `.md` links are rewritten to their pretty URL), and the result
  is inserted with `{{ content | safe }}`.
- A `date` filter formats a `Date` as `YYYY-MM-DD`:
  `{{ page.date | date }}`.

## Layout selection

- Frontmatter `layout` picks the template: `layout: post` and
  `layout: post.html` are the same file. Absent → `post.html`.
  A non-string `layout` fails the build naming the file.
- Layouts compose with nunjucks inheritance: `post.html` and `index.html`
  both `{% extends "base.html" %}` and fill its `head` and `content`
  blocks.
- **Injection slots** keep shared layouts untouched: a document's
  `page.injectHead` and `page.injectBody` are arrays of partial names
  included in `<head>` and after the content block. Features use them
  (table of contents, pagination nav, the draft `noindex` tag), so you
  never edit `base.html` to add one — put a partial in
  `templates/partials/` and reference it.

## View data

Every layout render receives exactly these top-level names (`page`,
`site`, and `content` always win and cannot be shadowed by feature
extras):

| Name | What it is |
| --- | --- |
| `page` | This document: all frontmatter keys plus `url` (its pretty URL, e.g. `/posts/hi/`) and `path` (absolute source path) — those two win over same-named frontmatter. |
| `site` | Site metadata from config (`site.title`, `site.url`, `site.description` when set) plus `pages` — every visible page as a view — and feature-published keys such as `searchIndexPath`. |
| `content` | The rendered HTML of this document's Markdown body — insert with `\| safe`. |
| `collections` | `{ posts, pages }` — both collections, newest first (see [content model](content.md#collections-and-ordering)). |
| `flags` | `{ drafts, future, noCache }` — the flags this build ran with. |

Feature-provided fields ride on `page` (they are frontmatter-level data)
— `page.excerpt`, `page.words`, `page.readingTime`, `page.toc`,
`page.related`, and — on list documents — `page.posts` plus
`page.pagination` (`{ page, totalPages, prevUrl?, nextUrl? }`). See
[features](features.md).

## Default layouts

Three layouts ship with the package (copy them into your project's
`templates/` to customize — project files win):

- **`base.html`** — doctype, `<head>` (with the `head` block and
  `injectHead` partials), `content` block, and `injectBody` partials
  after it.
- **`post.html`** — an `<article>` with title, `date`, and
  `{{ content | safe }}`.
- **`index.html`** — an `<h1>` and a list of every page in `site.pages`.

Bundled partials: `toc.html`, `pagination.html`, `taxonomy-list.html`,
`publish-meta.html`, `search.html`, `live-reload.html` (dev server), and
`feed.xml` (rendered by the feed feature).

## Opt-in search partial

Client search renders nothing until you include it — place

```nunjucks
{% include "search.html" %}
```

anywhere (a layout, a header partial) and the page gets a search input,
results list, and the deferred `/assets/search.js` script. The input's
`data-index` attribute carries `site.searchIndexPath` (published by the
search feature; default `/search-index.json`), so a build without the
feature still renders a usable partial pointing at the default path.
Details: [client-side search](features.md#client-side-search).
