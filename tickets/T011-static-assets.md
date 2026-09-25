# T011 — Static asset passthrough

|            |                                          |
| ---------- | ---------------------------------------- |
| Wave/batch | W2·B1                                    |
| Depends on | T003                                     |
| Blocks     | T012                                     |
| Owns       | `src/render/assets.ts`, `test/assets.test.ts` |
| Size       | M                                        |

## Goal

Everything under `public/` is copied into `dist/` verbatim — unchanged files
skipped by mtime, an opt-in content-hash bust mode, and emitted HTML never
clobbered by a copied file.

## Requirements

- Export from `src/render/assets.ts`:
  - `copyAssets(options?: AssetOptions): Promise<AssetReport>` with
    `AssetOptions { publicDir?: string /* default 'public' */; distDir?:
    string /* default 'dist' */; emitted?: ReadonlySet<string>;
    hashBust?: boolean /* default false */ }`.
  - `AssetReport { copied: string[]; skipped: string[]; collisions: string[];
    rewritten: number }` — path lists are dist-relative POSIX; `rewritten`
    counts HTML files whose references changed.
- Enumeration: `fs.promises.glob()` (async iterator) over
  `<publicDir>/**/*`, filtered to regular files; every file is copied
  (literal mirror — dotfiles like `.nojekyll` included, no exclusion globs),
  directory structure preserved. Symlinked directories are not descended;
  a broken symlink (target unreadable) lands in `skipped`, never an error.
- Copy semantics: `fs.cp` with `preserveTimestamps: true`, so a copied file's
  mtime equals its source's and the mtime comparison below is stable.
- Missing `publicDir` or zero files → resolves with an all-zero report
  (success — an asset-less site is normal).
- Unchanged skip: destination exists with `mtimeMs >= source mtimeMs` →
  `skipped` (no copy). Otherwise → copy → `copied`. (mtime-based by design;
  content-hash invalidation is T029's layer.)
- Emitted collision: a source whose dist-relative target is in `emitted` →
  `collisions`, NOT copied — a static `public/index.html` must never
  overwrite the emitted page (non-fatal; the build continues). Note: this
  guard only protects the copy step — hash-bust reference rewriting is
  allowed to edit emitted HTML's `src`/`href` attributes in place (that is
  not clobbering).
- Hash-bust mode (`hashBust: true`, opt-in): each source is copied to
  `name.<8 hex sha256 of file content>.ext`; after the copy phase, rewrite
  root-relative exact references (`src="/app.js"`, `href="/app.js"`) in
  `dist/**/*.html` to the hashed names — only for assets copied this run,
  only when the HTML's bytes actually change (`rewritten` counts changed
  files; a second identical run rewrites 0). External URLs, non-matching
  paths, and references to files outside `public/` are untouched. The mtime
  skip applies to the hashed destination (content hash is always computed).
- Write failures (dist path occupied by a file, EACCES, ENOSPC) → rejects
  with an error naming the failing path.
- Config note: `kiln build` reads `config.assets.hashBust` (default `false`);
  this key is a known key of `src/config.ts` as specified in T003 — no
  coordination needed. `copyAssets` itself takes no config dependency.

## Acceptance criteria

- [ ] Fixture `public/{style.css, img/logo.png, .nojekyll}` → all three
      exist under `dist/` with identical bytes (`cmp`), `copied` lists them.
- [ ] Immediate second run → `copied` empty, `skipped` lists all three;
      touching one source → exactly that file recopied.
- [ ] Missing `public/` → resolves all-zero report (no throw).
- [ ] `emitted` containing `index.html` while `public/index.html` exists →
      `collisions` lists `index.html`, and `dist/index.html` keeps the
      emitted bytes unchanged.
- [ ] `hashBust: true` → `app.<hash>.js` in `dist/`; a fixture HTML with
      `src="/app.js"` is rewritten to the hashed name; a second run reports
      `rewritten: 0` and leaves HTML bytes stable; `src="/not-copied.js"`
      untouched.
- [ ] Destination path occupied by a regular file (e.g. `dist` is a file)
      → rejects with an error naming that path.
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
npm test -- test/assets.test.ts    # mirror, mtime skip, collision, hash-bust rewrite, error shape
npm run typecheck && npm test      # both exit 0
```

## Non-goals

- No exclusion/glob options for `public/`, no pruning of stale assets from
  previous builds (`kiln clean`, T025), no rewriting inside CSS `url()` or
  JS, no emitted manifest file, no minification/optimization/fingerprinting
  beyond the hash-bust rename, no content-hash skip cache (T029), and no
  edit to `src/config.ts` itself (T003 owns it and already declares
  `assets.hashBust` — see the config note).
