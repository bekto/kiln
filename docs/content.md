# Content model

Everything under `contentDir` (default `content/`) is Markdown. This page
covers the frontmatter fields Kiln understands, how files are discovered,
how source paths become URLs, how posts and pages are organized, and how
drafts and future-dated posts are hidden.

## Frontmatter model

A document is optional YAML frontmatter between `---` fences, then a
Markdown body:

```markdown
---
title: Hello world
date: 2026-09-26
tags: [news, release]
category: general
---

Body starts here.
```

- **Open `data`** — frontmatter is parsed into an open
  `Record<string, unknown>`; Kiln never validates unknown fields, and
  features read (and may write) their own keys. Invalid YAML, a
  sequence/scalar instead of a mapping, or an unparseable date fails the
  build with an error naming the file and line.
- **Dates** — `date` accepts an ISO 8601 string or a YAML timestamp and
  is normalized to a `Date` at parse time (date-only strings parse as
  UTC). Absent `date` stays absent — such posts sort as oldest. An
  invalid value fails the build with `"date" must be a valid date`.
- **`draft`** — boolean; `draft: true` marks the document as a draft
  (hidden unless `--drafts`).
- **`tags`** — an array of strings; matching is exact and
  case-sensitive after trimming whitespace from both sides. A non-array
  value or an empty/non-string tag fails the build.
- **`category`** — a single string (not an array); empty or non-string
  values fail the build.
- **`collection`** — `"posts"` or `"pages"` when present; anything else
  fails the build. When absent it is stamped from the path (see below).
- **`layout`, `permalink`, `title`, …** — layout and URL selection are
  covered in [Slugs and permalinks](#slugs-and-permalinks) and
  [templates](templates.md).

## Discovery rules

- The content directory must exist, be a directory, and be readable —
  otherwise the build fails with `content directory not found`.
- Every file matching `.md`/`.markdown` (case-insensitive) under
  `contentDir` is a document, at any depth.
- **Excluded segments:** any path segment — relative to `contentDir` —
  starting with `.` or `_` is never content. Put partials, fixtures, or
  scratch files under a `_drafts/` or `.hidden/` folder and they will be
  skipped.
- Only regular files are considered; symlinks get no special handling.
- Pages are emitted in **sorted order** — ascending by source path in
  Unicode codepoint order — so two runs over the same tree are
  byte-for-byte reproducible.
- Zero Markdown files under `contentDir` fails the build
  (`no markdown files found under …`).

## Slugs and permalinks

**Slugs are unicode-safe**: NFC-normalized and lowercased; whitespace and
`_` runs become a single `-`; letters and numbers of any script survive;
all other characters are dropped; `-` runs collapse and the ends are
trimmed. Punctuation-only input falls back to `untitled`.

**Default URLs** come from the source path: the extension is dropped,
each segment is slugified, and a trailing `index` collapses into its
directory. The result always starts and ends with `/`, and every pretty
URL emits as a directory with an `index.html`:

| Source | URL | Output |
| --- | --- | --- |
| `content/index.md` | `/` | `dist/index.html` |
| `content/posts/hello-world.md` | `/posts/hello-world/` | `dist/posts/hello-world/index.html` |
| `content/about/index.md` | `/about/` | `dist/about/index.html` |

**Permalink templates** — a string `permalink` frontmatter key overrides
the mapping. Placeholders: `:slug` (from the source filename), `:year`,
`:month`, `:day` (UTC, so output never depends on the build machine's
timezone). A `:word` placeholder that is not one of these fails the
build, as does a date placeholder on a document with no `date`.

## Collections and ordering

Every page belongs to exactly one collection:

- `collection: posts` or the `posts/` directory prefix → **posts**
  (blog-style entries: home list, feed, pagination, related posts).
- `collection: pages` or anything else → **pages** (about, colophon,
  feature-appended archives).

Both collections are sorted **newest first** by `date`, with ties broken
by ascending source path — fully deterministic whatever order discovery
produced. A missing date counts as oldest. Posts and pages are exposed to
templates as `collections.posts` / `collections.pages`
(see [templates](templates.md#view-data)).

## Drafts and scheduled publishing

The publish feature hides documents from the whole build — pages,
collections, taxonomy archives, feed, search — unless a flag says
otherwise (see [`kiln build`](cli.md#kiln-build)):

- `draft: true` → hidden unless `--drafts`.
- `date` later than the build start time (UTC) → hidden unless
  `--future`.

Hidden documents are removed before collections are computed, so nothing
downstream can accidentally list them. Drafts that *are* emitted under
`--drafts` still get a `<meta name="robots" content="noindex">` tag
through the base layout. Every document gets its resolved visibility as
the boolean frontmatter-level field `published`. The flag-driven details
are in [publishing and visibility](features.md#publishing-and-visibility);
the `kiln new` scaffolder always creates `draft: true`.
