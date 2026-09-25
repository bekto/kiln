# T029 — Build cache

|            |                                          |
| ---------- | ---------------------------------------- |
| Wave/batch | W4·B1                                    |
| Depends on | T012                                     |
| Blocks     | T035                                     |
| Owns       | `src/pipeline/cache.ts`, `test/cache.test.ts` |
| Size       | M                                        |

## Goal

Rebuilds skip pages whose inputs are unchanged — counted as `skipped` in the
build report, output bytes and mtimes untouched — while any change to a
feature, the config, the build options, or a template invalidates everything;
a corrupt cache silently degrades to a full build and never fails one.

## Requirements

- `src/pipeline/cache.ts` implements T012's `BuildCache` seam exactly as
  fixed in T012: exports `createCache(options: { siteDir: string; distDir:
  string; templatesDir: string; flags?: BuildOptions['flags'] }): BuildCache`,
  with `BuildCache` (defined in T012's `src/pipeline/build.ts`) =
  `{ shouldSkip(page: Page): boolean; record(page: Page, outFile: string):
  void }`. `shouldSkip` returning true means the page is not rendered or
  written and lands in `report.skipped`; `record` fires after each
  successful write. T012 loads the module through a computed-specifier
  dynamic import (`new URL("./cache.ts", import.meta.url).href`) so typecheck
  passes before this ticket exists: absent file → silently uncached builds
  (the W2–W3 behavior); file present but failing to import or missing
  `createCache` → the build fails with an error naming
  `src/pipeline/cache.ts` (wiring errors are loud; data problems below are
  silent).
- Cache file: `dist/.kiln-cache.json` — read once inside `createCache()`,
  persisted by write-through from `record()` using an atomic temp-file +
  rename write. JSON map of output path → entry; each entry records the
  source file's SHA-256 content hash. Because `record()` only fires after a
  real write, a failed build retains exactly the entries for pages that
  completed.
- Per-page validity: a page may be skipped only when its source file's
  content hash matches the cached entry AND the global inputs below are
  unchanged.
- Global inputs (a mismatch discards the entire cache and forces a full
  build):
  - the sorted list of discovered feature modules, hashed together with
    their module code — adding, removing, or editing any `src/features/*`
    module invalidates everything;
  - a stable hash of the effective T003 config (resolved via
    `loadConfig(siteDir)`, excluding runtime-only keys such as `port`);
  - the build flags (`drafts`, `future` — passed to `createCache` via
    `flags`) so toggling `--drafts`/`--future` never serves entries
    produced in another mode: required behavior, since a hidden draft
    changes list/home pages whose own sources are unchanged — those must
    still rebuild (`noCache` never reaches `createCache`; T012 skips the
    whole load);
  - a hash of all files under `templatesDir`, so a layout/partial edit
    rebuilds every page.
- Unchanged page → render and write are skipped; the page is added to
  `report.skipped` (printed as `pages skipped (cache): M`), separate from
  `report.emitted`; the output file on disk is left byte- and
  mtime-identical.
- Changed page → rebuilt normally and its cache entry refreshed.
- `--no-cache` on `kiln build` (→ `flags.noCache`): T012 skips loading the
  cache entirely — nothing read, nothing written, every page rebuilt, and
  the existing cache file is left byte-identical (safe: entries still
  validate by content hash on the next normal build).
- Corrupt, truncated, unparseable, or wrong-shape cache file → silently
  discard it and do a full rebuild: no warning, no error, exit 0; entries
  re-recorded during the rebuild make the file valid again. A missing cache
  file is the same case.
- Runtime cache problems never fail a build: unreadable or unwritable cache
  data degrades to normal build behavior (full rebuild, entries simply not
  persisted); the atomic temp-file + rename write means an interrupted
  build cannot leave a half-written cache behind.

## Acceptance criteria

- [ ] Build once, build again → second build prints `pages emitted: 0` and
      `pages skipped (cache): N` (T012's report lines from `report.skipped`);
      output files' bytes and mtimes are unchanged.
- [ ] Editing one content file → exactly that page is rebuilt (`pages
      emitted: 1`), all others counted as skipped.
- [ ] Adding, removing, or editing a `src/features/*` module → next build is
      full (`pages skipped (cache): 0`).
- [ ] Changing any effective value in `kiln.config.ts` → full rebuild.
- [ ] Toggling `--drafts` on/off → full rebuild (no cross-mode reuse).
- [ ] Editing a template file → full rebuild.
- [ ] `kiln build --no-cache` on an unchanged site rebuilds every page and
      leaves `dist/.kiln-cache.json` byte-identical.
- [ ] Trashing `dist/.kiln-cache.json` (garbage bytes) → build exits 0,
      full rebuild, valid cache file regenerated; deleting it entirely is
      equally silent.
- [ ] Skipped pages appear in `report.skipped`, never in `report.emitted`
      (the two counts stay separate).
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
node src/cli.ts build                # prints "pages emitted: N"
node src/cli.ts build                # prints "pages emitted: 0", "pages skipped (cache): N"; mtimes untouched
node src/cli.ts build --no-cache     # pages emitted: N again; cache file byte-identical
echo garbage > dist/.kiln-cache.json && node src/cli.ts build
                                     # exit 0, full rebuild, cache valid again
node --test test/cache.test.ts
npm run typecheck && npm test
```

## Non-goals

- No cache location outside `dist/`, no cross-project or remote cache.
- Skip granularity is the whole page — no partial/fragment-level caching.
- Deciding *when* to rebuild is not this ticket's job (that is T027); this
  only decides what a rebuild can skip.
- No asset/static caching — T011 still copies `public/` each build.
