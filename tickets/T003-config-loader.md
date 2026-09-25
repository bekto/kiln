# T003 — Config loader

|            |                                              |
| ---------- | -------------------------------------------- |
| Wave/batch | W0·B2                                        |
| Depends on | T001                                         |
| Blocks     | T004, T005, T011, T024                       |
| Owns       | `src/config.ts`, `test/config.test.ts`       |
| Size       | M                                            |

## Goal

`loadConfig()` imports a project-local `kiln.config.ts` natively (no build
step), merges it over documented defaults, validates the known keys with
errors that name the exact key, and returns a frozen config whose `features`
map is passed through untouched for features to validate later.

## Requirements

- Export `const CONFIG_FILENAME = 'kiln.config.ts'` and
  `function loadConfig(root?: string): Promise<KilnConfig>`; `root` defaults
  to `process.cwd()` and is the only directory searched (no upward walk).
- `KilnConfig` shape (all fields documented, no feature-specific keys —
  concurrency rule 4):
  - `root: string` — absolute project root.
  - `contentDir`, `templatesDir`, `publicDir`, `outDir: string` — absolute
    paths; relative values in the config resolved against `root`, absolute
    values kept as-is.
  - `site: { title: string; url: string; description?: string }`.
  - `port: number` — dev-server port, default `4173` (consumer: T026).
  - `watch: { debounceMs: number }` — default `100` (consumer: T027);
    `watch` merged key-wise over its defaults like `site`.
  - `assets: { hashBust: boolean }` — default `false` (consumer: T011);
    `assets` merged key-wise over its defaults like `site`.
  - `features: Record<string, unknown>` — open map; T003 never validates or
    reshapes its contents.

  These three top-level keys are coordinated with their consumer tickets
  (T011/T026/T027) so they are known keys here from the start — later
  tickets never need to edit `src/config.ts`.
- Defaults when the file is absent (silent — no warning) or keys are omitted:
  `contentDir: 'content'`, `templatesDir: 'templates'`, `publicDir: 'public'`,
  `outDir: 'dist'`, `site.title: 'Kiln site'`, `site.url:
  'http://localhost:8080'`, `port: 4173`, `watch.debounceMs: 100`,
  `assets.hashBust: false`, `features: {}`. `site`, `watch`, and `assets` are
  merged key-wise over their
  defaults; a user-provided `features` object is stored verbatim (same
  reference, deep contents untouched).
- Import mechanism: dynamic `import()` of a `pathToFileURL()`-resolved path —
  Node 24 type-stripping runs the `.ts` config directly; the config file
  **default-exports a plain object**.
- Validation of known keys (only known keys are checked; unknown top-level
  keys are ignored, reserved for later tickets):
  - `site` must be an object; `site.title`/`site.url`/`site.description` must
    be strings when present.
  - `port` must be an integer in `1..65535`; `watch` must be an object with
    `debounceMs` a positive number; `assets` must be an object with `hashBust`
    a boolean.
  - `contentDir`/`templatesDir`/`publicDir`/`outDir` must be strings.
  - `features` must be a plain object (not array/null).
- Error messages all begin with `kiln.config.ts:` and name the key path, the
  expected type, and the actual type — e.g. `kiln.config.ts: "outDir" must be
  a string (got number)`. `loadConfig` throws `Error`; the CLI (T002) surfaces
  it as `kiln: <message>` with non-zero exit.
- File exists but has no default export, or the default export is an
  array/function/primitive → `kiln.config.ts: must default-export an object
  (got <type>)`.
- Config file with a syntax error or that throws during evaluation → error
  message includes the config file path plus the original error message.
- Returned config is frozen at the top level and for `site` (runtime
  `Object.freeze`); `features` is left alone (features own it).

## Acceptance criteria

- [ ] No `kiln.config.ts` → resolves with defaults: `outDir` ends in `/dist`,
      `site.title === 'Kiln site'`, `features` deep-equals `{}`.
- [ ] A config setting `outDir: 'build'` and `site: { title: 'My site' }` →
      `outDir` is absolute `<root>/build`, `site.title === 'My site'`, and
      `site.url` keeps the default.
- [ ] `features: { highlight: { theme: 'x' } }` round-trips deep-equal with no
      validation of inner keys (verified against the exact nested object).
- [ ] `outDir: 123` → throws with message containing `"outDir"`, `string`,
      and `number`.
- [ ] `features: 'nope'` → throws with message containing `"features"`.
- [ ] Defaults include `port === 4173`, `watch.debounceMs === 100`,
      `assets.hashBust === false`.
- [ ] `port: 70000` → throws with message containing `"port"`; `watch:
      { debounceMs: 'x' }` → throws naming `"watch.debounceMs"`; `assets:
      { hashBust: 1 }` → throws naming `"assets.hashBust"`.
- [ ] Default export is an array → throws with `kiln.config.ts` and
      `default-export` in the message.
- [ ] A config file containing a syntax error → thrown message includes the
      config file path.
- [ ] Returned config: mutating `config.site.title` in a test throws in
      strict mode (frozen).
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
npm test -- test/config.test.ts   # unit: defaults, overrides, passthrough, 4 error cases
npm run typecheck && npm test     # both exit 0
```

## Non-goals

- No feature-specific config keys or validation (each feature validates its
  own slice later); no CLI flags; no watching/reloading of the config file; no
  config search up the directory tree; no JSON/YAML config formats.
