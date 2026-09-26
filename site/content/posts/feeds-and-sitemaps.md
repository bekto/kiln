---
title: Feeds and Sitemaps
date: 2026-06-18
tags: [reference]
---

Two machine-readable outputs ship with every build: an Atom feed at
`/feed.xml` and a sitemap at `/sitemap.xml`. Both are generated from the
published posts, so a draft or a future-dated post can never leak into
either.

## The Atom feed

The feed lists the newest posts — capped by `features.feed.limit`, which
this site sets to 10 — with absolute URLs derived from `site.url`. Every
page also advertises it from the document head:

```html
<link rel="alternate" type="application/atom+xml" href="/feed.xml">
```

Point a reader at the feed URL, or let them discover it automatically;
both work because the link tag is in the template, not hand-written per
page.

## The sitemap

`sitemap.xml` enumerates every emitted URL: the home list and its
overflow pages, each post, each static page, and every tag archive. The
crawler that reads it maps each `<loc>` straight back to a file inside
`dist/`.

## Why absolute URLs matter

Feeds and sitemaps are consumed off-site, so relative URLs are
meaningless there. Kiln rejects a build whose `site.url` is not an
absolute `http(s)` origin — the example site sets
`https://example.com` in `kiln.config.ts`.
