# Changelog

## [Unreleased]

## [0.1.0] - 2026-09-26

### Wave 0 — Foundation

- **T001 Repo scaffold** — npm package with strict TypeScript config plus `typecheck` and `test` scripts to keep it honest.
- **T002 CLI skeleton & command discovery** — the `kiln` CLI dispatches commands with automatic discovery of command modules, ships `help` and `version`, and reports failures through exit codes.
- **T003 Config loader** — loads the local `kiln.config.ts` with defaults and validation, exposing an open `features` options map.

### Wave 1 — Content model

- **T004 Frontmatter & Document model** — gray-matter frontmatter parsed into typed `Document`/`Page`/`Site` with an open `data` map, date handling, and precise parse errors.
- **T005 Slugs & URL helpers** — unicode-safe slugs, permalink templates, and path-to-URL mapping for pretty URLs.
- **T006 Markdown renderer** — markdown-it GFM rendering with an `extendMarkdown` seam features use to register plugins.

### Wave 2 — Build pipeline

- **T007 Content discovery** — recursively discovers `content/` with exclusion rules and feeds the `Site`.
- **T008 Collections & queries** — posts and pages collections sorted by date with tag and draft filters.
- **T009 Template engine & base layouts** — nunjucks environment with layout inheritance, partial auto-load, and default base/post/index layouts.
- **T010 Permalink emission** — renders each page to pretty-path `.html` files under `dist/`.
- **T011 Static asset passthrough** — copies `public/` into `dist/` with an optional hash-bust option.
- **T012 Build orchestrator, feature contract & report** — wires the pipeline stages, defines the auto-discovered `Feature` hooks, prints a build report, and powers `kiln build`.

### Wave 3 — Features

- **T013 Drafts & scheduled publishing** — hides drafts and future-dated posts unless `--drafts`/`--future` is passed.
- **T014 Tags & category archives** — generates tag and category index and archive pages.
- **T015 Pagination** — paginates home and archive lists with prev/next links and page URLs.
- **T016 Syntax highlighting** — highlight.js code highlighting via `extendMarkdown` with language labels.
- **T017 Heading anchors & TOC** — slugified heading IDs with table-of-contents data and a TOC partial.
- **T018 RSS/Atom feed** — a valid Atom feed at `/feed.xml` with full post content.
- **T019 Sitemap.xml** — `sitemap.xml` generated from emitted URLs with `lastmod` dates.
- **T020 Excerpts** — a frontmatter override or first-paragraph summary for every document.
- **T021 Reading time & word count** — word count and a conservative reading-time estimate on every document.
- **T022 Related posts** — tag-overlap scoring selects the top-N related posts for each post.
- **T023 Client-side search** — build-time `search-index.json`, a dependency-free in-browser matcher, and a search partial.

### Wave 4 — Developer experience

- **T024 kiln new** — scaffolds a new post with valid frontmatter and a slug-based filename.
- **T025 kiln clean** — removes `dist/` with a safety check.
- **T026 Dev server** — serves `dist/` statically with correct MIME types via `kiln serve`.
- **T027 Watcher & incremental rebuild** — watches `content/`, `templates/`, and `public/` with debounce and rebuild-on-change.
- **T028 Live reload (SSE)** — an SSE endpoint with an injected client so rebuilds reload the browser.
- **T029 Build cache** — a content-hash cache skips unchanged pages, with `--no-cache` to opt out.

### Wave 5 — Quality & release

- **T030 HTML minification** — opt-in output minification that skips `code`/`pre` blocks.
- **T031 Error reporting** — `file:line` errors for frontmatter, templates, and markdown, aggregated with a non-zero exit.
- **T032 Internal link checker** — fails the build on broken internal links and anchors, with an allowlist.
- **T033 Golden-site snapshot tests** — a fixture site snapshot suite pinning `dist/` output as the regression baseline.
- **T034 Example site** — a demo site exercising every feature, built in CI.
- **T035 Docs & README** — quickstart, config reference, and feature and CLI documentation.
- **T036 CI workflow** — typecheck, test, and example-site build run on push and pull request.
- **T037 Release prep** — semver `0.1.0`, this changelog, a `files` allowlist for `npm pack`, and the packed-tarball smoke test.
