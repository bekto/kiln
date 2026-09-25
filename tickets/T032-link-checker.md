# T032 — Internal link checker

|            |                                                       |
| ---------- | ----------------------------------------------------- |
| Wave/batch | W5·B1                                                 |
| Depends on | T012                                                  |
| Blocks     | —                                                     |
| Owns       | `src/features/linkCheck.ts`, `test/linkCheck.test.ts` |
| Size       | M                                                     |

## Goal

After every build, all emitted HTML is scanned for internal `href`/`src`
links and same-page/cross-page `#anchors`; any target that does not exist in
`dist/` (or any fragment with no matching `id`) fails the build with one
aggregated list of `source page → broken target` entries — while external
URLs are never fetched, so the check works fully offline.

## Requirements

- Feature module `src/features/linkCheck.ts` exporting a `Feature` whose
  `onBuildEnd` reads every `dist/**/*.html` file and checks it. Non-HTML
  outputs are not scanned.
- Before extracting links, strip raw-text regions — HTML comments,
  `<pre>…</pre>`, `<code>…</code>`, `<script>…</script>` — so escaped
  samples (e.g. `<code>&lt;a href="/fake/"&gt;</code>`) and JS string
  literals never produce phantom links.
- Extraction: quoted attribute values only — `href="…"`, `href='…'`,
  `src="…"`, `src='…'` (our emitter always quotes attributes; unquoted
  values are ignored).
- Classification:
  - Never fetched / never checked: `http:`, `https:`, protocol-relative
    `//host/…`, `mailto:`, `tel:`, `javascript:`, `data:` — skipped
    entirely (offline by construction; the feature source contains no
    `fetch`, no `node:http(s)` import — asserted in verification).
  - Fragment-only (`#sec`) → same-page anchor check against the current
    file.
  - Everything else (`/…`, `./…`, `../…`, bare relative) → internal.
- Resolution:
  - Normalize relative hrefs against the containing page's emitted URL
    with the WHATWG `URL` API (dummy origin base), then take `pathname`.
  - Drop any `?query` before resolving; split off `#fragment` first and
    handle it separately.
  - Map pathname → output file using T005's helpers: directory-style URLs
    (and extensionless paths) go through `filePathForUrl` from
    `src/content/slug.ts` (`/tags/foo/` → `tags/foo/index.html`,
    `/about` → `about/index.html`), and targets whose last segment contains
    a `.` (`/feed.xml`, `/sitemap.xml`, `/search-index.json`,
    `/images/x.png`) are exact file paths under `dist/`. No second,
    hand-rolled pretty-path mapping.
  - Existence is case-sensitive (Linux/CI filesystem semantics):
    `/About/` when only `/about/` was emitted is broken.
- Anchor check: a fragment on an HTML target requires `id="…"` (heading IDs
  from T017) or `<a name="…">` in the target file; fragment-only links are
  checked against the current page. Fragments are compared after
  `decodeURIComponent` (guarding malformed escapes → compare literally),
  so unicode heading ids work. A fragment on a non-HTML target (e.g.
  `/feed.xml#x`) is existence-only.
- Reporting: the scan **always completes** (no fail-fast), then if any
  broken links exist the build fails with one aggregated plain `Error`
  whose message is the full list:

```text
kiln: 2 broken internal links:
  1. /posts/hello/ → /tags/nonexistent/ (href="/tags/nonexistent/")
  2. /posts/hello/ → /about/#missing (href="/about/#missing")
```

  - Entry = `source page URL → broken target` plus the raw href; deduped to
    one entry per (source page, resolved target); entries ordered by source
    URL (deterministic).
  - The thrown error is a plain `Error` carrying its own list: T031's
    feature harness (same batch — deliberately **not** a dependency) wraps
    it verbatim, and the CLI surfaces it as `kiln: <message>`, exit 1.
  - Zero broken links → no output, exit 0. Empty `dist/` or no internal
    links → no-op, exit 0.
- Config (validated by the feature itself, per concurrency rule 4; both
  default to `[]`):
  - `features.linkCheck.allow: string[]` — globs matched against the
    **resolved target URL** of a would-be-broken link; a match excuses it
    (looked at, broken, forgiven — not reported, exit unaffected). Use
    case: `/admin/` served by the host, intentionally never emitted.
  - `features.linkCheck.exclude: string[]` — globs matched against the
    **raw href or the source page URL**; a match skips the link entirely
    (never resolved, never checked).
  - Globs are matched with Node 24's built-in `path.matchesGlob` (verified
    available; no new dependency). Examples:
    `allow: ['/sponsor/**', '/admin']`, `exclude: ['/legacy/**']`.
  - A non-array value or a non-string element fails the build with an error
    naming the exact key (`features.linkCheck.allow` /
    `features.linkCheck.exclude`).
- Self-check in tests: on a fixture with only valid links (tag archives,
  pagination pages, feed/sitemap/assets), the checker reports nothing —
  proving resolution agrees with T010's actual emission.

## Acceptance criteria

- [ ] Fixture page linking `/missing/` → exit 1; stderr lists
      `/source-page/ → /missing/` with the raw href.
- [ ] Two broken links on one page plus one on another → all three listed
      (scan completes; no fail-first behavior).
- [ ] `/good/#real-id` (heading id present) passes while `/good/#no-such-id`
      is broken; same-page `#local` checks the current page; a fragment on
      a nonexistent file reports the file, not the fragment.
- [ ] A page whose only links are `https://example.com/nope`, `mailto:x@y`,
      and `//cdn.example/x` → exit 0 (nothing fetched); grep of
      `src/features/linkCheck.ts` finds no `fetch`/`http`/`https` usage.
- [ ] `allow: ['/gone/**']` silences `/gone/x`; `exclude: ['/legacy/**']`
      stops source `/legacy/page/` links from being checked; both together
      behave as specified (allow excuses targets, exclude skips links).
- [ ] `allow: 'nope'` (string, not array) → build fails naming
      `features.linkCheck.allow`; same for a non-string element in
      `exclude`.
- [ ] Escaped sample inside `<pre>`/`<code>` containing the literal text
      `href="/fake/"` → not reported (region stripping).
- [ ] Case mismatch `/About/` vs emitted `/about/` → reported.
- [ ] A fixture with only valid links (feed, sitemap, tag, pagination, and
      unicode-titled targets) → exit 0, no output.
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
npm test -- test/linkCheck.test.ts        # detection, anchors, allow/exclude, stripping, config errors
grep -nE "fetch|node:http|node:https" src/features/linkCheck.ts   # expected: no output
npm run typecheck && npm test             # both exit 0
```

## Non-goals

- External link validation of any kind — no network access, ever; broken
  `https://` URLs are out of scope.
- No `srcset`, `poster`, form `action`, CSS `url()`, or JS-generated hrefs;
  no non-HTML outputs (the feed/sitemap's own `<link>`s are not scanned).
- No link rewriting/fixing, no redirect tables, no "did you mean"
  suggestions, no JSON/report output file.
- Not dependent on T031's `src/errors.ts` (same batch, parallel) and no
  edits outside `src/features/linkCheck.ts` + its test.
