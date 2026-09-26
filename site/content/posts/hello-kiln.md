---
title: Hello, Kiln
date: 2025-11-02
tags: [guides]
---

Kiln turns a folder of Markdown into a static website. This post is the
first of the example content: it carries a TypeScript code sample, links
to the little image asset the site ships with, and shows up on the home
list with an excerpt, a date, and a reading time.

## Why a static site?

Static output is easy to host, cheap to scale, and has no database to
break at 3 a.m. You write Markdown, run one command, and upload the
resulting `dist/` folder anywhere that can serve files.

## Your first build

From the repository root, the canonical command is:

```ts
// One process: load config, discover content, run features, emit dist/.
const { exitCode } = await build({ cwd: "site" });
console.log(`kiln build finished with ${exitCode}`);
```

Run it and Kiln prints a report of every page it emitted. The image below
is a one-pixel PNG served straight from `public/`:

![dot](/images/dot.png)

## What to read next

If you are new to Markdown itself, start with *Writing Markdown*; if you
are curious about metadata, read *Frontmatter Fields*.
