# Dev loop

Kiln's developer experience is one command — `kiln serve` — backed by a
file watcher, SSE live reload, and an incremental build cache. This page
ties them together; flag reference lives in the
[CLI reference](cli.md).

## kiln serve

```text
usage: kiln serve [--port <n>]
```

Serves the built output directory (`outDir`, default `dist/`) over
`node:http` with correct MIME types, a directory fallback, and
`dist/404.html` as the not-found page when present.

- **Build first:** if `outDir` does not exist the command fails before
  binding, telling you to run [`kiln build`](cli.md#kiln-build) — never a
  server that 404s every request.
- **Port:** the `port` config key (default `4173`) unless `--port <n>`
  overrides it for the run (an integer in 1–65535). An occupied port
  fails with an actionable message suggesting a free one.
- **On start** it also wires up watching and live reload (below), so the
  server prints `serving dist/ at http://localhost:<port>` and your
  browser stays in sync while you edit.

## File watcher

Started automatically as part of `kiln serve` (middleware discovered
from `src/server/*.ts`; the watcher itself is `src/watch.ts`):

- **Roots:** `contentDir`, `templatesDir`, and `publicDir` — watched
  recursively. A missing root is warned about and skipped (the others
  stay watched); no root at all disables watching with a warning, and the
  server keeps running. `outDir` is never watched, so writing build
  output can never retrigger a rebuild (no loops); editor noise
  (`*~`, `*.swp`, `*.tmp`, `*.part`) never reaches the timer.
- **Debounce:** one trailing-edge window spans *all* roots —
  `watch.debounceMs` (default `100`) — so a burst of saves across any
  directories coalesces into exactly one rebuild, and each new event
  resets the window.
- **Rebuilds** call the build directly (never the CLI): config is
  reloaded every time, so editing `kiln.config.ts` takes effect on the
  next rebuild. Events arriving mid-rebuild set one queued flag; when
  the running rebuild finishes it starts exactly one follow-up, however
  many events piled up.
- **Failures don't kill the loop:** a failed rebuild prints
  `rebuild failed in <N>ms: <message>` to stderr, the watcher keeps
  running, and the next change retries. After a successful rebuild,
  output files whose source disappeared are removed from `dist/`.

## Live reload (SSE)

The browser half is automatic while serving:

- The server exposes `GET /__reload` — a `text/event-stream` endpoint
  with keep-alive pings — and injects its client script
  (`templates/partials/live-reload.html`) into every HTML response it
  serves.
- The client holds the stream open; when a rebuild succeeds, the server
  broadcasts one `reload` event to every connected client and the
  browser refreshes the page. Rebuilds that fail leave the page alone —
  you see the error on the server's stderr instead of a blank reload.
- No polling, no dependencies: plain `node:http` middleware picked up by
  the server's router scan.

## Incremental build cache

`kiln build` keeps a content-hash cache at `dist/.kiln-cache.json`
(written through on every successful emit):

- **Per page:** the SHA-256 of the source file's bytes — unchanged
  pages skip render and write when their target already exists (they
  are counted as `skipped` in the build report). Feature-appended pages
  (pagination overflow, taxonomy archives) hash their own render inputs
  instead.
- **Global — any mismatch discards every entry (full rebuild):** the
  sorted `src/features/*.ts` list hashed with module code, the effective
  config (minus runtime-only `root`/`port`/`watch`), the `drafts` and
  `future` build flags, and every file under `templatesDir`.
- **`--no-cache`** on [`kiln build`](cli.md#kiln-build) skips the cache
  entirely — nothing is read or written, every page re-renders.
- **Never fatal:** a missing, corrupt, or wrong-shape cache file is
  silently discarded and rebuilt; a stale or lying cache can never leave
  a hole (a page is only skipped when its target file exists).

## kiln clean

```text
usage: kiln clean [--dry-run]
```

Removes the configured output directory — including the cache file — and
nothing else. `--dry-run` lists what would go without deleting; a
missing output directory is a success no-op. A hard guard refuses to
touch the project root, the filesystem root, or anything outside the
project tree (error, exit 1, zero deletions). Full reference:
[`kiln clean`](cli.md#kiln-clean).

When to clean: after changing something the cache intentionally
invalidates it anyway (templates, config, features), so `kiln clean` is
for wholesale resets — benchmarking, publishing a pristine `dist/`, or
suspecting stray output files.
