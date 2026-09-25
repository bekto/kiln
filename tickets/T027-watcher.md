# T027 — Watcher & incremental rebuild

|            |                                    |
| ---------- | ---------------------------------- |
| Wave/batch | W4·B1                              |
| Depends on | T012                               |
| Blocks     | T028, T035                         |
| Owns       | `src/watch.ts`, `test/watch.test.ts` |
| Size       | M                                  |

## Goal

Editing anything under `content/`, `templates/`, or `public/` triggers exactly
one debounced rebuild whose duration is printed; deleted content loses its
output page; rebuild errors are reported without ever killing the watcher.

## Requirements

- `src/watch.ts` exports `startWatching(config)` (config resolved by the
  caller via T003's `loadConfig()`) returning a handle
  `{ close(): Promise<void> }` that stops every watcher and pending timer.
  No new command file — activation comes later via T028's `kiln serve`
  integration.
- Watches the configured roots `contentDir`, `templatesDir`, `publicDir`
  (T003 defaults `content/`, `templates/`, `public/`) recursively, using
  `fs.promises.watch` / `fs.watch`.
- Missing watch root → one-line warning `watch: root <path> does not exist,
  skipping` while the remaining roots stay watched; if no root exists at
  all, `startWatching` throws naming all of them.
- Debounce: config key `watch.debounceMs` (number, default 100) — a known
  key of `src/config.ts` as specified in T003.
  Events within the window coalesce into a single rebuild; each new event
  resets the trailing-edge timer. Saving several files at once = one rebuild.
- A rebuild calls `build(options?: BuildOptions): Promise<BuildReport>`
  exported by T012's `src/pipeline/build.ts` — the exported API directly,
  with defaults (project root, no flags; `build()` re-loads the config on
  each invocation) — the watcher never spawns `node src/cli.ts build`.
- If events arrive while a rebuild is in flight, they queue and cause
  exactly one follow-up rebuild after the current one finishes.
- After each rebuild print one line to stdout: `rebuild in <N>ms` (using
  `report.durationMs`) followed by T012's standard report summary (`pages
  emitted: N`, `pages skipped (cache): M`). A failed rebuild prints `rebuild
  failed in <N>ms: <message>` to stderr and the watcher keeps running; the
  next change retries.
- Deleted content file: after the next rebuild its output page is gone from
  `dist/` — the watcher prunes outputs whose source no longer exists, using
  T005's path→URL mapping; outputs that cannot be mapped to a source are
  never pruned.
- Rename = delete + create: old output pruned, new page emitted (an atomic
  editor rename lands both events in one debounce window → one rebuild).
- Noise filtering: editor temp/backup writes (`*~`, `*.swp`, `*.tmp`,
  `*.part`) trigger no rebuild; `outDir` itself is never watched, so output
  writes can't retrigger the watcher (no rebuild loop).
- Rebuild errors never crash the process or close the handle.
- Seam for T028: export `onAfterRebuild(listener)` from `src/watch.ts`.
  Listeners fire after every rebuild attempt with `{ ok: boolean, report?,
  error? }`; the function returns an unsubscribe function; zero listeners is
  a no-op.

## Acceptance criteria

- [ ] On a fixture site, editing a content file yields exactly one rebuild
      and stdout contains `rebuild in <N>ms`.
- [ ] Two edits 30 ms apart → one rebuild; two edits 500 ms apart → two
      rebuilds; `watch.debounceMs: 500` widens the coalescing window
      accordingly.
- [ ] Deleting `content/posts/x.md` → after the next rebuild the
      corresponding file under `dist/` no longer exists.
- [ ] Renaming a content file → old output gone, new output present after a
      single rebuild.
- [ ] Breaking a template → the error is printed to stderr and the handle
      stays open; fixing it → the next edit rebuilds successfully.
- [ ] Writing `a.md~` / `.a.md.swp` triggers no rebuild; writing into `dist/`
      triggers no rebuild.
- [ ] A rebuild triggered while another is running is deferred and runs
      once, not once per queued event.
- [ ] `onAfterRebuild` listeners receive `{ ok: true, report }` after
      success and `{ ok: false, error }` after a failed rebuild.
- [ ] A missing root produces the warning naming it while the other roots
      keep triggering rebuilds.
- [ ] `close()` resolves, after which edits cause no further rebuilds.
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
node --test test/watch.test.ts    # temp fixture site: one-rebuild-per-burst, prune-on-delete,
                                  # rename, error survival, debounce config, close()
# manual driver: script creates a fixture, calls startWatching(loadConfig()),
#   appends to a content file, observes stdout `rebuild in <N>ms` and the
#   updated dist/ file, then close()
npm run typecheck && npm test
```

## Non-goals

- No `kiln watch` / `kiln dev` command file — T028 activates watching
  through `kiln serve`.
- No per-page skip logic inside the watcher — each change triggers a whole
  `build()` invocation; any per-page skipping happens inside that call
  (T029's cache).
- No SSE/live-reload broadcast — T028 consumes `onAfterRebuild`.
- No third-party watchers (chokidar etc.) and no dependency added.
