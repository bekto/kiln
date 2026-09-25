# T006 — Markdown renderer

|            |                                                     |
| ---------- | --------------------------------------------------- |
| Wave/batch | W1·B2                                               |
| Depends on | T004, T005                                          |
| Blocks     | T009                                                |
| Owns       | `src/content/markdown.ts`, `test/markdown.test.ts`  |
| Size       | M                                                   |

## Goal

A markdown-it@15 renderer that produces GFM-flavored HTML from `Document.content`
and exposes the `extendMarkdown(md)` seam: callers inject plugins through a
first-class `MarkdownExtension` type, so features (T013+) extend rendering
without the core ever importing or discovering them.

## Requirements

- Export from `src/content/markdown.ts`:
  - `type MarkdownExtension = (md: MarkdownIt) => void` — identical in shape
    to the `Feature.extendMarkdown(md)` hook defined later by T012; this is
    the markdown seam from concurrency rule 6.
  - `interface RenderOptions { extensions?: MarkdownExtension[]; currentUrl?:
    string }`.
  - `createRenderer(options?: RenderOptions): MarkdownIt` — configured
    instance with extensions already applied (callers may build once and
    reuse across pages).
  - `renderMarkdown(source: string, options?: RenderOptions): string` —
    convenience: create, render, return HTML.
- Markdown-it configuration: `html: false` (raw HTML in source is escaped,
  never passed through), `linkify: true` (autolinks), `typographer: false`.
  GFM tables, strikethrough, and fenced code blocks render per markdown-it's
  default rule set.
- Extension seam behavior: each entry of `extensions` is applied to the
  MarkdownIt instance in array order, before any rendering. The core module
  never globs, imports, or references `src/features/*` — T012's orchestrator
  collects `Feature.extendMarkdown` hooks and passes them in.
- Internal `.md` link rewriting (uses T005):
  - A `linkify`/manual link whose href ends in `.md`/`.markdown` (optionally
    with query/fragment) is rewritten to the pretty URL via `urlForPath` at
    render time; query and fragment are preserved:
    `setup.md#steps` → `/guide/setup/#steps`.
  - Root-relative `/guide/setup.md` → `/guide/setup/` always.
  - Relative links (`../about.md`) are resolved against the directory of
    `currentUrl` (a pretty URL like `/posts/hi/`); when `currentUrl` is
    omitted, relative `.md` links are left unchanged.
  - Never rewritten: external URLs (`https://…/x.md`, `http:`, `mailto:`,
    protocol-relative `//host/x.md`), pure anchors (`#sec`), and non-markdown
    targets (`notes.txt`).
- `renderMarkdown` never throws on syntactically valid (or merely weird)
  markdown; malformed input degrades to ordinary markdown-it output.

## Acceptance criteria

- [ ] GFM table source → `<table>` in output; `~~old~~` → `<del>old</del>`.
- [ ] A ` ```ts ` fence renders a `<pre><code>` block (no highlighting yet —
      that is T016 through this seam).
- [ ] Raw `<em>x</em>` in source renders as escaped text, not a tag
      (`html: false`).
- [ ] Seam proven: a test extension shaped `(md) => void` registers a small
      plugin (e.g. an inline rule turning `%%hi%%` into `<mark>hi</mark>`)
      and its markup appears in `renderMarkdown` output only when passed in
      `extensions`.
- [ ] Two extensions are both applied, and application order matches array
      order.
- [ ] Link rewriting: `[a](../about.md)` with `currentUrl: '/posts/hi/'` →
      `href="/about/"`; `[b](https://example.com/x.md)` unchanged;
      `[c](notes.txt)` unchanged; `[d](#sec)` unchanged; relative `.md` link
      with no `currentUrl` unchanged.
- [ ] `src/content/markdown.ts` contains no import or reference to
      `src/features/` (grep: no matches).
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
npm test -- test/markdown.test.ts  # unit: GFM, escaping, seam, link rewriting
grep -n "src/features" src/content/markdown.ts   # expected: no output
npm run typecheck && npm test     # both exit 0
```

## Non-goals

- No heading anchors/TOC (T017), no syntax highlighting (T016), no excerpts
  or reading time (T020/T021), no template/layout rendering (T009), no
  feature auto-discovery (T012), no footnotes or typographer smart quotes,
  no client-side JS.
