# T012 — Build orchestrator, feature contract & report

|            |                                                                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wave/batch | W2·B3                                                                                                                                                                                                                                 |
| Depends on | T007–T011                                                                                                                                                                                                                             |
| Blocks     | T013, T014, T015, T016, T017, T018, T019, T020, T021, T022, T023, T026, T027, T029, T030, T031, T032                                                                                                                                    |
| Owns       | `src/pipeline/build.ts`, `src/pipeline/features.ts`, `src/pipeline/report.ts`, `src/commands/build.ts`, `src/feature.ts`, `test/build.test.ts`                                                                                          |
| Size       | L                                                                                                                                                                                                                                     |

## Goal

`kiln build` runs the whole pipeline — config → discovery → feature hooks →
collections → emit → assets → report — with correct exit codes, and defines
the `Feature` hook contract plus auto-discovery seam that every Wave-3/4/5
feature plugs into.

## Requirements

- **Orchestrator** (`src/pipeline/build.ts`):
  - `build(options?: BuildOptions): Promise<BuildReport>` with
    `BuildOptions { cwd?: string /* default process.cwd() */; flags?:
    BuildFlags }`. Config is loaded fresh inside every call
    (`loadConfig(cwd)`, T003) so watch-mode re-invocations see config edits.
  - Stage order: `discover` (T007) → seed `site.data` as a mutable copy of
    `config.site` (`{ title, url, description? }`) → feature discovery →
    `onDocument` per page (path order) → `onSite` (once) →
    `computeCollections(site)` (T008, after `onSite` so visibility fixes and
    appended pages are reflected) → `emitPages(site, { distDir:
    config.outDir, extensions, extra: { collections, flags }, shouldSkip })`
    (T010) → `copyAssets({ publicDir: config.publicDir, distDir:
    config.outDir, emitted: set of emitted ∪ skipped files, hashBust })`
    (T011 — cache-skipped outputs exist on disk and are equally protected)
    → `cache.record(...)` for each emitted page → `onBuildEnd` per feature →
    stop clock → print report → return it.
  - Markdown seam: `extensions: MarkdownExtension[]` (T006 type) wrapping
    each feature's `extendMarkdown(md, ctx)` in filename order. T009 invokes
    them on a fresh renderer **once per rendered page**, so
    `extendMarkdown` must be pure plugin registration. No core file imports
    `src/features/*` — only `src/pipeline/features.ts` globs (rules 3/6).
  - Non-feature failures (config, discovery, template, emit, asset,
    cache-load) **throw**: T002's CLI prints `kiln: <message>`, exit 1, no
    report. Feature failures follow the report path below instead.
  - Re-invocation safety: extensions array, contexts, and the clock are
    recreated per call; feature modules remain imported (ESM cache), so
    hooks must tolerate firing on every rebuild — never assume a hook runs
    exactly once per process.
- **Feature contract** (`src/feature.ts` — the seam T013–T023/T030–T032
  depend on):
  ```ts
  export interface Feature {
    extendMarkdown?(md: MarkdownIt, ctx: FeatureContext): void | Promise<void>;
    onDocument?(doc: Document, ctx: FeatureContext): void | Promise<void>;
    onSite?(site: Site, ctx: FeatureContext): void | Promise<void>;
    onBuildEnd?(result: BuildEnd, ctx: FeatureContext): void | Promise<void>;
  }
  export interface BuildFlags { drafts: boolean; future: boolean; noCache: boolean }
  export interface FeatureContext {
    readonly name: string;            // feature file stem, e.g. "highlight"
    readonly flags: BuildFlags;
    options<T>(validate: (raw: unknown) => T): T;
  }
  export interface BuildEnd {
    readonly distDir: string;
    readonly site: Site;
    readonly emitted: readonly EmittedPage[];
    readonly skipped: readonly EmittedPage[];
  }
  export interface FeatureError {
    feature: string; hook: string; message: string; doc?: string;
  }
  ```
  - `ctx.options(validate)` reads `config.features?.[ctx.name]` (undefined
    when absent), returns the validator's result untouched, and re-throws a
    validator failure prefixed `features.<name>: ` — config errors always
    carry the full key path (rule 4: each feature validates its own slice;
    T003 never gains feature-specific keys).
  - Hook timing/ordering guarantees (the contract's core):
    `extendMarkdown` — applied in sorted-filename order, per rendered page,
    before any markdown; `onDocument` — each discovered page (T007's output,
    path order), all features in filename order per page, BEFORE
    markdown/layout render — mutating `doc.data` is legal (rule 5);
    `onSite` — once after all pages, filename order; may remove entries from
    `site.pages` (visibility) or append `Page`-shaped entries (pages lacking
    `url` get it from T010's `pageOutputFor` fallback via
    `data.permalink`/`path`); `onBuildEnd` — once per build, filename
    order, after emit + asset copy; may write files into `distDir`.
  - Failure behavior: any hook rejection (including `options()` validation)
    stops the build immediately — no further hooks or stages run — and
    records a `FeatureError` (`feature` = `src/features/<file>.ts`, `hook`
    ∈ `load | extendMarkdown | onDocument | onSite | onBuildEnd`,
    `message`, plus `doc` for `onDocument`). The report still prints with
    partial counts and duration, and `build()` RETURNS it with non-empty
    `featureErrors` (never throws for feature failures).
- **Discovery** (`src/pipeline/features.ts`): glob `src/features/*.ts`
  resolved from `import.meta.url` (not cwd), sort lexicographically by
  filename — this order is THE feature order for every hook — `import()`
  each module and take its **default export** as the `Feature`. Empty
  directory → zero features (valid; W2 runs featureless). Invalid module
  (no default export, default not a plain object, a present hook that is
  not a function) → `FeatureError` with `hook: 'load'`, build aborted.
- **Report** (`src/pipeline/report.ts`): `formatReport(report:
  BuildReport): string`, printed to stdout by `build()` before returning so
  every caller (CLI, watch) reports identically. `BuildReport = { emitted:
  EmittedPage[]; skipped: EmittedPage[]; durationMs: number; featureErrors:
  FeatureError[] }`; `durationMs` is wall-clock build time including hooks.
  Format:
  ```
  kiln build
    pages emitted: 12
    pages skipped (cache): 3
    duration: 412ms
    feature errors: 1
      src/features/feed.ts (onSite): features.feed: bad option
      src/features/toc.ts (onDocument): boom [doc /abs/content/post.md]
  ```
  The `feature errors:` block is omitted when there are none; the first
  three lines are always present.
- **Command** (`src/commands/build.ts`): named exports `{ name: 'build',
  description, run }` consumed by T002's auto-discovery (no registration
  file, no edit to `src/cli.ts`). Parses `--drafts`, `--future`,
  `--no-cache`; an unknown flag or any positional argument → usage error on
  stderr listing the supported flags, exit 2 (T002's codes). Runs
  `build({ flags })`; when `report.featureErrors.length > 0` sets
  `process.exitCode = 1`; otherwise exit 0. Flags are parsed and exposed
  through `ctx.flags` here; their publishing behavior is implemented by the
  publish feature (T013).
- **Cache seam** (contract consumed by T029):
  - `BuildCache` exported from `src/pipeline/build.ts`:
    `shouldSkip(page: Page): boolean` (true → T010 skips render+write when
    the output file exists → `report.skipped`), `record(page: Page,
    outFile: string): void` (after each successful write).
  - Unless `flags.noCache`, `build.ts` loads `src/pipeline/cache.ts` via a
    computed-specifier dynamic import (`new URL('./cache.ts',
    import.meta.url).href`) so `tsc --noEmit` stays green before T029
    creates the file. Absent module → no cache (normal W2–W3 state);
    present but failing to import or missing `createCache` → throws with an
    error naming `src/pipeline/cache.ts`.
  - `createCache({ siteDir: config.root, distDir: config.outDir,
    templatesDir: config.templatesDir, flags })`.
  - Required behavior for T029: invalidation keys MUST incorporate the
    `drafts`/`future` mode — toggling either flag forces previously
    skipped pages (home/list pages) to re-render.
- **Config note**: `kiln build` passes `config.assets.hashBust` (default
  `false`) to `copyAssets`; this key is a known key of `src/config.ts` as
  specified in T003 — no coordination needed.

## Acceptance criteria

- [ ] Fixture project (content with `index.md` + `posts/p.md`, T009's
      `templates/`, `public/app.css`, `kiln.config.ts` exporting `{}`) →
      `cd fixture && node <repo>/src/cli.ts build` prints `kiln build`,
      `pages emitted: 2`, `pages skipped (cache): 0`, a `duration:` line,
      exit 0; `dist/index.html` and `dist/app.css` both exist.
- [ ] `node src/cli.ts` help lists `build` while `src/cli.ts` contains no
      reference to it (auto-discovery only).
- [ ] `kiln build --bogus` and `kiln build extra` → stderr usage error,
      exit 2.
- [ ] `kiln build --no-cache` → accepted, exit 0, report shows
      `pages skipped (cache): 0` (no `cache.ts` exists yet).
- [ ] Feature probe (covered programmatically in `test/build.test.ts`, with
      cleanup even on assertion failure): a temporary
      `src/features/__probe.ts` default-exporting a feature whose
      `onBuildEnd` writes `dist/probe.marker` → marker exists after build;
      deleting the probe → build green again.
- [ ] Ordering proof: probes `__a.ts` and `__z.ts` mutate `site.data.title`
      in `onSite` (`'A'` then append `'Z'`) and persist the result from
      `onBuildEnd` → stored value is `AZ`, proving sorted-filename order.
- [ ] A probe throwing `boom` in `onSite` → exit 1; report contains
      `feature errors: 1`, `src/features/__bad.ts (onSite): boom`, and
      `pages emitted: 0` (the build stopped before emit).
- [ ] A module under `src/features/` with no default export → exit 1 with
      an error naming that file.
- [ ] A probe whose `ctx.options` validator throws → report line contains
      `features.__opt:`.
- [ ] Empty `content/` → exit 1 containing `no markdown files found`;
      missing `content/` → exit 1 containing `content directory not found`.
- [ ] Content page with `layout: bogus` → exit 1, message
      `template not found` naming it.
- [ ] Two sequential `build()` calls in one process return equal
      `emitted.length` (watch-mode precondition).
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
npm run typecheck && npm test      # includes test/build.test.ts (seam probes, order, error paths, cleanup)
node src/cli.ts build --bogus      # usage error on stderr, exit 2

# end-to-end fixture
r=$(pwd); d=$(mktemp -d)
mkdir -p "$d/content/posts" "$d/templates" "$d/public"
cp templates/*.html "$d/templates/"                 # T009's default layouts
printf 'export default {};' > "$d/kiln.config.ts"
printf -- '---\ntitle: Home\n---\nHello' > "$d/content/index.md"
printf -- '---\ntitle: Post\ndate: 2026-01-01\n---\nBody' > "$d/content/posts/p.md"
printf 'body{}' > "$d/public/app.css"
( cd "$d" && node "$r/src/cli.ts" build )   # stdout: "kiln build", "pages emitted: 2", exit 0
test -f "$d/dist/index.html" && test -f "$d/dist/app.css" && echo OK
```

## Non-goals

- No watcher/dev-server (T026/T027), no cache implementation (T029 — only
  the seam), no feature behavior (T013–T023, T030–T032), no aggregated
  file:line diagnostics (T031), no extra CLI flags (`--out`, `--config`,
  `--json`), no config-file watching, no `dist/` pruning (T025), no docs
  (T035).
