# T002 — CLI skeleton & command discovery

|            |                                                                  |
| ---------- | ---------------------------------------------------------------- |
| Wave/batch | W0·B2                                                            |
| Depends on | T001                                                             |
| Blocks     | T024, T025                                                       |
| Owns       | `src/cli.ts`, `src/commands/help.ts`, `src/commands/version.ts`, `test/cli.test.ts` |
| Size       | M                                                                |

## Goal

A runnable `kiln` CLI that dispatches the first argument to an auto-discovered
command module, prints help and version, and returns meaningful exit codes —
with the discovery seam in place so later tickets add a command by dropping one
file into `src/commands/`.

## Requirements

- `src/cli.ts` starts with `#!/usr/bin/env node`; runs directly under Node 24
  native TS (`node src/cli.ts …`), no build step.
- Command discovery: glob `src/commands/*.ts` next to the CLI using the
  built-in `fs.promises.glob()` (resolve the directory from `import.meta.url`,
  not cwd), `import()` each file, and treat its **named exports**
  `{ name, run }` as the command (`name: string`, `run(args: string[]) =>
  void | Promise<void>`, optional `description?: string` used by help).
- Dispatch: `process.argv.slice(2)`; first token is the command name, remaining
  tokens are passed verbatim to `run(args)`.
- No arguments → print help to stdout, exit 0. `kiln help` does the same.
- `kiln version` prints `kiln <version>` with the version read from
  `package.json`, exit 0.
- Exit codes: `0` success; `1` a command threw (print `kiln: <message>` to
  stderr); `2` unknown command or usage error. If a command sets
  `process.exitCode` itself, the CLI honors it.
- Unknown command → stderr `kiln: unknown command 'bogus'` followed by the
  list of discovered command names, exit 2.
- Malformed command module (missing/ mistyped exports, duplicate `name` across
  files) → stderr message naming the offending file(s), exit 1 — never a
  silent skip.
- Help lists every discovered command as `name` + description (name only when
  `description` is absent), sorted alphabetically, plus a usage line
  `Usage: kiln <command> [args]`.
- T002 creates only `help` and `version` commands. It must NOT create
  `build`, `serve`, `new`, or `clean` — later tickets own those files.

## Acceptance criteria

- [ ] `node src/cli.ts` prints help listing `help` and `version`, exits 0.
- [ ] `node src/cli.ts version` prints `kiln <version>` matching
      `package.json`, exits 0.
- [ ] `node src/cli.ts bogus` writes `unknown command 'bogus'` to stderr and
      exits 2.
- [ ] Auto-discovery proven by test: the test writes a temporary
      `src/commands/__probe.ts` exporting `{ name: '__probe', run }`, asserts
      `node src/cli.ts __probe` runs it, then deletes the file (cleanup runs
      even on assertion failure).
- [ ] A command module exporting a non-function `run` produces an error naming
      that file and exit 1 (covered in `test/cli.test.ts`).
- [ ] `src/cli.ts` contains no imports of `build`/`serve`/`new`/`clean`
      commands and no such files exist under `src/commands/`.
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
node src/cli.ts                 # help text on stdout, exit 0
node src/cli.ts version         # "kiln <version>", exit 0
node src/cli.ts bogus           # stderr: kiln: unknown command 'bogus', exit 2
npm test -- test/cli.test.ts    # unit: discovery, dispatch, exit codes
npm run typecheck && npm test   # both exit 0
```

## Non-goals

- No argument parsing library, no flags/options framework, no config loading
  (T003), no `build`/`serve`/`new`/`clean` commands, no shell completion.
