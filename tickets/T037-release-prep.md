# T037 — Release prep

|            |                                                      |
| ---------- | ---------------------------------------------------- |
| Wave/batch | W5·B3                                                |
| Depends on | T035, T036                                           |
| Blocks     | —                                                    |
| Owns       | `CHANGELOG.md`, `package.json` (version line + `files` field) |
| Size       | M                                                    |

## Goal

Kiln is releasable as `0.1.0`: a Keep-a-Changelog `CHANGELOG.md` covering
all 37 tickets' outcomes grouped by wave, a `package.json` whose `files`
allowlist makes `npm pack` ship exactly the intended files, and proof that
the packed tarball installs globally and runs — `kiln version` reports
`kiln 0.1.0` and a full example-site build works from the installed
package.

## Requirements

- **Semver**: `package.json` `"version": "0.1.0"` — first release, `0.x`
  signals pre-1.0 stability expectations. `src/cli.ts`'s `kiln version`
  (T002) reads this field at runtime, so no code change is needed for the
  version bump; the tarball smoke test proves the wiring.
- **`package.json#files` allowlist** — add exactly:
  `["src", "templates", "assets", "docs", "PLAN.md", "README.md",
  "CHANGELOG.md"]`. Rationale: `src/` is the CLI runtime (commands and
  features are auto-discovered from it); `templates/` and `assets/` are
  read by shipped features (e.g. the search feature copies
  `assets/search.js` relative to its own module); `docs/`, `PLAN.md`,
  `README.md`, `CHANGELOG.md` are linked from the README/docs and ship so
  in-package links resolve. Everything else stays out: `test/`,
  `tickets/`, `site/`, `.github/`, `tsconfig.json`, `.gitignore`
  (npm excludes lockfiles and `node_modules` by rule regardless).
- **`CHANGELOG.md`** in Keep a Changelog shape:
  - `# Changelog` title, then `## [Unreleased]` (empty — everything ships
    in 0.1.0), then `## [0.1.0] - YYYY-MM-DD` with the release day in ISO
    format.
  - The `0.1.0` body is grouped by wave — `### Wave 0 — Foundation`
    through `### Wave 5 — Quality & release` — following PLAN.md's wave
    tables (so T015 sits under Wave 3 and T028 under Wave 4, regardless of
    row order in the index).
  - Exactly one bullet per ticket, ascending ID within each wave, in the
    shape `- **T001 Repo scaffold** — <one-line outcome>` using PLAN.md's
    titles and goals: all of T001–T037 present, no other ticket IDs.
  - Each bullet states the shipped outcome (what a user gets), not the
    ticketing process.
- **Pack smoke test** (the release gate), exact sequence in Verification:
  - `npm pack --dry-run` lists only allowlisted paths — verified by
    grepping the notice output for forbidden prefixes (expected: no
    matches) and for required entries (expected: matches).
  - `npm pack` produces `kiln-0.1.0.tgz`; installed with
    `npm install -g --prefix "$(mktemp -d)" ./kiln-0.1.0.tgz`.
  - From the install prefix: `kiln version` → `kiln 0.1.0`;
    `kiln help` lists all six commands (`build`, `clean`, `help`, `new`,
    `serve`, `version`); and building the example site with the
    **installed** binary — `(cd site && "$PREFIX/bin/kiln" build)` —
    exits 0 with `site/dist/index.html` present. That last step is what
    proves the `files` list is complete: the installed package must carry
    every module, template, and asset the build reads.
  - The tarball and temp prefix are removed afterwards; no `*.tgz` is left
    in the tree.
- Version surface note: the shipped version command is `kiln version`
  (T002's contract). A `--version` flag alias is **not** part of any
  shipped contract and T037 does not edit `src/cli.ts` (not in its
  `Owns`).
- Runs in W5·B3, after T035 (README/docs) and T036 (CI) have landed, so
  the changelog can cite final outcomes and CI is green before the release
  commit.

## Acceptance criteria

- [ ] `package.json` reports version `0.1.0`.
- [ ] `CHANGELOG.md` contains `## [Unreleased]` and
      `## [0.1.0] - <ISO date>`; wave headings Wave 0–Wave 5 all present;
      `grep -oE 'T0[0-3][0-9]' CHANGELOG.md | sort -u | wc -l` → `37`
      (every ticket T001–T037 exactly once, none outside that range).
- [ ] `npm pack --dry-run 2>&1 | grep -E 'test/|tickets/|site/|tsconfig|\.github'`
      produces no output, while `src/cli.ts`, `templates/`, `assets/`,
      `docs/`, `README.md`, `CHANGELOG.md`, `PLAN.md` all appear in the
      listing.
- [ ] `npm install -g --prefix "$PREFIX" ./kiln-0.1.0.tgz` succeeds;
      `"$PREFIX/bin/kiln" version` prints `kiln 0.1.0`;
      `"$PREFIX/bin/kiln" help` lists `build`, `clean`, `help`, `new`,
      `serve`, `version`.
- [ ] `(cd site && "$PREFIX/bin/kiln" build)` exits 0 and
      `site/dist/index.html` exists — the installed package alone
      suffices to build the example site.
- [ ] No `*.tgz` file remains in the working tree after verification.
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
grep -oE 'T0[0-3][0-9]' CHANGELOG.md | sort -u | wc -l     # → 37
npm pack --dry-run 2>&1 | grep -E 'test/|tickets/|site/|tsconfig|\.github'   # expected: no output
npm pack --dry-run 2>&1 | grep -E 'src/cli\.ts|templates/|assets/|docs/|README|CHANGELOG|PLAN'  # intended files present

PREFIX=$(mktemp -d)
npm pack                                                   # → kiln-0.1.0.tgz
npm install -g --prefix "$PREFIX" ./kiln-0.1.0.tgz         # exit 0
"$PREFIX/bin/kiln" version                                 # → kiln 0.1.0
"$PREFIX/bin/kiln" help                                    # lists build, clean, help, new, serve, version
(cd site && "$PREFIX/bin/kiln" build)                      # exit 0; site/dist/index.html exists
rm -f kiln-0.1.0.tgz && rm -rf "$PREFIX"

npm run typecheck && npm test                              # both exit 0
```

## Non-goals

- No `npm publish` (no registry account, no release workflow, no git-tag
  automation — publishing is a manual decision made after this ticket).
- No `--version` CLI flag (`src/cli.ts` belongs to T002), no semver tooling
  (changesets/semantic-release), no changelog-generator bots — bullets are
  written from the 37 tickets.
- No LICENSE file (no license choice is in scope), no provenance/signing,
  no beta/rc versions before `0.1.0`.
- No code changes: only `CHANGELOG.md` and the `version` + `files` fields
  of `package.json`.
