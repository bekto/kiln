# T026 — Dev server

|            |                                                              |
| ---------- | ------------------------------------------------------------ |
| Wave/batch | W4·B1                                                        |
| Depends on | T012                                                         |
| Blocks     | T028, T035                                                   |
| Owns       | `src/commands/serve.ts`, `src/server/static.ts`, `test/serve.test.ts` |
| Size       | M                                                            |

## Goal

`kiln serve` statically serves the built `dist/` directory over Node's
built-in `node:http` on the configured port, with correct MIME types, pretty
directory/`index.html` resolution, a 404 page, and an actionable error when
the port is taken — and nothing else: no watching, no reloading.

## Requirements

- Command module `src/commands/serve.ts` exporting `{ name: 'serve', run }`
  where `run(args: string[])` receives raw argv tokens after the command name
  (T002 contract) and recognizes `--port <n>`; unknown tokens → usage error →
  exit 2 (never edits `src/cli.ts`), plus `src/server/static.ts` holding the
  HTTP logic.
- `node:http` only — no Express or any other dependency.
- Serves files rooted at config `outDir` (T003 loader, default `dist/`). Any
  request path that normalizes outside that root (`..`, `%2e%2e` encodings)
  → 404; never reads a byte outside `outDir`.
- Route resolution order: exact file → serve it; directory without trailing
  slash → `301` redirect to `path/`; directory with slash → serve the
  `index.html` inside it; extensionless path where `<path>.html` exists →
  serve that file; nothing matches → 404.
- MIME map (at minimum): `.html` → `text/html; charset=utf-8`, `.css` →
  `text/css; charset=utf-8`, `.js` → `text/javascript; charset=utf-8`,
  `.json` → `application/json`, `.svg` → `image/svg+xml`, `.woff2` →
  `font/woff2`, `.png` → `image/png`, `.jpg`/`.jpeg` → `image/jpeg`;
  unknown extension → `application/octet-stream`.
- 404: if `dist/404.html` exists, serve it with status 404 and the HTML
  content type; otherwise respond with status 404 and the plain body
  `404 Not Found`.
- Port: config key `port` (number, default 4173) resolved via `loadConfig()`
  — `port` is a known key of `src/config.ts` as specified in T003.
  `--port <n>` overrides per run; a non-integer or out-of-range
  value → usage error naming `--port`, exit 2.
- `EADDRINUSE` → friendly, actionable error: throw so the CLI prints `kiln:
  port 4173 is already in use — pick another with kiln serve --port 4174`
  (naming the actual port and the override), exit 1; no raw stack trace,
  process does not hang.
- `dist/` missing → throw an error telling the user to run `kiln build`
  first (CLI prints `kiln: <message>`), exit 1.
- On success print `serving <outDir> at http://localhost:<port>`.
- Registration seam (the contract for T028): `static.ts` exports
  `createServer(router)` where `router` is an ordered list of middleware
  `(req, res, next)` executed before the built-in static handler — each
  middleware either responds or calls `next()`. `serve.ts` builds the list
  by scanning `src/server/*.ts` at startup (skipping `static.ts`) and
  importing each module's exported `middleware` array via runtime-built
  specifiers (so a module that doesn't exist is simply skipped); modules
  without `middleware` are ignored. This mirrors the T002 command
  auto-discovery style and is proven with a test-registered middleware.
- Explicitly static in this ticket: no file watching, no SSE endpoint, no
  HTML injection (T027/T028 own those).

## Acceptance criteria

- [ ] On a built site, `GET /` returns 200 with `text/html; charset=utf-8`
      and the body of `dist/index.html`; `GET /posts/` (dir with slash)
      serves `dist/posts/index.html`.
- [ ] `GET` for `.css`, `.js`, `.json`, `.svg`, `.woff2`, `.png`, `.jpg`
      fixtures returns each exact content type from the map; an unknown
      extension returns `application/octet-stream`.
- [ ] `GET /nope` → 404; with `dist/404.html` present it is served (status
      still 404); without it the `404 Not Found` body appears.
- [ ] `GET /../../etc/passwd` and `GET /%2e%2e/%2e%2e/etc/passwd` → 404, no
      external file bytes in the response.
- [ ] Listens on 4173 by default; `--port 5000` moves it (observable via
      fetch).
- [ ] With a listener already bound to the port, `kiln serve` exits 1 with a
      message naming 4173 and suggesting `--port`.
- [ ] Without `dist/` → exit 1 with a message mentioning `kiln build`.
- [ ] The `createServer(router)` seam is proven: a middleware registered
      through the seam answers for its route instead of the static handler.
- [ ] Editing files under `content/` while serving causes no rebuild and no
      response change (watching is out of scope here).
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
node src/cli.ts build
node src/cli.ts serve &                      # prints "serving dist/ at http://localhost:4173"
curl -sI http://localhost:4173/              # HTTP 200, content-type: text/html; charset=utf-8
curl -sI http://localhost:4173/nope          # HTTP 404
node src/cli.ts serve                        # second instance -> error naming 4173 + --port hint, exit != 0
kill %1
node --test test/serve.test.ts
npm run typecheck && npm test
```

## Non-goals

- No watching or incremental rebuild (T027), no SSE/live reload/HTML
  injection (T028).
- No directory listings, gzip/compression, TLS, CORS, proxy/API routes.
- No Express or other HTTP framework; no configurable 404 template path.
