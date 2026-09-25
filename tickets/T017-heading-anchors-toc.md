# T017 — Heading anchors & TOC

|            |                                                                              |
| ---------- | ---------------------------------------------------------------------------- |
| Wave/batch | W3·B1                                                                        |
| Depends on | T012                                                                         |
| Blocks     | T033, T034                                                                   |
| Owns       | `src/features/toc.ts`, `templates/partials/toc.html`, `test/toc.test.ts`     |
| Size       | M                                                                            |

## Goal

Every heading in rendered content gets a slugified `id` that is unique
within its page (duplicates suffixed `-2`, `-3`, …), and pages expose a
heading table (`page.toc`) rendered through a new `toc.html` partial whose
depth is configurable.

## Requirements

- Feature module `src/features/toc.ts` default-exporting a `Feature` whose
  `extendMarkdown(md, ctx)` registers a markdown-it core rule that assigns
  `id` attributes to `h1`–`h6` tokens using T005's unicode-safe slugger
  over the heading's plain text (inline markup stripped: `` `code` ``,
  links, emphasis — `` ## Use `kiln build` `` → `use-kiln-build`).
- Uniqueness is **page-scoped**: first occurrence keeps the bare slug,
  second becomes `<slug>-2`, third `<slug>-3`, and so on. The same heading
  on two different pages gets the bare slug on both (a duplicate anchor
  across pages is allowed and expected — `id` never leaves the page).
- Empty slug after stripping (image-only or empty heading) falls back to
  `section`, still deduped (`section`, `section-2`, …).
- The counter resets on every render: ids are derived per invocation from
  the fresh markdown env (`env = { doc }`, T012 lifecycle — no module-level
  state, rebuilds never accumulate suffixes).
- During render the rule writes `env.doc.data.toc`: an ordered array of
  `{ level, text, id, url }` (`url` = page URL + `#id`), visible to
  layouts as `page.toc` (T012 builds the template view after markdown
  render). Anchors are assigned to **all** heading levels regardless of
  TOC depth; depth only filters what the TOC lists.
- When and only when a non-empty TOC was written, the rule appends the
  partial file name `"toc.html"` to `env.doc.data.injectBody`, so the base
  layout's body slot (T012 layout-injection seam) includes the new partial
  `templates/partials/toc.html` — shared layouts are never edited.
- TOC partial renders a nested `<nav><ul>` from `page.toc`, including
  headings with `level <= features.toc.depth`.
- Config key `features.toc.depth`, read via `ctx.options(...)`: integer in
  range 2–3, default `3` (depth 3 → h1–h3 listed; h4+ still get anchors but
  are omitted from the TOC). Out-of-range values (`1`, `4`, `2.5`,
  `"three"`) → build error containing `features.toc`, exit 1.
- A page with no headings → no `toc.html` injection, no empty `<nav>`
  rendered, build unaffected.

## Acceptance criteria

- [ ] A post with two `## Setup` headings renders `id="setup"` and
      `id="setup-2"` in its HTML.
- [ ] Two different posts each containing `## Setup` both render
      `id="setup"` (no suffix on either).
- [ ] `page.toc` is populated: the emitted page contains a `<nav>` TOC
      whose entries link to `#<id>` and, at default depth 3, include h1–h3
      but not an h4.
- [ ] `features.toc.depth: 1` (also `4`, `2.5`, `"three"`) fails the build
      with an error containing `features.toc`, exit 1.
- [ ] `` ## Use `kiln build` `` → `id="use-kiln-build"`; a unicode heading
      (e.g. `## 設定`) → T005's unicode-safe slug in the id and in `page.toc`.
- [ ] A heading-only-empty page (`##` with no text) → `id="section"`;
      second one → `id="section-2"`.
- [ ] Rebuilding (second `kiln build` in the same session/watch) does not
      change ids — no `-2` accumulated across runs.
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
npm test -- test/toc.test.ts             # unit: ids, dedupe suffixes, toc data, depth validation
node src/cli.ts build && grep -o 'id="[^"]*"' dist/<post>/index.html   # unique ids incl. -2 suffix; page has <nav> TOC
```

## Non-goals

- No per-heading anchor-link glyphs (`¶`/`#` hover buttons), no
  copy-link JS, no TOC sidebar/sticky positioning or collapse behavior
  (the partial renders markup only; the body-slot placement is fixed by
  the T012 injection seam), no frontmatter override of individual heading
  slugs, no config key for which heading levels get anchors.
