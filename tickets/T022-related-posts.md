# T022 — Related posts

|            |                                             |
| ---------- | ------------------------------------------- |
| Wave/batch | W3·B1                                       |
| Depends on | T012                                        |
| Blocks     | T033, T034                                  |
| Owns       | `src/features/related.ts`, `test/related.test.ts` |
| Size       | M                                           |

## Goal

Every post exposes a `related` list on its `Document` — up to N other posts
ranked by tag overlap — so a post layout can render a "Related posts" section
at build time with no client-side work.

## Requirements

- Feature module `src/features/related.ts` exporting a `Feature` whose
  `onSite(site, cfg)` scores candidates and attaches `related` to every post
  Document before templates render.
- Candidate pool: the posts collection only (never pages), honoring T013
  ordering — drafts and future-dated posts are excluded unless `--drafts` /
  `--future` include them. A post is always excluded from its own list.
- Score = number of tags shared with the candidate (set intersection size).
  Only candidates with score > 0 qualify.
- Ordering: score descending, then date descending, then URL ascending —
  fully deterministic for equal scores and equal dates.
- Top N: `features.related.limit` — positive integer, default `5`. Invalid
  value (non-number, `0`, negative, non-integer) fails the build with an error
  naming `features.related.limit`.
- Fewer qualifying posts than N → return all that qualify, no error. Fewer
  than 2 posts total (including an empty site) → `related` is `[]` for every
  post and the build exits 0; an untagged post also gets `[]`.
- Each entry is plain, template-safe data: `{ title, url, date }` with `date`
  as an ISO 8601 string.
- Self-contained: uses only its own config key and the site/documents it is
  handed; no coupling to other features.

## Acceptance criteria

- [ ] Posts A/B/C where A↔B share 2 tags and A↔C shares 1 tag → A's `related`
      lists B before C.
- [ ] A never appears in A's own `related`, even when it shares tags with
      itself.
- [ ] Draft post is absent from `related` by default and present when the
      build runs with `--drafts`.
- [ ] 10 posts all sharing a tag with A and `features.related.limit: 5` →
      exactly 5 entries; 3 qualifying posts → exactly 3, exit 0.
- [ ] Two candidates with equal score and different dates → newer first; equal
      score and equal date → lower URL first.
- [ ] Site with 1 post, and site with 0 posts → build exits 0, `related` is
      `[]` everywhere.
- [ ] `features.related.limit: 0` (or `"five"`) → build fails with an error
      naming `features.related.limit`.
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
npm run typecheck && npm test          # both exit 0
npm test -- test/related.test.ts       # passes: overlap scoring, tie-breaks, draft exclusion, top-N, tiny/empty site
node src/cli.ts build                  # exits 0; every post has an array of <= 5 {title,url,date} entries
```

## Non-goals

- No content/text similarity, vector search, or "read next" heuristics — tags
  only.
- No related lists for pages, no category-based scoring, no partial or layout
  for rendering the list (site templates consume `related` themselves; a
  "Related posts" UI is a site concern, not this ticket).
