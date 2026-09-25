# T007 — Content discovery

|            |                                                    |
| ---------- | -------------------------------------------------- |
| Wave/batch | W2·B1                                              |
| Depends on | T004, T005                                   |
| Blocks     | T008, T012                                         |
| Owns       | `src/content/discover.ts`, `test/discover.test.ts` |
| Size       | M                                                  |

## Goal

Every markdown file under `content/` is found recursively and parsed by T004
into one `Site` of `Page`s — URLs assigned (T005), collection membership
stamped, order deterministic — the input half of the build pipeline.

## Requirements

- Export `discover(options: { contentDir: string }): Promise<Site>` from
  `src/content/discover.ts`. `contentDir` may be absolute or cwd-relative;
  discovery performs reads only (no writes, no config, no templates/`public/`).
- File selection: iterate `fs.promises.glob()` (async iterator) over
  `<contentDir>/**/*`; keep regular files whose extension is `.md` or
  `.markdown` (case-insensitive); reject any match whose path **relative to
  `contentDir`** contains a segment starting with `.` or `_`
  (`content/.notes.md`, `content/_partials/intro.md` are never content —
  segments above `contentDir` are irrelevant).
- Each match is parsed with T004's `readDocument(absolutePath)`. Parse
  failures (invalid YAML, bad date, non-mapping frontmatter) abort discovery;
  the propagated error is T004's own, carrying the absolute source path.
- Per document, compute `relPath` (POSIX, relative to `contentDir`) and assign
  `page.url` using T005:
  - `data.permalink` present → must be a string (else
    `<path>: "permalink" must be a string (got <type>)`); URL =
    `applyPermalink(permalink, { slug: slugFromPath(relPath), date: data.date })`.
    T005 errors (unknown placeholder, placeholder requiring a date) are
    wrapped so the message also names the source file.
  - otherwise → `urlForPath(relPath)`.
- Stamp `data.collection` when it is not already set: `relPath` starting with
  `posts/` → `'posts'`, everything else → `'pages'`. A user-provided value is
  preserved verbatim (T008 validates it later).
- Returned `Site`: `pages` sorted ascending by `path` (codepoint order —
  discovery order is reproducible across filesystems/runs), `data: {}`
  (T012 seeds site metadata from config before hooks run). `page.path` stays
  the absolute source path (T004's contract); `relPath`/collection are derived
  values, not stored as paths.
- Missing `contentDir` (or unreadable) → rejects with
  `content directory not found: <absolute path>`.
- `contentDir` exists but contains zero matching files → rejects with
  `no markdown files found under <absolute path>` — a typo'd or empty content
  directory must never produce a silent empty build.
- Symlinks receive no special-casing: whatever the glob yields is processed
  under the same rules.

## Acceptance criteria

- [ ] Fixture `content/index.md` + `content/posts/hello.md` →
      `site.pages` has both, `path` sorted ascending, urls `/` and
      `/posts/hello/` respectively (T005 defaults).
- [ ] `_partials/intro.md`, `.hidden.md`, and `notes.txt` under the fixture
      `content/` are absent from `site.pages`.
- [ ] `posts/hello.md` gets `data.collection === 'posts'`; `about.md` gets
      `'pages'`; `about.md` with frontmatter `collection: posts` keeps
      `'posts'` (user value preserved).
- [ ] A post with `permalink: '/posts/:year/:slug/'` and `date: 2026-09-25`
      gets url `/posts/2026/hello/`; `permalink: 42` rejects naming the file
      and `permalink`; `permalink: '/:nope/'` rejects naming the file and the
      placeholder.
- [ ] Nonexistent `contentDir` → error containing
      `content directory not found`; empty `contentDir` → error containing
      `no markdown files found`.
- [ ] Malformed frontmatter rejects with T004's message containing that
      file's path (never a silent skip).
- [ ] Two invocations on the same fixture return identical `path` sequences.
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
npm test -- test/discover.test.ts   # fixture tree → ordered Site, url/collection assignment, error shapes
npm run typecheck && npm test       # both exit 0
```

## Non-goals

- No frontmatter semantics beyond permalink/collection handling (draft/tag
  filtering is T008/T013), no markdown rendering (T006), no collections
  assembly or sorting (T008), no watching/incremental behavior (T027),
  nothing outside `content/` (templates and `public/` are T009/T011).
