# T028 — Live reload (SSE)

|            |                                                                |
| ---------- | -------------------------------------------------------------- |
| Wave/batch | W4·B2                                                          |
| Depends on | T026, T027                                                     |
| Blocks     | T035                                                           |
| Owns       | `src/server/reload.ts`, `templates/partials/live-reload.html`, `test/reload.test.ts` |
| Size       | M                                                              |

## Goal

While `kiln serve` runs, every successful watcher rebuild pushes an SSE
`reload` event that makes open browsers refresh exactly once; the connection
survives server restarts with backoff; production build output stays
completely free of the client script.

## Requirements

- `src/server/reload.ts` exports `middleware` in the shape T026's
  `createServer(router)` seam expects. It is picked up automatically by
  `serve.ts`'s `src/server/*.ts` scan — this ticket never edits a file owned
  by T026 or T027.
- SSE endpoint `GET /__reload`: status 200, `Content-Type: text/event-stream`,
  `Cache-Control: no-cache`, connection held open, `: ping` comment every
  25 s; on trigger it emits the named event `reload` (no payload) to every
  connected client; clients are removed from the broadcast set on
  `close`/`error`.
- HTML injection (a middleware in `reload.ts`, not in the static handler):
  applies only to responses whose `Content-Type` is `text/html`; inserts the
  contents of `templates/partials/live-reload.html` immediately before
  `</body>` (appended when absent); exactly once per response even across
  chunked writes; headers stay consistent (no broken `Content-Length`);
  non-HTML responses (css/js/json/…) are untouched.
- `templates/partials/live-reload.html` is the browser client: a `<script>`
  opening `EventSource('/__reload')` with **no reload on the initial
  connection** (page load, or reconnect after a server restart, must never
  loop); on a `reload` event → `location.reload()`; on connection error →
  reconnect with exponential backoff 1 s → 2 s → 4 s → 8 s → capped at 10 s,
  reset after a successful open; no external libraries.
- Watcher wiring: when `serve.ts`'s route scan loads `reload.ts`, module init
  starts T027's watcher exactly once — `startWatching(loadConfig())` from
  `src/watch.ts` — and registers `onAfterRebuild(listener)`; the listener
  broadcasts `reload` only when `ok === true` (a failed rebuild sends
  nothing, so the browser never refreshes into a broken state). If
  `startWatching` throws (no watch roots), print a warning; the server and
  the SSE endpoint still run.
- Restart cycle: killing `kiln serve` while a page is open → the client
  backs off and reconnects silently; no reload happens until a `reload`
  event actually arrives.
- Injection is serve-time only: `kiln build` output on disk never contains
  the script.

## Acceptance criteria

- [ ] `curl -N http://localhost:4173/__reload` returns 200
      `text/event-stream`; after touching a content file the stream shows
      `event: reload` (following the watcher's `rebuild in <N>ms`).
- [ ] A failed rebuild (broken template) sends no `reload` event; fixing it
      and saving again does.
- [ ] `curl -s http://localhost:4173/` returns HTML containing the partial's
      client script exactly once before `</body>`; a `.css` and a `.json`
      response contain no injected script.
- [ ] `dist/index.html` produced by `kiln build` contains no live-reload
      script (grep finds none).
- [ ] Opening the served page in a browser does not itself trigger a reload
      (first connect is silent).
- [ ] Restarting `kiln serve` with a page open: the client reconnects with
      backoff (cap 10 s), does not crash, and reloads only on the next
      rebuild event.
- [ ] Files owned by T026/T027 are byte-identical; only the two owned files
      (plus the test file) are added/changed.
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
node src/cli.ts build && node src/cli.ts serve &
curl -s http://localhost:4173/ | grep -c EventSource   # 1 (injected into HTML)
curl -sN http://localhost:4173/__reload &              # open the stream
# edit a content file -> stream prints `event: reload` after the rebuild line
grep -c EventSource dist/index.html                    # 0 (disk output stays clean)
kill %1 %2
node --test test/reload.test.ts
npm run typecheck && npm test
```

Manual browser check: open `http://localhost:4173/`, save a post → the tab
refreshes once; break a template and save → no refresh.

## Non-goals

- No WebSocket transport; SSE only.
- No CSS-only hot swap or partial DOM patching — full page reload only.
- No cross-tab coordination, no reload suppression windows.
- No injection into non-HTML responses; no build-time embedding of the
  client for production output.
- No edits to any T026- or T027-owned file — everything plugs in through
  `createServer(router)` and `onAfterRebuild`.
