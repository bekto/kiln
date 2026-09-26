---
title: Syntax Highlighting Tour
date: 2026-05-12
tags: [showcase]
---

A long-form tour of Kiln's build-time syntax highlighting. Everything on
this page was highlighted **while the site was built** — there is no
client-side highlighting library, just spans baked into the HTML. The
tour doubles as the demo page for the table of contents above the
article and for the related-posts list at the bottom.

## Why highlight at build time?

Shipping a highlighting library to the browser means every visitor pays
for it: more JavaScript, more CSS, and a flash of unstyled code before
the library runs. Kiln resolves the fence's language at build time and
emits `<span class="hljs-…">` token markup once, so readers get colored
code from the first byte.

The trade-off is honest: highlighting is frozen at build time, and
changing the theme means rebuilding the site. For documentation and
blogs that is exactly the right trade.

## TypeScript fences

The info string's first word picks the language. A `ts` fence becomes a
labelled, highlighted block:

```ts
/** One build report line — what the CLI prints after emit. */
export interface EmittedPage {
  url: string;
  file: string;
}

export function summarize(pages: EmittedPage[]): string {
  const total = pages.length;
  const newest = pages.at(-1)?.url ?? "(none)";
  return `${total} pages, newest ${newest}`;
}
```

Unknown languages fall back to an escaped plain block, so a fence is
never blank and never crashes the render.

## CSS fences

Stylesheets get the same treatment:

```css
:root {
  --accent: #0969da;
}

.post-card h2 a {
  color: var(--text);
  text-decoration: none;
}

.post-card h2 a:hover {
  color: var(--accent);
}
```

## Token markup under the hood

Highlighted output is plain HTML with `hljs-` prefixed spans — the theme
in `dist/assets/hljs.css` styles the classes, and nothing else needs to
run. Grep the built page for `hljs-` and you will find dozens of hits.

### What gets a label

Any recognized language renders a small label above the block, taken
from the fence's info string.

### What falls back

A fence with no info string, or one naming a language Kiln does not
know, renders as escaped monospace text — still readable, just not
colored.

## Themes

The example site picks `github-dark` in `kiln.config.ts`. Swapping the
key to any bundled highlight.js style changes the emitted stylesheet
without touching a single template.

## Where this shows up elsewhere

Highlighted code appears across the example content — the build snippet
in *Hello, Kiln*, the shell sessions in *Writing Markdown*, and the
YAML block in *Frontmatter Fields* — so the tour is also a reminder
that good examples should be runnable.
