# Kiln — a static site generator that bakes Markdown into fast websites

**Status:** planned only — no code written. See `PLAN.md` for the execution plan
and `tickets/` for the 37 tickets.

## The idea

Kiln is a local-first static site generator CLI: Markdown content + Nunjucks
templates in, a dependency-free static HTML site out — with a dev server, live
reload, and incremental rebuilds while you write.

```console
$ kiln build          # content/ + templates/ + public/  →  dist/
$ kiln serve          # build, serve, live-reload on save
$ kiln new "My post"  # scaffold a post with valid frontmatter
```

## Planned features

- **Content**: Markdown (GFM tables, strikethrough, code fences), YAML
  frontmatter, drafts & scheduled (future-dated) publishing, unicode-safe slugs.
- **Structure**: collections (posts/pages), tag & category archives, pagination,
  pretty permalinks, static asset passthrough.
- **Rendering**: Nunjucks layouts & partials, syntax highlighting, heading
  anchors + table of contents, excerpts, reading time, related posts.
- **Syndication & SEO**: Atom/RSS feed, sitemap.xml, client-side search index.
- **Dev loop**: dev server, SSE live reload, file watcher, incremental rebuild
  with a content-hash build cache.
- **Quality**: precise file:line error reporting, internal link checker, HTML
  minification (opt-in), golden-site snapshot tests, CI, npm-publishable
  package.

## Why this app for 30–40 tickets

The core pipeline is a small serial spine (scaffold → config → content model →
render → emit → orchestrator), after which nearly every feature is an
independent, auto-discovered plugin file — ideal for parallel subagent waves
with hard file-ownership boundaries. Features plug into a fixed hook contract
(`extendMarkdown`, `onDocument`, `onSite`, `onBuildEnd`), so parallel tickets
never touch the same file.

## Stack (verified on this machine)

| Concern     | Choice                                                        |
| ----------- | ------------------------------------------------------------- |
| Runtime     | Node 24 (native TS type-stripping; `node src/cli.ts` runs)     |
| Language    | TypeScript, `tsc --noEmit` strict (`typescript@7`)             |
| Tests       | `node --test` on `.ts` files (probe passed)                    |
| Markdown    | `markdown-it@15` + plugins                                     |
| Frontmatter | `gray-matter@4`                                                |
| Templates   | `nunjucks@3`                                                   |
| Highlight   | `highlight.js@11`                                              |
| Minify      | `html-minifier-terser@7`                                       |
| Discovery   | built-in `fs.promises.glob()` (returns an async iterator)      |

All package names/versions verified against the npm registry; `import()` of a
local `.ts` config file verified working natively.
