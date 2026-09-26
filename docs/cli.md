# CLI reference

Kiln is a single executable with auto-discovered subcommands: every module
in `src/commands/*.ts` exporting `{ name, run }` becomes a command.

```text
Usage: kiln <command> [args]
```

Inside this repository, run it as `node src/cli.ts <command>` from the
project root; installing the package provides the `kiln` binary.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Failure: bad config, missing/unreadable directories, template or emit errors, failed feature hooks, I/O errors, safety guards. |
| `2` | Usage error: unknown command, unknown flag, missing/invalid argument — the command never runs. |

Running `kiln` with no arguments, or `kiln help`, prints the command
list. An unknown command prints `unknown command '…'` plus the sorted
command list on stderr and exits 2. Command-module discovery failures
(their own fault) exit 1.

## kiln build

```text
usage: kiln build [--drafts] [--future] [--no-cache]
```

Build the site: config → discovery → features → render → emit → assets →
report, written to the configured `outDir` (default `dist/`).

- **Arguments:** none. Any positional token or unknown flag prints the
  usage line to stderr and exits 2 — the build never runs.
- **`--drafts`** — include documents whose frontmatter says
  `draft: true`; without it they are hidden from pages, collections,
  feed, and search (see [publishing](features.md#publishing-and-visibility)).
- **`--future`** — include posts dated later than the build start time;
  without them they stay hidden.
- **`--no-cache`** — skip the incremental build cache entirely: every
  page re-renders (see [dev loop](dev-loop.md#incremental-build-cache)).

The canonical build report (emitted/skipped counts, duration, any feature
errors) prints to stdout. **Exit:** 0 on success; 1 when any stage or
feature fails; 2 on usage errors.

```console
$ kiln build
$ kiln build --drafts --future
$ kiln build --no-cache
```

## kiln clean

```text
usage: kiln clean [--dry-run]
```

Remove the configured output directory (`outDir`, default `dist/`) and
nothing else.

- **Arguments:** none; unknown flags exit 2.
- **`--dry-run`** — list what would be removed and delete nothing.

A hard safety guard resolves the target against the project root and
refuses (error, exit 1, zero deletions) when it would touch the project
root itself, the filesystem root, or anything outside the project tree. A
missing output directory is a success no-op. **Exit:** 0 on success
(and on nothing to do); 1 when the guard refuses or deletion fails; 2 on
usage errors.

```console
$ kiln clean --dry-run
$ kiln clean
```

## kiln help

```text
usage: kiln help
```

Print the command list with one-line descriptions to stdout.

- **Arguments:** none (extra tokens are ignored).
- **Flags:** none.

**Exit:** 0. This is also what runs when `kiln` is invoked with no
command.

```console
$ kiln help
```

## kiln new

```text
usage: kiln new <title> [--dir <pages|posts>]
```

Scaffold a content file with valid frontmatter and a unicode-safe slug
filename; an existing file is never clobbered.

- **Arguments:** `<title>` — required. Every non-flag token is joined
  with spaces into the title; a missing/blank title is a usage error
  (exit 2).
- **`--dir <pages|posts>`** — target collection directory under
  `contentDir`; default `posts`. A missing value or any value other than
  `pages`/`posts` is a usage error (exit 2). `--dir` with an unknown flag
  form (`--anything-else`) is also exit 2.

The file is created at `content/posts/<slug>.md` (or `content/pages/`)
with `title`, an ISO 8601 `date` (build time), and `draft: true`.
**Exit:** 0 on success (prints `created <path>`); 1 if the file already
exists; 2 on usage errors.

```console
$ kiln new "Hello world"
$ kiln new About this site --dir pages
```

## kiln serve

```text
usage: kiln serve [--port <n>]
```

Serve the built site from `outDir` over HTTP, with file watching and SSE
live reload (see [dev loop](dev-loop.md#kiln-serve)).

- **Arguments:** none; unknown flags exit 2.
- **`--port <n>`** — listen port; an integer in 1–65535. Overrides the
  `port` config key (default `4173`) for this run. A missing,
  non-integer, or out-of-range value is a usage error (exit 2).

A built site is a prerequisite: if `outDir` does not exist the command
fails with an error telling you to run `kiln build` first (exit 1) before
binding. An
occupied port fails with an actionable message suggesting a free port
(exit 1). **Exit:** 0 when the server stops cleanly; 1 on those failures;
2 on usage errors.

```console
$ kiln serve
$ kiln serve --port 8080
```

## kiln version

```text
usage: kiln version
```

Print `kiln <version>` (the version from `package.json`) to stdout.

- **Arguments:** none (extra tokens are ignored).
- **Flags:** none.

**Exit:** 0.

```console
$ kiln version
```
