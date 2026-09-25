# T009 — Template engine & base layouts

|            |                                                              |
| ---------- | ------------------------------------------------------------ |
| Wave/batch | W2·B1                                                        |
| Depends on | T006                                                         |
| Blocks     | T010, T012                                                   |
| Owns       | `src/render/templates.ts`, `templates/*.html`, `test/templates.test.ts` |
| Size       | L                                                            |

## Goal

A nunjucks-backed engine that renders a markdown `Page` into final layout-
inherited HTML — partials auto-loaded from `templates/partials/`, strict mode
(undefined variable = error naming template + line), three default layouts
shipped — the render layer T010 writes to disk.

## Requirements

- Export from `src/render/templates.ts`:
  - `loadTemplates(templatesDir?: string): Promise<Templates>` — default
    `'templates'`. Missing directory → rejects with
    `<absolute path>: templates directory not found` (fail fast, before any
    render).
  - `interface Templates { render(template: string, data: Record<string,
    unknown>): Promise<string>; renderDocument(page: Page, opts:
    RenderDocumentOptions): Promise<string> }`.
  - `interface RenderDocumentOptions { url: string; site: Record<string,
    unknown>; extensions?: MarkdownExtension[]; extra?: Record<string,
    unknown> }`.
  - `pageView(page: Page): Record<string, unknown>` — the template view:
    `{ ...page.data, url, path }` (computed `url`/`path` win over same-named
    frontmatter).
- Markdown phase (`renderDocument`): `createRenderer({ extensions,
  currentUrl: url })` (T006), then `md.render(page.content, { doc: page })`
  — the markdown-it `env` carries the page so feature plugins registered
  through `extendMarkdown` can attach per-page data (e.g. `doc.data.toc`)
  during render. `extensions` is T012's feature-provided array; omitted →
  plain T006 renderer.
- Layout phase: context = `{ ...extra, site, page: pageView(page), content }`
  — `page`/`site`/`content` always present and cannot be shadowed by
  `extra`. Template selection: `data.layout` absent → `post.html`; string
  with optional `.html` suffix normalized (`post` and `post.html` both load
  `post.html`); present but not a string → error naming the source path and
  the value.
- Loader: nunjucks `FileSystemLoader` with search paths
  `[templatesDir, templatesDir/partials]` → layouts resolve by path
  (`"post.html"`), partials resolve by bare name (`"header.html"` →
  `templates/partials/header.html`) and by prefixed path.
- Environment: `autoescape: true` (all `{{ }}` escaped; rendered markdown is
  inserted with `|safe` only), `throwOnUndefined: true` (strict).
- Strict errors are wrapped to guarantee the message contains template name
  and line: `post.html: line 7: undefined variable "titel"`. Missing
  template (layout or include): `template not found: "x.html" (searched:
  templates/, templates/partials/)`.
- Registered `page.injectHead` / `page.injectBody` partial-name arrays are
  included by `templates/base.html` (head slot, and before `</body>`):
  `{% if page.injectHead %}{% for p in page.injectHead %}{% include p %}
  {% endfor %}{% endif %}` (and the `injectBody` twin). Absent/empty → no
  output; a registered name with no file → the normal template-not-found
  error. This is the layout seam features use (T012's contract) since they
  may not edit these layouts.
- Filter `date`: `Date` → `YYYY-MM-DD` (UTC `toISOString().slice(0, 10)`,
  deterministic); anything else → error naming the received type.
- Default layouts created by this ticket (all extend `base.html` where
  noted; optional values guarded with `{% if %}` so strict mode only fires
  on genuine typos):
  - `templates/base.html` — doctype, `<html lang="en">`, head (charset,
    viewport, `<title>` from `site.title` with `Kiln site` fallback,
    `{% block head %}`), body (`{% block content %}`, `injectBody` slot).
  - `templates/post.html` — `extends base`; `<h1>{{ page.title }}</h1>`
    (guarded), guarded `<time>` with the `date` filter, article body
    `{{ content | safe }}`.
  - `templates/index.html` — `extends base`; `<h1>` guarded page/site
    title; list over `site.pages` (`{% for p in site.pages %}`) linking
    `p.url` with guarded `p.title` fallback to `p.url`.
- `loadTemplates` resolves relative to cwd; templates are re-read on each
  `render` call (no long-lived cache — rebuilds must see edits; T027 relies
  on this).

## Acceptance criteria

- [ ] `loadTemplates()` + `renderDocument` on a fixture page → output
      contains `<!doctype html>`, the layout's `<title>`, and the rendered
      markdown body; `post.html` output also has base's head (inheritance).
- [ ] A partial in `templates/partials/` is included by bare name from a
      layout.
- [ ] Fixture layout containing `{{ titel }}` → rejection whose message
      contains `post.html` (or fixture name), `line`, and `titel`.
- [ ] `layout: bogus` → rejection containing `template not found`,
      `bogus.html`, and the searched directories.
- [ ] `loadTemplates('/nonexistent-dir')` → rejection containing
      `templates directory not found`.
- [ ] Data title `<script>x</script>` renders escaped in output; `content`
      HTML survives unescaped (`|safe`).
- [ ] `page.injectHead: ['note.html']` with a `templates/partials/note.html`
      → its markup appears inside `<head>`; without the array → absent;
      with the array but no file → template-not-found error.
- [ ] Seam proof: an `extensions` entry (T012's shape) whose plugin sets
      `doc.data.toc` during render → `page.toc` is readable by the layout.
- [ ] `date` filter: `new Date('2026-09-25')` renders `2026-09-25`; a string
      value rejects naming its type.
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
npm test -- test/templates.test.ts   # inheritance, partials, strict/missing errors, escaping, slots, env seam
npm run typecheck && npm test        # both exit 0
```

## Non-goals

- No markdown-it configuration or plugin registration policy (T006/T012),
  no feature discovery (T012), no URL/path computation (T005/T007), no
  themes system, no i18n, no template hot-reload (T027 rebuilds), no
  layouts beyond the three defaults (projects add their own files), no
  filters beyond `date`.
