# Kiln

![CI](https://github.com/bekto/kiln/actions/workflows/ci.yml/badge.svg) ![npm](https://img.shields.io/npm/v/kiln.svg)

A static site generator that bakes Markdown into fast websites.

Kiln takes Markdown content + Nunjucks templates and emits plain,
dependency-free HTML — with a dev server, live reload, and content-hash
incremental builds while you write. No framework runtime, no hosted vendor:
the whole pipeline is strict TypeScript you can read, test, and extend by
dropping in a single feature file.

```console
$ kiln build          # content/ + templates/ + public/  →  dist/
$ kiln serve          # build, serve, live-reload on save
$ kiln new "My post"  # scaffold a post with valid frontmatter
```

## Setup

**Requirements:** Node.js **≥ 24** (Kiln runs TypeScript natively — there is
no build step) and npm.

```console
$ git clone <repo> && cd <repo>
$ npm install                                  # toolchain + runtime deps
$ cd site && node ../src/cli.ts build          # → site/dist/ (18 demo pages)
$ node ../src/cli.ts serve                     # http://localhost:4173 + live reload
```

Inside this repository the CLI is always `node src/cli.ts <command>` (the
`kiln <command>` spelling in the docs is the same program). In this
repository every example in these docs writes the command as
`kiln <command>`.

**Start your own site:** copy `site/` as a working starting point, or build
an empty one: a `kiln.config.ts` that default-exports a plain object (or no
file at all — pure defaults), a `content/` directory of `.md` files, the
three layouts from `templates/`, and an optional `public/` for static files.
Full guides: [docs/content.md](docs/content.md),
[docs/templates.md](docs/templates.md),
[configuration reference](#configuration-reference).

## Uninstall

Kiln is fully self-contained — nothing global, no dotfiles, no system
packages, no background services.

```console
$ rm -rf <repo>                  # that's the project gone
$ npm cache clean --force        # optional: npm's shared download cache
$ rm -f kiln-*.tgz               # only if you ran `npm pack`
```

Two notes:

- There is no global bin to remove: `npm install -g kiln` does **not** work
  on Node 24 (Node refuses to type-strip `.ts` files inside `node_modules`,
  [nodejs/node#57215](https://github.com/nodejs/node/issues/57215)) — Kiln
  runs from source today.
- Your generated site is just static files: `kiln clean` deletes the output
  (`dist/`), and whatever host you put it on keeps working until you remove
  the files there.

## Hosting (easy mode)

The output of `kiln build` is plain files in `dist/` — no server, no
runtime, no database. Any static host works.

1. **Set `site.url`** in `kiln.config.ts` to your production URL first —
   the feed and sitemap resolve every link against it.
2. **Easiest (drag-and-drop):** build locally
   (`cd site && node ../src/cli.ts build`), then drop the `site/dist`
   folder onto a host's upload page (e.g. Netlify Drop, Cloudflare Pages
   dashboard).
3. **Git-connected:** point Netlify / Vercel / Cloudflare Pages at your
   repo with build command
   `npm install && cd site && node ../src/cli.ts build` and publish
   directory `site/dist`.
4. **GitHub Pages:** [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
   already runs the full test suite, builds the example site, and uploads
   `site/dist` as a workflow artifact — add a Pages deploy step
   (`upload-pages-artifact` + `deploy-pages`) when you're ready.
5. **Your own server:** copy `dist/` to any web root
   (`root /var/www/site;` in nginx, an S3 bucket, shared hosting).

`kiln serve` is a **dev** server (live reload, no hardening) — never expose
it publicly; host the built files instead.

## What's good

| Strength | What it means in practice |
| --- | --- |
| **Zero-JS pages** | Output is HTML + CSS. The only client script is optional search (and the dev-only reload injector). Pages work with JS off and load instantly — good for SEO and readers on bad networks. |
| **Batteries included** | Feed, sitemap, tag/category archives, pagination, TOC + anchors, syntax highlighting, excerpts, reading time, related posts, client-side search, link checker, minifier, drafts/scheduling — all on by default (or one config key away). Most SSGs make you assemble this from plugins. |
| **One-file extensions** | A feature is `src/features/x.ts` exporting up to four hooks, auto-discovered — no plugin registry, no config wiring. `features` config and frontmatter `data` are open maps, so your feature never collides with core or another feature's schema. |
| **Fast dev loop** | ~250 ms cold build, **0 ms warm** (18/18 pages served from the content-hash cache), 100 ms debounce, SSE live reload. Edits feel instant. |
| **Engineered, not hacked** | 396 tests including byte-level golden snapshots of a full site, strict `tsc` with erasable-syntax enforcement, CI, and aggregated `file:line` build errors that don't stop at the first failure. |
| **You own it** | Content lives in git as markdown; the generator is a dependency you can read in an afternoon. No vendor, no fees, no lock-in, no API deprecations. |

What it isn't: not a component framework (no React/Vue islands), not tuned
for 10k-page publications, not a hosted service with a GUI editor. If you
need those, use them.

## How it compares

| vs | Where they win | Where Kiln wins |
| --- | --- | --- |
| **[Hugo](https://gohugo.io)** | Raw build speed at huge scale, maturity, theme ecosystem | Hackable for TypeScript devs; typed config and typed feature hooks (Go templates are untyped) |
| **[Eleventy](https://11ty.dev)** | Maturity, 10+ template languages, plugin breadth | Batteries-included vs plugin assembly; one unified hook contract instead of per-integration wiring |
| **[Astro](https://astro.build)** / Next.js | Real interactivity — component islands, hydration | Strict zero-framework output; nothing to hydrate, nothing to break |
| **[Jekyll](https://jekyllrb.com)** | GitHub Pages native support, Ruby ecosystem | No Ruby toolchain; runs anywhere Node ≥ 24 exists |
| **Medium / Wix / Squarespace** | GUI editor, hosting, zero setup | Content-in-git, versionable, free to host — but *you* write the markdown |

**Bottom line:** Kiln is a batteries-inclusive, zero-JS, source-first SSG —
defensible when you want content in git and a codebase you can actually
read and extend. It is not a Hugo killer; if you need massive-scale builds
or a component ecosystem, pick those instead.

## Configuration reference

Project configuration lives in `kiln.config.ts` in the project root — the
directory you run the CLI from, and the only directory searched. The file
**default-exports a plain object**; no file means pure defaults, an invalid
known key fails the build with a `kiln.config.ts:`-prefixed error naming the
key, and unknown top-level keys are ignored. Directory values resolve
against the project root (absolute values are kept).

### Base keys

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `contentDir` | string | `content` | Markdown source directory, walked recursively. |
| `templatesDir` | string | `templates` | Nunjucks layouts; `templates/partials/` is searched automatically. |
| `publicDir` | string | `public` | Static files copied verbatim into the output. |
| `outDir` | string | `dist` | Build output directory; `kiln clean` removes exactly this. |
| `site.title` | string | `Kiln site` | Site title, available to templates as `site.title`. |
| `site.url` | string | `http://localhost:8080` | Absolute base URL for feed and sitemap links — must be an absolute `http(s)://` URL with a host or the feed build fails. |
| `site.description` | string | *(unset)* | Optional site description, available to templates as `site.description`. |
| `port` | number | `4173` | Dev-server port for `kiln serve`; the `--port` flag overrides it per run. |
| `watch.debounceMs` | number | `100` | Watcher window (ms) within which save events coalesce into one rebuild. |
| `assets.hashBust` | boolean | `false` | Copy assets as `name.<8-hex-content-hash>.ext` and rewrite `src`/`href` references in emitted HTML. |
| `features` | object | `{}` | Open map of per-feature settings — stored verbatim, each feature validates its own slice (feature modules are auto-discovered from `src/features/*.ts` by `src/pipeline/features.ts`). |

### Feature keys (`features.*`)

Every feature validates only its own slice of `features`; a bad value fails
the build with an error naming the full key path.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `features.highlight.theme` | string | `github-dark` | Bundled highlight.js style emitted as `dist/assets/hljs.css`. |
| `features.toc.depth` | number | `3` | Maximum heading level shown in the table of contents; valid values are 2–3 (anchors are still assigned deeper). |
| `features.feed.limit` | number | `20` | Maximum entries in the Atom feed, newest first. |
| `features.pagination.pageSize` | number | `10` | Posts per list page — the home page and every tag/category archive. |
| `features.excerpt.length` | number | `260` | Excerpt cap in Unicode code points (cut at the last whitespace, `…` appended). |
| `features.readingTime.wordsPerMinute` | number | `200` | Reading-speed divisor for the `readingTime` estimate. |
| `features.related.limit` | number | `5` | Number of related posts attached to each post. |
| `features.search.indexPath` | string | `search-index.json` | Search-index file, relative to `dist/` (never absolute, never `..`). |
| `features.minify` | object | *(disabled)* | Enabling key: setting it to an object turns HTML minification on for the whole build. |
| `features.minify.collapseWhitespace` | boolean | `true` | Collapse inter-tag whitespace (applies once `features.minify` is enabled). |
| `features.minify.removeComments` | boolean | `true` | Strip HTML comments (applies once `features.minify` is enabled). |
| `features.minify.minifyCSS` | boolean | `false` | Also minify inline `<style>` contents. |
| `features.minify.minifyJS` | boolean | `false` | Also minify inline `<script>` contents. |
| `features.linkCheck.allow` | string[] | `[]` | Globs matched against a would-be-broken resolved target URL; a match excuses the link. |
| `features.linkCheck.exclude` | string[] | `[]` | Globs matched against the raw href or the source page URL; a match skips the link entirely. |
| _(no keys)_ | — | — | **publish, taxonomy, sitemap** define no config keys: publishing is gated by the `--drafts`/`--future` flags, taxonomy and sitemap are always on. |

## CLI reference

Exit codes, for every command: **0** success, **1** failure (bad config,
broken templates, feature failures, I/O errors), **2** usage error (unknown
command, unknown flag, missing or invalid argument — the build never runs).
Running `kiln` with no command, or `kiln help`, prints the command list.

### `kiln build`

```text
usage: kiln build [--drafts] [--future] [--no-cache]
```

- **Arguments:** none. Any positional token or unknown flag is a usage
  error (exit 2).
- **Flags:**
  - `--drafts` — include documents with `draft: true`.
  - `--future` — include posts dated later than the build start time.
  - `--no-cache` — ignore the incremental build cache and re-render every
    page.
- **Example:** `kiln build --drafts --future`
- **Exit:** 0 on success; 1 when any stage or feature fails (the report
  still prints).

### `kiln clean`

```text
usage: kiln clean [--dry-run]
```

- **Arguments:** none (unknown flags are a usage error, exit 2).
- **Flags:**
  - `--dry-run` — list what would be removed, delete nothing.
- **Example:** `kiln clean --dry-run`
- **Exit:** 0 on success (a missing output directory is a success no-op);
  1 when a safety guard refuses the target — the project root, the
  filesystem root, or anything outside the project tree (nothing is ever
  deleted in that case).

### `kiln help`

```text
usage: kiln help
```

- **Arguments:** none (extra tokens are ignored).
- **Flags:** none.
- **Example:** `kiln help`
- **Exit:** 0.

### `kiln new`

```text
usage: kiln new <title> [--dir <pages|posts>]
```

- **Arguments:** `<title>` — required; every non-flag token is joined with
  spaces into the title.
- **Flags:**
  - `--dir <pages|posts>` — target collection; default `posts`. Any other
    value is a usage error (exit 2).
- **Example:** `kiln new "Hello world"` or
  `kiln new About this site --dir pages`
- **Exit:** 0 on success — creates `content/posts/<slug>.md` (or under
  `content/pages/`) with `title`, an ISO 8601 `date`, and `draft: true`;
  1 if the file already exists (never clobbered); 2 on usage errors.

### `kiln serve`

```text
usage: kiln serve [--port <n>]
```

- **Arguments:** none (unknown flags are a usage error, exit 2).
- **Flags:**
  - `--port <n>` — listen port, an integer in 1–65535; overrides the
    `port` config key (`4173`) for this run.
- **Example:** `kiln serve --port 8080`
- **Exit:** 0 when the server stops cleanly; 1 when no built site exists
  (`run kiln build first`), the port is in use, or the server fails;
  2 on usage errors. On start it also watches for changes with SSE live
  reload — see [docs/dev-loop.md](docs/dev-loop.md).

### `kiln version`

```text
usage: kiln version
```

- **Arguments:** none (extra tokens are ignored).
- **Flags:** none.
- **Example:** `kiln version` → `kiln <version>` (from `package.json`).
- **Exit:** 0.

## Features

Each feature has a prose guide with its config key and default in
[docs/features.md](docs/features.md):

- **Publishing** — drafts and future-dated posts hidden unless
  [`--drafts`](docs/cli.md#kiln-build)/[`--future`](docs/cli.md#kiln-build)
  say otherwise: [docs/features.md#publishing-and-visibility](docs/features.md#publishing-and-visibility)
- **Taxonomy archives** — `/tags/…` and `/categories/…` pages plus index
  pages: [docs/features.md#taxonomy-archives-tags-and-categories](docs/features.md#taxonomy-archives-tags-and-categories)
- **Pagination** — home and archive lists split into pages:
  [docs/features.md#pagination](docs/features.md#pagination)
- **Heading anchors & TOC** — linked headings and a depth-limited table of
  contents: [docs/features.md#heading-anchors-and-table-of-contents](docs/features.md#heading-anchors-and-table-of-contents)
- **Atom feed** — `/feed.xml`, absolute URLs from `site.url`:
  [docs/features.md#atom-feed](docs/features.md#atom-feed)
- **Sitemap** — `/sitemap.xml` with `lastmod`:
  [docs/features.md#sitemap](docs/features.md#sitemap)
- **Excerpts** — one-line plain-text summaries:
  [docs/features.md#excerpts](docs/features.md#excerpts)
- **Reading time** — word count and minutes on every document:
  [docs/features.md#reading-time](docs/features.md#reading-time)
- **Related posts** — tag-overlap ranking:
  [docs/features.md#related-posts](docs/features.md#related-posts)
- **Client-side search** — build-time index plus no-dependency browser
  matcher: [docs/features.md#client-side-search](docs/features.md#client-side-search)
- **Syntax highlighting** — highlight.js styles and language labels:
  [docs/features.md#syntax-highlighting](docs/features.md#syntax-highlighting)
- **HTML minification** — opt-in, `<pre>`/`<code>` byte-preserving:
  [docs/features.md#html-minification](docs/features.md#html-minification)
- **Internal link checker** — offline broken-link and anchor detection:
  [docs/features.md#internal-link-checker](docs/features.md#internal-link-checker)

More guides: [content model](docs/content.md),
[templates](docs/templates.md), [CLI in detail](docs/cli.md),
[dev loop](docs/dev-loop.md), [architecture](docs/architecture.md).

## Development

- `npm run typecheck` — strict `tsc --noEmit`.
- `npm test` — typecheck, then `node --test --test-concurrency=1`
  (serialized because probe tests mutate `src/features/`).
- Architecture and extension seams:
  [docs/architecture.md](docs/architecture.md).
- Ticket and ownership history (source of truth):
  [PLAN.md](PLAN.md).
