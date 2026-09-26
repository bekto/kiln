---
title: Café Münster 日本語
date: 2026-03-30
tags: [showcase]
---

This post exists to prove that Kiln handles Unicode everywhere it
counts: the filename `café-münster-日本語.md` becomes the URL
`/posts/café-münster-日本語/`, the title keeps its accents and its
Japanese script, and the slug stays readable in both.

## A trip through three scripts

We started in **Café Münster** — flat whites and filter coffee — before
the rails carried us east. Somewhere between the second interchange and
the last stop, the announcements switched to 日本語, and the platform
signs began to blur together in the best possible way.

## What the pipeline does with it

- The filename is NFC-normalized and lowercased; letters from any script
  survive into the slug, punctuation is dropped.
- Emitted paths are percent-encoded only where HTTP requires it — the
  file on disk keeps its real name.

> Unicode is not an edge case. Half the web's authors write in scripts
> that are not ASCII, and a generator that mangles their filenames is
> simply broken.
