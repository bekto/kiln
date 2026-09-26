---
title: Frontmatter Fields
date: 2026-01-20
tags: [reference]
---

Frontmatter is the YAML block between `---` fences at the top of a
Markdown file. It is where a document declares the metadata that the rest
of the pipeline consumes — and every feature reads only the fields it
owns.

## The fields this site uses

```yaml
---
title: Frontmatter Fields   # shown in <title>, lists, and the feed
date: 2026-01-20            # ordering, archives, scheduling
tags: [reference]           # tag archives and related-post scoring
draft: true                 # hides a post unless --drafts is passed
layout: index               # which template renders the document
---
```

## What happens to it

- The parser validates that the block is a YAML mapping and that `date`
  is a real date; anything else is left alone for features to check.
- `tags` must be a list of non-empty strings — an empty tag fails the
  build with a message naming the file.
- `layout` chooses the template; when it is absent, posts render through
  the default post layout.

## Defaults you rarely touch

Directory names (`content/`, `templates/`, `public/`, `dist/`) live in
`kiln.config.ts` and stay at their defaults here, so the whole site
resolves relative to its own folder.
