---
title: Search Tips
date: 2026-07-25
tags: [guides]
---

The search box in the site header is client-side: Kiln builds a JSON
index of every published page at `dist/search-index.json`, ships a tiny
script alongside it, and the browser does the filtering. No server, no
service, no tracking.

## How the index is built

Each entry carries a title, the page URL, a plain-text excerpt, and the
post's tags. Because the index is generated after the publish filter,
drafts and future posts are absent from it — you cannot find what was
never shipped.

## Getting good results

- Search for whole words: `frontmatter`, `sitemap`, `highlighting`.
- Tags are part of the index, so `showcase` surfaces the showcase posts.
- Results update as you type; the empty state tells you when nothing
  matched.

## What it will not do

The demo script has no fuzzy matching and no stemming — it favors
predictability over cleverness. For a site of this size, that is plenty.
