# T035 — Docs & README

|            |                                                     |
| ---------- | --------------------------------------------------- |
| Wave/batch | W5·B1                                               |
| Depends on | T013–T023 (W3), T024–T029 (W4)                      |
| Blocks     | T037                                                |
| Owns       | `README.md`, `docs/**`, `test/docs.test.ts`         |
| Size       | L                                                   |

## Goal

A newcomer goes from zero to a built demo site using only the README;
every config key and CLI command is referenceable without reading source;
`docs/` carries per-feature and per-command guides plus an architecture
overview pointing back at `PLAN.md` — with internal links and reference
completeness enforced by `test/docs.test.ts`.

## Requirements

### `README.md` (sections, in this order)

1. **Title + tagline + badges line ("badges-ready")** — CI status badge
   from the standard URL
   `https://github.com/<owner>/<repo>/actions/workflows/ci.yml/badge.svg`
   (the workflow T036 creates) and npm version badge
   `https://img.shields.io/npm/v/kiln.svg`; no other badges, no claims
   the repo can't back.
2. **Quickstart — exactly three commands** (runnable from a fresh clone;
   the build/serve strings are canonical and identical to T034/T036):

```console
$ npm install
$ cd site && node ../src/cli.ts build   # → site/dist/
$ cd site && node ../src/cli.ts serve   # browse the demo
```

3. **Configuration reference** — two tables, columns `Key | Type |
   Default | Description`:
   - Base table = every T003 key: `contentDir` (string, `content`),
     `templatesDir` (string, `templates`), `publicDir` (string, `public`),
     `outDir` (string, `dist`), `site.title` (string, `Kiln site`),
     `site.url` (string, `http://localhost:8080` — must be absolute and
     valid or the feed build fails, per T018), `site.description` (string,
     unset), `features` (object, `{}` — open map, each feature validates
     its own slice).
   - `features.*` table = exactly these rows (type, default, owning
     feature): `features.highlight.theme` (string, `github-dark`);
     `features.toc.depth` (number, `3`, valid 2–3);
     `features.feed.limit` (number, `20`);
     `features.pagination.pageSize` (number, `10`);
     `features.excerpt.length` (number, `260`);
     `features.readingTime.wordsPerMinute` (number, `200`);
     `features.related.limit` (number, `5`);
     `features.search.indexPath` (string, `search-index.json`);
     `features.minify` (object — enabling key) with
     `features.minify.collapseWhitespace` (boolean, `true` when enabled),
     `features.minify.removeComments` (boolean, `true`),
     `features.minify.minifyCSS` (boolean, `false`),
     `features.minify.minifyJS` (boolean, `false`);
     `features.linkCheck.allow` (string[], `[]`),
     `features.linkCheck.exclude` (string[], `[]`). T013/T014/T019
     define no config keys (T013 is flag-gated) — note that in a footnote
     row rather than omitting the features.
4. **CLI reference** — one entry per discovered command: `kiln build`,
   `kiln clean`, `kiln help`, `kiln new`, `kiln serve`, `kiln version`,
   each with synopsis, arguments, flags, and examples; exit codes
   `0` success / `1` failure / `2` usage (T002). Flags documented from the
   shipped `src/commands/*.ts`, including `--drafts` and `--future`
   (T013) and `--no-cache` (T029).
5. **Features overview** — short per-feature paragraphs linking into
   `docs/`.
6. **Development** — `npm run typecheck`, `npm test`, links to
   `docs/architecture.md` and `PLAN.md`.

### `docs/` (exact files)

- `docs/content.md` — frontmatter model (open `data`, dates, `draft`,
  `tags`, `category`, `collection`), discovery rules (`.`/`_` segment
  exclusion, sorted output), slugs & permalinks, collections & ordering,
  drafts/scheduled publishing with `--drafts`/`--future`.
- `docs/templates.md` — nunjucks layouts/inheritance, partial auto-load,
  the view data available (site, document, collections, TOC, pagination),
  default layouts, and the opt-in search partial.
- `docs/features.md` — prose guide per feature with its config key and
  defaults: taxonomy archives, pagination, heading anchors/TOC, feed (with
  the absolute-`site.url` requirement), sitemap, excerpts, reading time,
  related posts, client search, syntax highlighting, HTML minification,
  link checker (the last two documented from T030/T032, whose keys are in
  the README table).
- `docs/cli.md` — per-command reference: arguments, every flag, exit
  codes — the long form behind the README's command list.
- `docs/dev-loop.md` — `kiln serve`, the watcher, SSE live reload, the
  incremental build cache and `--no-cache`, `kiln clean`.
- `docs/architecture.md` — pipeline overview (mermaid diagram adapted from
  PLAN.md), the stage-to-file map, and the extension seams: command
  auto-discovery (`src/commands/*.ts`), feature hooks
  (`extendMarkdown`/`onDocument`/`onSite`/`onBuildEnd` +
  `src/features/*.ts`), the open `features` config map, the markdown
  seam, open frontmatter — ending with an explicit link to `../PLAN.md`
  as the source of truth for the ticket/ownership history.

### Validation (`test/docs.test.ts`, committed — this is the "which"
for link checking)

- Extract every markdown link from `README.md` and `docs/**/*.md`:
  - External (`http(s)://`, `mailto:`) → skipped (offline by design —
    fetching external links is a non-goal, not a manual chore).
  - Internal target → resolved relative to the containing file; the file
    or directory must exist.
  - `#fragment` (same file) or `file.md#fragment` → the fragment must
    match a heading anchor in the target (GitHub-style slug: lowercase,
    punctuation stripped, whitespace → `-`, unicode letters kept).
- Config-key completeness: regex `\bfeatures\.[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)?`
  over `src/**/*.ts` → every match must appear in the README's
  configuration section (source ⊆ docs, automated). The reverse direction
  (no dead rows in README) is checked manually against this ticket's row
  list.
- Command coverage: extract every `name: '…'` literal from
  `src/commands/*.ts` → each must appear as `` `kiln <name>` `` in the
  README CLI reference and as an entry in `docs/cli.md`.
- Flag coverage: regex `--[a-z][a-z-]*` over `src/commands/*.ts` → each
  must appear in `docs/cli.md`.

## Acceptance criteria

- [ ] README contains, in order: badges line, quickstart with exactly the
      three canonical commands, configuration tables, CLI reference,
      features overview, development section.
- [ ] Base table lists exactly T003's keys with the defaults above; the
      `features.*` table contains every row enumerated in Requirements
      (15 keys + the `features.minify` object row) with type and default.
- [ ] `npm test -- test/docs.test.ts` green: all internal links (paths +
      fragments) resolve; every `features.*` literal in `src/` appears in
      the README config section; every command `name` appears as
      `kiln <name>` in README and in `docs/cli.md`; every `--flag` in
      `src/commands/*.ts` appears in `docs/cli.md`.
- [ ] All six `docs/` files exist; `docs/architecture.md` links `PLAN.md`
      and describes the seams consistently with PLAN.md's concurrency
      rules.
- [ ] The quickstart build command executes successfully:
      `cd site && node ../src/cli.ts build` exits 0 with
      `site/dist/index.html` present.
- [ ] No dead README rows: every `features.*` row maps to a key that
      exists in `src/` (manual check against this ticket's list).
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
npm test -- test/docs.test.ts        # links (path+fragment), config keys, command names, flags
grep -ohE '\bfeatures\.[A-Za-z0-9]+(\.[A-Za-z0-9]+)?' -r src --include='*.ts' | sort -u
                                      # every line printed appears in README's configuration section (eyeball)
(cd site && node ../src/cli.ts build) # quickstart command, exit 0 → site/dist/index.html
npm run typecheck && npm test         # both exit 0
```

Manual observation: open `README.md` rendered — badges line present, tables
aligned, no placeholder/TBD text anywhere.

## Non-goals

- No fetching, checking, or monitoring of external URLs (offline
  validation only); no link rot dashboard.
- No docs-site generator (Docusaurus/MkDocs/etc.), no man page, no PDF, no
  i18n — plain markdown in the repo only.
- No LICENSE, contributing guide, or code of conduct beyond the short
  Development section; no per-release doc versioning.
- No code, `PLAN.md`, or `tickets/` edits; no error-format reference page
  (T031 lands in the same batch — its stderr format is not documented
  here).
- No rewriting of feature behavior — docs describe shipped behavior; where
  a ticket and source disagree, the test above fails and the source wins.
