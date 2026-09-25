# T024 — `kiln new`

|            |                                                      |
| ---------- | ---------------------------------------------------- |
| Wave/batch | W4·B1                                                |
| Depends on | T002, T003                                           |
| Blocks     | T035                                                 |
| Owns       | `src/commands/new.ts`, `test/new.test.ts`            |
| Size       | S                                                    |

## Goal

`kiln new "Title"` scaffolds a new content file in the right collection with
valid frontmatter and a unicode-safe slug filename, and never clobbers an
existing file.

## Requirements

- Command module `src/commands/new.ts` exporting `{ name: 'new', run }`
  where `run(args: string[])` receives the raw argv tokens after the command
  name (T002 contract); auto-discovered by the T002 seam; never edits
  `src/cli.ts`. The command parses its own tokens: every non-flag token is
  joined with spaces into the title; `--dir <value>` is consumed as the
  collection option.
- Usage: `kiln new <title>` with optional `--dir <pages|posts>` (default
  `posts`). Title is required — missing/empty → usage error → exit 2, no
  file written. Invalid `--dir` value → usage error → exit 2.
- `--dir` must be exactly `pages` or `posts`; any other value → error naming
  both allowed values.
- Output path: `<contentDir>/<dir>/<slug>.md`, where `contentDir` comes from
  `loadConfig()` (T003, default `content/`) and `<slug>` is
  `slugify(title)` from T005's `src/content/slug.ts` (unicode-safe;
  punctuation-only input such as `!!!` yields `untitled`) — the command
  never reimplements slug rules.
- File content: YAML frontmatter with `title` (the argument verbatim),
  `date` (ISO 8601 timestamp of now, second precision), `draft: true`, then
  an empty body and a trailing newline:

  ```markdown
  ---
  title: Café ☕ Ñ
  date: 2026-09-25T14:03:00+02:00
  draft: true
  ---
  ```

  The result must parse through T004's frontmatter reader.
- On success print `created <path>` to stdout, exit 0.
- Overwrite refusal: if the target exists, throw an error naming the path —
  the CLI prints `kiln: <message>` to stderr and exits 1, and the file stays
  byte-identical; the message offers no force/overwrite flag.
- A title that slugifies to `untitled` (e.g. `!!!`) creates
  `content/posts/untitled.md` like any other title — and is then refused by
  the overwrite rule on a second run; never a crash, never a bare `.md`.
- Creates the collection directory (e.g. `content/posts/`) when absent.

## Acceptance criteria

- [ ] `kiln new "Hello World"` exits 0 and creates `content/posts/hello-world.md`.
- [ ] The created file parses as a T004 Document: `title === "Hello World"`,
      `date` within the last minute, `draft === true`.
- [ ] `kiln new "Café ☕ Ñ"` exits 0; the filename equals
      `slugify("Café ☕ Ñ") + ".md"` per T005 (non-ASCII preserved).
- [ ] Re-running the same title exits 1 with `kiln: <message>` naming
      `content/posts/hello-world.md` on stderr, and the file is unchanged.
- [ ] `kiln new --dir pages "About"` creates `content/pages/about.md`.
- [ ] `kiln new --dir tags "X"` exits 2 with an error naming `pages`
      and `posts`.
- [ ] `kiln new` (no title) exits 2 with usage and creates nothing;
      `kiln new "!!!"` exits 0 creating `content/posts/untitled.md`, and a
      second `kiln new "!!!"` is refused with exit 1.
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
node src/cli.ts new "Hello World"        # exit 0; cat content/posts/hello-world.md shows title/date/draft
node src/cli.ts new "Hello World"        # exit 1; stderr: kiln: content/posts/hello-world.md already exists
node src/cli.ts new --dir pages "About"  # exit 0; content/pages/about.md exists
node src/cli.ts new                      # exit 2; usage on stderr
node src/cli.ts new "!!!"                # exit 0; content/posts/untitled.md created
node --test test/new.test.ts
npm run typecheck && npm test
```

## Non-goals

- No body templates, no opening an editor, no flags for date/draft/title
  overrides beyond `--dir`.
- No slug-collision renaming — existing files are refused, not suffixed.
- No collection directories other than `pages`/`posts`.
