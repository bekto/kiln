# T023 — Client-side search

|            |                                                                       |
| ---------- | --------------------------------------------------------------------- |
| Wave/batch | W3·B1                                                                 |
| Depends on | T012                                                                  |
| Blocks     | T033, T034                                                            |
| Owns       | `src/features/search.ts`, `templates/partials/search.html`, `assets/search.js`, `test/search.test.ts` |
| Size       | L                                                                     |

## Goal

A built site ships a search index at `dist/search-index.json` plus a
dependency-free browser script and an opt-in `search.html` partial, giving any
page client-side search over titles/tags/excerpts with title hits ranked above
tag hits above excerpt hits.

## Requirements

### Index (`onSite`)

- Feature module `src/features/search.ts` exporting a `Feature` whose
  `onSite(site, cfg)` writes `dist/<indexPath>`, where `indexPath` is
  `features.search.indexPath` (string, default `search-index.json`), resolved
  relative to `dist/`.
- The index is a JSON array; each entry has exactly the fields `title`, `url`,
  `excerpt`, `tags` — never rendered HTML, never the document body.
- Entries cover every published document (posts and pages), with drafts and
  future-dated posts excluded per T013. `excerpt` is the document's `excerpt`
  when one is present (frontmatter/T020), otherwise `""`.
- `url` is the site-absolute emitted path (`/…`); `tags` is a string array
  (possibly empty).
- Invalid `features.search.indexPath` (non-string, empty, absolute path, or
  containing `..`) fails the build with an error naming
  `features.search.indexPath`.
- Empty site → the index file exists and contains `[]`; the build exits 0.
- `onSite` also publishes the resolved index URL (`/` + indexPath) as
  `searchIndexPath` on the site data for the partial to render.

### Script (`assets/search.js`)

- Vanilla browser JavaScript: zero dependencies, no `import`/`require`, no
  bundler step, no framework. `onBuildEnd` copies it byte-for-byte to
  `dist/assets/search.js`.
- Index URL comes from the `data-index` attribute on the search root element;
  if the attribute is missing, the script falls back to `/search-index.json`.
- Fetches the index lazily on the first query and caches it; matching is
  case-insensitive.
- Matching: the query is split on whitespace into tokens; an entry matches
  only if every token is a substring of its title, of at least one of its
  tags, or of its excerpt.
- Ranking: per token — title hit = 3, tag hit = 2, excerpt hit = 1; an entry's
  score is the sum of each token's best field score; results are sorted by
  score descending, then title ascending (deterministic).
- Results render into the partial's results container. Zero matches, an empty
  index, or a failed fetch → a visible "No results" state; the script never
  throws an uncaught error and never leaves a blank panel. An empty query
  clears the results.

### Partial (`templates/partials/search.html`)

- New file in `templates/partials/`; shared templates/layouts are never
  edited. Provides the markup and hooks the script: a labelled search input,
  a results list container, a "No results" empty-state element, the search
  root carrying `data-index="{{ searchIndexPath | default('/search-index.json') }}"`,
  and `<script src="/assets/search.js" defer></script>`.
- Site authors opt in with `{% include "search.html" %}` wherever search
  should appear (T034 wires it into the example site).

## Acceptance criteria

- [ ] `node src/cli.ts build` writes `dist/search-index.json`; parsing it
      shows an array whose entries have exactly `title`, `url`, `excerpt`,
      `tags` and no HTML tags anywhere in `title`/`excerpt`.
- [ ] `cmp assets/search.js dist/assets/search.js` produces no output
      (byte-identical copy), and `node --check assets/search.js` exits 0 with
      no `import`/`require` in the file.
- [ ] Fixture where a query token hits one post's title, another's tag, and a
      third's excerpt → results ordered title post, tag post, excerpt post.
- [ ] A two-token query matches only entries containing both tokens.
- [ ] `features.search.indexPath: "data/search.json"` → file at
      `dist/data/search.json` and the rendered partial carries
      `data-index="/data/search.json"`.
- [ ] `features.search.indexPath` set to `42`, `""`, or `"../x"` → build fails
      with an error naming `features.search.indexPath`.
- [ ] Empty site → `dist/search-index.json` contains `[]`; on a page with the
      partial, the script shows the "No results" state without throwing.
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
npm run typecheck && npm test                                            # both exit 0
npm test -- test/search.test.ts                                          # passes: index shape, ranking order, empty-index no-op
node src/cli.ts build && node --input-type=module -e "import {readFileSync} from 'node:fs'; const a=JSON.parse(readFileSync('dist/search-index.json','utf8')); console.log(a.length, Object.keys(a[0]??{}).join(','))"   # prints "<n> title,url,excerpt,tags"
cmp assets/search.js dist/assets/search.js                               # no output = byte-identical
```

## Non-goals

- No server-side search, no fuzzy/typo tolerance, stemming, synonyms, or
  regex queries — substring/token matching only.
- No full-text bodies or HTML in the index, no match highlighting or
  result snippets/pagination.
- No `file://` support (fetch requires the site served over HTTP, e.g.
  `kiln serve` or any static server); no edits to shared layouts — the
  partial is opt-in.
