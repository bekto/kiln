---
title: Writing Markdown
date: 2025-12-15
tags: [guides, reference]
---

Markdown is the input format for every page on this site. This post walks
through the constructs the example content actually uses — headings,
lists, tables, strikethrough, and fenced code — so you can see how each
one renders before you write your own pages.

## Tables, strikethrough, and friends

Kiln's renderer understands GitHub-flavored Markdown. You can ~~cross out
old ideas~~ while keeping them readable in the source, and lay data out
in a table:

| Construct      | Syntax                  | Renders as        |
| -------------- | ----------------------- | ----------------- |
| Bold           | `**text**`              | **text**          |
| Strikethrough  | `~~text~~`              | ~~text~~          |
| Code span      | `` `code` ``            | `code`            |

## Shell sessions in fences

Bash commands belong in a fenced block with the `bash` info string, which
the highlighter picks up:

```bash
cd site && node ../src/cli.ts build   # bake the example site
cd site && node ../src/cli.ts serve   # browse it locally
```

## A checklist for new posts

1. Give every post a distinct, past `date`.
2. Tag it so it lands in a tag archive.
3. Open with a prose paragraph — it becomes the home-page excerpt.
