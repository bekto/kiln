# T008 — Collections & queries

|            |                                                          |
| ---------- | -------------------------------------------------------- |
| Wave/batch | W2·B2                                                    |
| Depends on | T007                                                     |
| Blocks     | T012                                                     |
| Owns       | `src/content/collections.ts`, `test/collections.test.ts` |
| Size       | M                                                        |

## Goal

A discovered `Site` is organized into deterministic `posts` and `pages`
collections (newest first) with pure query helpers — tag lookup, draft
detection, date sorting — that templates (T009's defaults), the orchestrator
(T012), and Wave-3 features all reuse instead of re-deriving ordering rules.

## Requirements

- Export from `src/content/collections.ts` (all inputs are T004 `Page[]` or
  `Site`, outputs are new arrays — nothing is mutated):
  - `computeCollections(site): Collections` with
    `Collections = { posts: Page[]; pages: Page[] }`; reads `site.pages`.
  - `sortByDate(pages): Page[]` — the single sort used everywhere.
  - `byTag(pages, tag): Page[]`, `allTags(pages): string[]`,
    `isDraft(page): boolean`, `withoutDrafts(pages): Page[]`.
- Membership: read `data.collection` (T007 stamps it at discovery; feature-
  appended pages may omit it). Present → must be exactly `'posts'` or
  `'pages'`, otherwise error naming the file and the value
  (`<path>: "collection" must be "posts" or "pages" (got "zine")`).
  Absent → `'pages'` (home pages, feature-appended archives/loops).
- Sorting rule (`sortByDate`, applied to both collections): descending by
  `data.date`; a missing or unparseable date counts as oldest (epoch — T004
  already rejects invalid dates at parse time, this guard covers
  feature-appended objects); ties break ascending by `page.path` (absolute
  source path — same relative order for discovered pages). Output is fully
  deterministic regardless of discovery or append order.
- `isDraft`: `data.draft === true` (boolean `true` only). `data.draft`
  present but not a boolean → error
  `<path>: "draft" must be a boolean (got <type>)`.
- Collections include drafts and future-dated posts — T008 never hides
  anything and takes no clock parameter. Visibility policy is T013's.
- Tag rules: `data.tags` must be absent or an array of strings, otherwise
  error naming the file and `tags`. `byTag` matches exactly after trimming
  each tag (case-sensitive). `allTags` returns unique tags in first-seen
  order over the input sequence.
- All functions are pure (no I/O, no config, no clock) and work on plain
  `Page`-shaped objects — pages appended by features (`onSite`) in T012
  participate identically to discovered files.
- Integration contract (consumed by T012): collections are computed **after**
  `onSite` hooks and exposed to templates as `collections.posts` /
  `collections.pages`; collection items in template views carry at least
  `url`, `title`, `date`, `path`.

## Acceptance criteria

- [ ] Fixture posts with dates → `computeCollections(site).posts` is strictly
      newest-first; two posts sharing a date come out path-ascending.
- [ ] A post without `date` sorts last; a post with `date: "not-a-date"`
      does not throw and also sorts last.
- [ ] `content/posts/x.md` (stamped `'posts'`) lands in `posts`;
      `content/about.md` lands in `pages`; a page with
      `data.collection: pages` under `posts/` lands in `pages`; an appended
      page with no `data.collection` lands in `pages`.
- [ ] `collection: zine` rejects with a message containing the file path and
      the value.
- [ ] A draft page appears in `computeCollections(site).posts` and
      disappears under `withoutDrafts`; `draft: "yes"` rejects with
      `"draft" must be a boolean` naming the file.
- [ ] `byTag` finds a fixture post by exact tag and skips a case-mismatched
      tag; `tags: "news"` (bare string) rejects naming the file and `tags`;
      `allTags` preserves first-seen order without duplicates.
- [ ] Two calls on the same site return the identical page sequence
      (determinism); input `site.pages` array is not mutated.
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
npm test -- test/collections.test.ts   # ordering, membership, filters, error shapes
npm run typecheck && npm test          # both exit 0
```

## Non-goals

- No hiding of drafts/scheduled posts (T013), no tag/category archive page
  generation (T014), no pagination (T015), no markdown rendering (T006), no
  CLI surface, no reading `kiln.config.ts`.
