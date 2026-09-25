# T031 — Error reporting

|            |                                                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wave/batch | W5·B1                                                                                                                                                                                       |
| Depends on | T012                                                                                                                                                                                        |
| Blocks     | —                                                                                                                                                                                           |
| Owns       | `src/errors.ts`, `src/config.ts`, `src/content/{document,discover,markdown}.ts`, `src/render/{templates,emit}.ts`, `src/pipeline/{features,build,report}.ts`, `src/commands/build.ts`, `test/errors.test.ts` |
| Size       | L                                                                                                                                                                                           |

## Goal

Every failure a build can hit — bad frontmatter, broken templates, markdown
or feature crashes, invalid config — surfaces as one structured `KilnError`
carrying `stage`, `file`, `line`, `col`; `kiln build` collects every error it
safely can, prints a single numbered block on stderr, and exits 1. First-
error-only behavior is explicitly rejected: one broken page must not hide the
others.

## Requirements

### Ownership — why this ticket edits other tickets' files

- This is the one ticket in the plan allowed to edit files owned by earlier
  tickets. It lands in W5·B1, after Waves 0–4 are complete and frozen:
  all of T001–T029 have shipped and `npm run typecheck && npm test` is
  green. No other W5·B1 ticket (T030, T032, T033, T034, T035) touches any
  file in this ticket's `Owns` list, so there is no intra-batch overlap.
- Edits to existing files are strictly additive/substitutive at throw and
  catch sites: replace `throw new Error(…)` with the equivalent
  `KilnError`, add structured fields, add collection. Message substrings
  that existing tests assert must be preserved verbatim — e.g. config
  errors keep their `kiln.config.ts:` prefix and key/type words (T003),
  frontmatter errors keep `<path>` + `line N` (T004), feature config
  errors keep naming `features.<key>` (T016, T020–T023).
- **No test file owned by T001–T029 may be modified.** The full existing
  suite must pass as written.

### The error type (`src/errors.ts`, new file)

- `type KilnStage = 'config' | 'frontmatter' | 'markdown' | 'template' |
  'emit' | 'feature' | 'build'`.
- `class KilnError extends Error` with `stage: KilnStage`,
  `file?: string` (project-relative when known), `line?: number`
  (1-based), `col?: number` (1-based), `featureFile?: string` (set when
  `stage === 'feature'`, e.g. `src/features/feed.ts`). Position fields are
  omitted (`undefined`), never `-1`, when the underlying error carries no
  position.
- `formatKilnError(err): string` → `[stage] <message>` (feature tag:
  `[feature src/features/feed.ts] <message>`). The message itself is always
  self-describing — it embeds `file[:line]` where known, and any parser
  position normalized to 1-based must agree with the structured fields.
- The original exception is kept as `err.cause`, never swallowed.

### Sources (call sites, and why each file is edited)

- `src/config.ts` — config validation and config-import failures become
  fatal `stage: 'config'` errors with `file: 'kiln.config.ts'` (plus `line`
  when the config file itself fails to parse and the position is
  extractable). Message format unchanged (T003's contract).
- `src/content/document.ts` — gray-matter/YAML and frontmatter-shape errors
  get `stage: 'frontmatter'`, `file`, and `line`/`col` parsed from the
  parser's position (T004 already puts `<path>` and `line N` in the
  message; the fields mirror those numbers).
- `src/content/discover.ts` — the per-document read/parse loop is the only
  place that sees *every* document; each iteration catches, records a
  `KilnError`, and continues to the next file, so N broken documents
  produce N collected errors (via an optional error-sink parameter added
  to the stage's signature — additive, existing callers unaffected).
- `src/content/markdown.ts` — failures thrown while rendering (a buggy
  `extendMarkdown` plugin's fence renderer, pathological input) are
  rethrown as `stage: 'markdown'` with the original message and cause; the
  pipeline caller (which knows the document) attaches `file`. T006's
  guarantee stands: syntactically valid markdown never throws.
- `src/render/templates.ts` — nunjucks compile/render failures become
  `stage: 'template'` with the template `file`, `line` from the nunjucks
  error (`Context.line` / `lineno`), `col` from `colno` when present; the
  message is prefixed with `file:line` when nunjucks didn't include it.
- `src/render/emit.ts` — fs write failures become `stage: 'emit'` with
  `file` = output path and the syscall/code (`EACCES: …`) in the message;
  the loop moves on to the next page.
- `src/pipeline/features.ts` — any throw from a `Feature` hook is wrapped:
  `stage: 'feature'`, `featureFile` = the discovered module path
  (`src/features/<name>.ts`), document context in `file` when the hook was
  invoked per-document, original error as `cause` with its message
  appended. Registration-time failures (a hook that throws while being
  collected) are wrapped here too; render-time failures inside markdown
  rendering are attributed by `src/content/markdown.ts` per above.
- `src/pipeline/build.ts` — wires the collector into every stage; owns the
  fatal-vs-collected policy below; wraps any unexpected non-`KilnError`
  escaping the orchestrator (including setup/discovery) as `stage: 'build'`.
- `src/pipeline/report.ts` — gains `printErrors(errors)`: renders the
  numbered block to **stderr** (the normal build report stays on stdout).
- `src/commands/build.ts` — loads config inside a try/catch (fatal path:
  `formatKilnError` on stderr, no report, exit 1) and sets
  `process.exitCode = 1` whenever the collector is non-empty at the end
  (T002 honors `process.exitCode`).

### Fatal vs collected (explicit policy)

- **Fatal — abort immediately, single line `kiln: [stage] <message>`, no
  numbered block, exit 1, nothing further runs:** `config` (there is no
  build without config) and `build` (unexpected orchestrator/setup
  failure).
- **Collected — record, isolate, keep going, then numbered block, exit 1:**
  `frontmatter` (that document is skipped; discovery continues),
  `markdown` (that document is skipped), `template` (that page is skipped;
  every other page still renders and emits), `emit` (that write failed;
  other writes proceed), `feature` (that hook invocation is marked failed;
  every other feature/hook still runs and its outputs are still written).
- Collected output format (stderr, after the normal report):

```text
kiln: build failed with 3 errors:
  1. [frontmatter] content/posts/broken.md: invalid frontmatter at line 4: mapping values are not allowed here
  2. [template] templates/post.html:12 — unknown block tag "include"
  3. [feature src/features/feed.ts] feed.xml: cannot write feed — ENOSPC
```

  - Header is pluralized: `with 1 error:` / `with N errors:`.
  - Identical rendered lines (same stage/file/line/message) collapse to a
    single entry suffixed ` (×N)` — one template bug hit by three pages is
    reported once, with the count.
  - Order is pipeline order (discovery order is sorted), hence
    deterministic; entries are never dropped for being "duplicates of
    earlier stages".
- Exit codes unchanged from T002: `0` clean, `1` any error, `2` usage.
  A build with zero errors prints no error block at all.

## Acceptance criteria

- [ ] Fixture with three broken posts and several good ones → exit 1; stderr
      shows `kiln: build failed with 3 errors:` followed by numbered
      entries tagged `[frontmatter]` with file+line; the good posts' HTML
      is still present in `dist/`.
- [ ] Frontmatter fixture with a known bad line → caught `KilnError` has
      `stage === 'frontmatter'`, `file` = the `.md` path, exact `line`
      (and `col` when the parser provides one); message still contains
      T004's path + `line` substrings (T004's tests pass unmodified).
- [ ] One page whose template fails → one `[template]` entry with the
      template's line; all other pages emitted; exit 1.
- [ ] A feature hook that throws → entry tagged with its
      `src/features/<file>.ts`; every other feature's outputs still exist
      (e.g. sitemap written); exit 1.
- [ ] Invalid config → single `[config]` line on stderr, no numbered
      header, `dist/` not produced, exit 1; T003's config tests pass
      unmodified.
- [ ] The same template error surfacing on three pages → one numbered entry
      suffixed `(×3)`.
- [ ] A markdown extension whose fence renderer throws → `[markdown]`
      entry naming the source `.md`; a build of valid markdown still never
      produces a markdown-stage error.
- [ ] Zero errors → no error block, exit 0; unknown command still exits 2
      (T002 contract intact).
- [ ] No test file owned by T001–T029 was modified; the whole suite passes.
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
npm test -- test/errors.test.ts   # stages, structured fields, fatal-vs-collected, dedupe, exit codes
npm test                          # full suite: all pre-W5 tests pass without edits
npm run typecheck && npm test     # both exit 0
```

## Non-goals

- No first-error-only/fail-fast mode and no `--bail` flag — aggregation is
  the contract, not an option.
- No JSON/SARIF/IDE protocol output, no source code frames or snippet
  rendering, no error-code catalogue, no i18n.
- No warnings system (errors only), no HTML error pages, no live-reload
  error overlay.
- No edits to any `test/*.test.ts` owned by T001–T029; no change to T002's
  exit-code meanings.
- No documentation page for the error format (T035 owns `docs/**` and runs
  in the same batch).
