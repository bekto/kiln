# T025 — `kiln clean`

|            |                                              |
| ---------- | -------------------------------------------- |
| Wave/batch | W4·B1                                        |
| Depends on | T002                                         |
| Blocks     | T035                                         |
| Owns       | `src/commands/clean.ts`, `test/clean.test.ts` |
| Size       | S                                            |

## Goal

`kiln clean` removes the build output directory and nothing else, with a hard
path-traversal guard, a `--dry-run` mode, and a harmless no-op when there is
nothing to remove.

## Requirements

- Command module `src/commands/clean.ts` exporting `{ name: 'clean', run }`
  where `run(args: string[])` receives raw argv tokens after the command name
  (T002 contract) and recognizes `--dry-run`; unknown tokens → usage error →
  exit 2. Auto-discovered by the T002 seam; never edits `src/cli.ts`.
- Removes the directory named by config `outDir` (`loadConfig()` from T003,
  default `dist/`) — that directory and all its contents, and nothing else.
  On success print one line naming what was removed, exit 0.
- Safety guard: resolve the target against the project root before deleting.
  Refuse (throw an error — CLI prints `kiln: <message>` to stderr, exit 1 —
  with zero deletions) when the resolved target is:
  - the project root itself (`outDir: "."`),
  - filesystem root (`/` or empty string), or
  - outside the project root (e.g. `../elsewhere`, an absolute path pointing
    out of the project).

  The error message names the configured `outDir` value and the resolved
  path.
- If `outDir` exists but is a regular file (not a directory) → throw an
  error naming the path (CLI prints `kiln: <message>`, exit 1), file
  untouched.
- `--dry-run`: print the resolved target, each immediate child it would
  delete, and a summary line `would remove N entries`; perform zero
  deletions.
- Missing target → exit 0 with the note `nothing to clean: <path> does not
  exist` — a success no-op, not an error.
- The T029 cache file (`dist/.kiln-cache.json`) lives inside `outDir` and is
  removed with it; no special handling needed.

## Acceptance criteria

- [ ] After `kiln build`, `kiln clean` exits 0 and `dist/` no longer exists.
- [ ] A second consecutive `kiln clean` exits 0 with the nothing-to-clean
      note, no error output.
- [ ] `kiln clean --dry-run` against a populated `dist/` lists the entries
      and the `would remove N entries` summary; `dist/` and its files are
      byte-identical afterward.
- [ ] Config `outDir: "../outside"` → exit 1 with `kiln: <message>` naming
      `outDir` and the resolved path, nothing outside the project removed.
- [ ] Config `outDir: "."` → exit 1, project files intact.
- [ ] `outDir` pointing at an existing regular file → exit 1, file
      intact.
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
node src/cli.ts build && node src/cli.ts clean    # dist/ gone, exit 0
node src/cli.ts clean                             # "nothing to clean" note, exit 0
mkdir -p dist && echo x > dist/f.txt && node src/cli.ts clean --dry-run
                                                  # lists dist/f.txt; dist/f.txt still exists
node --test test/clean.test.ts                    # includes outDir "../evil" and "." refusal cases
npm run typecheck && npm test
```

## Non-goals

- No interactive confirmation and no `--force` flag.
- Never touches `content/`, `public/`, `templates/`, or `node_modules/`.
- No gitignore-aware or partially-selective cleaning — it is all of `outDir`
  or nothing (or `--dry-run`).
