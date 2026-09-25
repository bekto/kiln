# T001 — Repo scaffold

|            |                                              |
| ---------- | -------------------------------------------- |
| Wave/batch | W0·B1                                        |
| Depends on | —                                            |
| Blocks     | T002, T003                                   |
| Owns       | `package.json`, `tsconfig.json`, `.gitignore`, `test/smoke.test.ts` |
| Size       | S                                            |

## Goal

An npm package named `kiln` that type-checks and runs its own test suite from a
fresh clone, with git initialized.

## Requirements

- `package.json`: name `kiln`, `"type": "module"`, `bin.kiln` → `src/cli.ts`
  with a shebang, Node engine `>=24`.
- devDependency `typescript@7` (pinned exact).
- `tsconfig.json`: `strict: true`, `module: nodenext`, `allowImportingTsExtensions`
  with `noEmit` (Node runs TS directly via type-stripping; no build step).
- npm scripts: `typecheck` (`tsc --noEmit`), `test` (`node --test`),
  `pretest` runs typecheck.
- `.gitignore`: `node_modules/`, `dist/`.
- One placeholder test asserting `1 + 1 === 2` so the harness is proven green.

## Acceptance criteria

- [ ] `npm install` completes with only `typescript@7` as a dependency.
- [ ] `npm run typecheck` exits 0.
- [ ] `npm test` exits 0 and reports ≥ 1 passing test.
- [ ] `git log` exists (initial commit).

## Verification

```bash
npm run typecheck && npm test   # both exit 0
```

## Non-goals

- No CLI implementation, no app code — T002 starts there.
