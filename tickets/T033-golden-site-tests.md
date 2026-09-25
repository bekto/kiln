# T033 — Golden-site snapshot tests

|            |                    |
| ---------- | ------------------ |
| Wave/batch | W5·B1              |
| Depends on | T013–T023 (all of W3) |
| Blocks     | T036               |
| Owns       | `test/golden/**`   |
| Size       | L                  |

## Goal

A committed fixture site under `test/golden/site/` exercises the whole of
Wave 3 end-to-end; `test/golden/golden.test.ts` builds it into a temp
directory and compares the produced `dist/` tree against committed expected
files — a byte-level regression suite that fails loudly, naming every added,
removed, and changed path when output drifts.

## Requirements

### Fixture (`test/golden/site/`)

- `kiln.config.ts` — a **pure default-export object with no side effects**.
  Grounded constraint (verified on Node 24.21.0): `node --test` executes
  every `.ts` file under `test/` as a test file, so this config *will* be
  loaded by the runner; it must load cleanly and define no tests.
  It is the only `.ts` file allowed under `test/golden/`, and **no
  `.js`/`.mjs`/`.cjs` file may exist anywhere under `test/golden/`** (the
  runner executes those too — verified: a stray `.js` runs, a throwing
  `.ts` fails the whole suite).
- Config contents: `site: { title: 'Golden site', url: 'https://golden.example.com' }`
  (absolute URL — T018's hard requirement), feature keys
  `pagination.pageSize: 2`, `toc.depth: 3`, `feed.limit: 10`; every other
  feature (publish, taxonomy, highlight, sitemap, excerpt, readingTime,
  related, search) runs on its defaults.
- `content/` (membership per T008: `posts/` prefix → posts collection):
  - `index.md` — the home list (paginated).
  - `about.md` — a static page.
  - `posts/first.md` — date `2024-01-01`, `tags: [alpha]`, a fenced
    `ts` code block (exercises T016), two `##` headings (TOC/anchors).
  - `posts/second.md` — `2024-02-02`, `tags: [alpha, beta]`, frontmatter
    `excerpt:` override (T020).
  - `posts/third.md` — `2024-03-03`, `tags: [beta]`.
  - `posts/hello-世界.md` — `2024-04-04`, `tags: [gamma]`, unicode filename
    → URL `/posts/hello-世界/`, unicode title `你好，世界！ 🎉` (T005/T010
    unicode paths).
  - `posts/fifth.md` — `2024-05-05`, `tags: [alpha]`.
  - `posts/drafted.md` — `draft: true`, `2024-06-06`, `tags: [alpha]` —
    hidden unless `--drafts` (T013).
  - `posts/future.md` — `date: 2999-12-31`, `tags: [beta]` — always in the
    future (time-stable forever), hidden unless `--future`.
  - Five published posts with `pageSize: 2` → the home list spans ≥ 2
    pages; three tags (`alpha`, `beta`, `gamma`) → three tag archives.
- `templates/` — minimal `base.html` + `post.html` + `index.html` using
  layout inheritance and one partial include; markup must contain nothing
  time- or environment-dependent (no `new Date()`, no absolute paths).
- No `public/` (assets are covered by feature-written files below), no
  `dist/` ever written inside the fixture tree — builds happen in a temp
  copy.
- All post dates are distinct and frontmatter-only, so ordering
  (T008: date desc, tie → path asc) is a total order.

### Test (`test/golden/golden.test.ts`)

- Copies `test/golden/site/` into `fs.mkdtemp(...)`, spawns
  `node <repo>/src/cli.ts build` with cwd = the temp copy, and — if the
  build exits non-zero — fails immediately showing the CLI's captured
  stderr (never a misleading diff for a failed build). The committed
  fixture tree is never mutated.
- Snapshot comparison against `test/golden/expected/` (committed files,
  no snapshot library, no new dependencies — plain `node:fs` +
  `node:test`):
  - **Tree**: sorted relative path lists (default string sort — UTF-16
    code-unit order, deterministic) must be equal.
  - **Contents**: every expected file byte-compared against its produced
    counterpart; any difference fails.
  - **One exception**: `dist/assets/*.js` is *not* stored under
    `expected/` (the runner would execute committed `.js` files — see
    constraint above); instead those files are byte-compared against
    their source files in the repo (e.g. `dist/assets/search.js` vs
    `assets/search.js`), which is exactly T023's copy contract.
- Semantic assertions (in addition to the snapshot):
  1. **Feed**: `dist/feed.xml` is well-formed XML (a small in-test
     tag-balance scanner — no dependencies), root element `<feed>`, exactly
     5 `<entry>` (published count), every entry `<link href>` resolves to a
     file in `dist/`, and no hidden slug appears in it.
  2. **Sitemap**: every `<loc>` resolves (case-sensitively) to an emitted
     file; no hidden slug appears; the exact URL set is pinned by the
     snapshot.
  3. **No draft leakage**: recursive byte-scan of *all* of `dist/` (HTML,
     feed, sitemap, `search-index.json`, assets) for the slugs `drafted`
     and `future` → zero hits.
  4. `dist/posts/hello-世界/index.html` exists (unicode path).
  5. `first` post's HTML contains an `hljs` token span (T016 ran).
  6. Pagination produced at least one list page beyond `/index.html`
     (exact paths pinned by the snapshot).
  7. **Determinism**: building the fixture a second time yields a
     byte-identical tree (no build timestamps leaked into output).
- Failure message is loud and structural:

```text
golden mismatch:
  + posts/new/index.html              (in dist, not in expected)
  - posts/old/index.html              (in expected, not in dist)
  ~ index.html                        (content differs)
run UPDATE_GOLDEN=1 npm test -- test/golden/golden.test.ts to refresh
```

- `UPDATE_GOLDEN=1 npm test -- test/golden/golden.test.ts` rewrites
  `test/golden/expected/` from a fresh temp build (stale files deleted).
  Refresh is always explicit — never automatic on failure.
- The test is self-contained (own temp dirs, no shared state) so it stays
  safe while `node --test` runs other test files concurrently.

## Acceptance criteria

- [ ] `npm test -- test/golden/golden.test.ts` passes; afterwards no
      `dist/` exists under `test/golden/site/` (only temp dirs were used).
- [ ] Tree + content mismatch → exit 1 with the `golden mismatch` block
      listing `+`/`-`/`~` paths (demonstrated by planting a stray
      `expected/bogus.html`, then removing it).
- [ ] Feed assertions pass: well-formed, `<feed>` root, 5 entries, entry
      links resolve, no hidden slugs.
- [ ] Sitemap assertions pass: every `<loc>` exists in `dist/`, no hidden
      slugs.
- [ ] Zero occurrences of `drafted`/`future` slugs anywhere in `dist/`.
- [ ] Unicode post emitted at `dist/posts/hello-世界/index.html`; `hljs`
      spans present; ≥ 2 list pages emitted.
- [ ] Two consecutive builds are byte-identical (determinism check green).
- [ ] `UPDATE_GOLDEN=1` refresh flow works: refresh, then a plain run is
      green again.
- [ ] No `.js`/`.mjs`/`.cjs` under `test/golden/`; the fixture's
      `kiln.config.ts` is side-effect-free (suite green proves it — the
      runner loads it as a file).
- [ ] `npm run typecheck && npm test` green; no new dependencies in
      `package.json`.

## Verification

```bash
npm test -- test/golden/golden.test.ts            # fixture builds in temp; snapshot + semantic asserts pass
npm test -- test/golden/golden.test.ts            # rerun: deterministic, still green
touch test/golden/expected/bogus.html
npm test -- test/golden/golden.test.ts            # exit 1: "- bogus.html" in the mismatch block
rm test/golden/expected/bogus.html
npm test -- test/golden/golden.test.ts            # green again
npm run typecheck && npm test                     # both exit 0
```

## Non-goals

- No snapshot/testing libraries and no new dependencies (committed expected
  files + `node:test` only); no auto-refresh on failure (explicit
  `UPDATE_GOLDEN=1` only).
- No coverage of `kiln serve`/watch/live-reload/build-cache (W4) — this
  suite exercises `kiln build` only; no coverage of `site/` (T034's).
- No browser/visual regression, screenshots, or performance benchmarks.
- No failure-path fixtures (broken templates/config) — error behavior is
  T031's contract; this site is healthy by construction.
- No `--drafts`/`--future` variant builds; no cross-OS normalization (LF
  output, Linux CI only).
