# T036 — CI workflow

|            |                                     |
| ---------- | ----------------------------------- |
| Wave/batch | W5·B2                               |
| Depends on | T033                                |
| Blocks     | T037                                |
| Owns       | `.github/workflows/ci.yml`          |
| Size       | S                                   |

## Goal

Every push and pull request runs a GitHub Actions workflow that type-checks,
runs the full test suite, and builds the example site on Node 24, uploading
`site/dist` as a downloadable artifact — using only GitHub-maintained
`actions/*`, no third-party or marketplace actions.

## Requirements

- Single workflow file `.github/workflows/ci.yml`, `name: CI` (T035's
  README badge points at `actions/workflows/ci.yml/badge.svg`).
- Triggers: `on: [push, pull_request]` — every branch, no path filters, no
  cron.
- Runner: `ubuntu-latest` only. Node 24 only: the `test` job uses a matrix
  whose single entry is `24` (`strategy.matrix.node-version: [24]`) so a
  future Node version is added by appending one list element; the
  `build-site` job pins `node-version: '24'` directly.
- Job `test` (steps in order):
  1. `actions/checkout@v4`
  2. `actions/setup-node@v4` with `node-version: ${{ matrix.node-version }}`
  3. `npm install` — deliberately not `npm ci`: T001 does not mandate a
     committed `package-lock.json`, and `npm ci` hard-fails without one.
  4. `npm run typecheck`
  5. `npm test`
- Job `build-site` (steps in order):
  1. `actions/checkout@v4`
  2. `actions/setup-node@v4` with `node-version: '24'`
  3. `npm install`
  4. `cd site && node ../src/cli.ts build` — the same command the README
     quickstart (T035) and example-site ticket (T034) document.
  5. `actions/upload-artifact@v4` with `name: example-site`,
     `path: site/dist`.
- Action allowlist — the complete set of `uses:` references in the file:
  `actions/checkout@v4`, `actions/setup-node@v4`,
  `actions/upload-artifact@v4`. Rationale stated in the file's header
  comment: only GitHub-maintained `actions/*` are permitted;
  `upload-artifact` is required by this ticket's artifact deliverable;
  no marketplace/third-party actions (no coverage, lint, caching, or
  deployment actions), no `services:`, no external containers.
- No dependency caching (`actions/cache`, setup-node's `cache:` input) —
  `npm install` is the cache. No `permissions:` customization (workflow
  needs nothing beyond defaults: read contents, write artifacts).
- Both jobs must pass from a clean checkout; every command in the workflow
  is run locally first (see Verification) so CI red always means a real
  regression, not an untested workflow line.
- Since T034 and T033 land in W5·B1 and this ticket is W5·B2, `site/` and
  `test/golden/**` already exist when this workflow first runs; the
  workflow itself does not depend on their content beyond building
  `site/`.

## Acceptance criteria

- [ ] `npx --yes js-yaml .github/workflows/ci.yml` parses the file
      (exit 0, printed document on stdout).
- [ ] `grep -c 'uses:' .github/workflows/ci.yml` → `5` (checkout +
      setup-node in each of two jobs, plus one upload-artifact), and every
      `uses:` line matches exactly one of the three allowlisted
      `actions/*@v4` references — no other action appears.
- [ ] The parsed workflow has both `push` and `pull_request` triggers, the
      two jobs `test` and `build-site`, `node-version` matrix `[24]`, and
      the artifact upload with `name: example-site`, `path: site/dist`.
- [ ] The exact workflow command sequences run green locally:
      `npm install && npm run typecheck && npm test` and
      `cd site && node ../src/cli.ts build`, all exit 0.
- [ ] After landing: the Actions run for a push and for a PR shows both
      jobs green, and the `example-site` artifact contains
      `site/dist/index.html` (observable on GitHub once pushed).

## Verification

```bash
npx --yes js-yaml .github/workflows/ci.yml >/dev/null  # exit 0 = well-formed YAML
grep -c 'uses:' .github/workflows/ci.yml               # → 5
grep 'uses:' .github/workflows/ci.yml                  # only actions/checkout@v4, actions/setup-node@v4, actions/upload-artifact@v4
npm install && npm run typecheck && npm test           # the test job's commands, exit 0
(cd site && node ../src/cli.ts build)                  # the build-site job's command, exit 0
```

Final proof is the GitHub Actions run itself (push + PR): both jobs green,
`example-site` artifact downloadable with the built site inside.

## Non-goals

- No npm publish job, no release automation, no deployment (GitHub Pages,
  Netlify, etc.), no cron/schedule triggers.
- No coverage reporting, lint/format services, code scanning, or any
  third-party/marketplace action; no SHA-pinning beyond the `@v4` tags
  (no Dependabot config in scope).
- No Windows/macOS runners, no Node versions other than 24, no
  cache/`services:` configuration.
- No changes outside `.github/workflows/ci.yml` — the workflow only
  orchestrates commands owned by other tickets.
