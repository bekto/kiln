# T005 — Slugs & URL helpers

|            |                                            |
| ---------- | ------------------------------------------ |
| Wave/batch | W1·B1                                      |
| Depends on | T003                                       |
| Blocks     | T006, T007, T010                             |
| Owns       | `src/content/slug.ts`, `test/slug.test.ts` |
| Size       | M                                          |

## Goal

Pure, unicode-safe helpers that convert strings and source paths into slugs
and pretty URLs, expand permalink templates with date/slug placeholders, and
map URLs to `…/index.html` output paths — the single source of truth for URL
shape used by the renderer (T006) and permalink emission (T010).

## Requirements

- `slugify(input: string): string` — unicode-safe:
  - Normalize to NFC, lowercase.
  - Whitespace and `_` runs → single `-`; Unicode letters/numbers
    (`\p{L}\p{N}`) kept in any script; all other characters removed;
    `-` runs collapsed; leading/trailing `-` trimmed.
  - Empty result (input empty, all punctuation) → `'untitled'`.
  - Examples: `'Hello, World!'` → `hello-world`;
    `'Café Münster — 日本語'` → `café-münster-日本語`;
    `' --Hello__World-- '` → `hello-world`.
- `slugFromPath(relPath: string): string` — last segment minus extension,
  slugified; when the basename is `index`, use the parent directory segment
  (`about/index.md` → `about`, `index.md` → `'untitled'`).
- `urlForPath(relPath: string): string` — source path → site URL:
  - Normalize `\` to `/`, strip leading `./` and `/`, strip a trailing
    `.md`/`.markdown` (case-insensitive).
  - Slugify each remaining segment; drop a trailing `index` segment.
  - Result always starts and ends with `/`.
  - Examples: `index.md` → `/`; `about/index.md` → `/about/`;
    `posts/hello world.md` → `/posts/hello-world/`;
    `2024/hello.md` → `/2024/hello/`.
- `filePathForUrl(url: string): string` — pretty URL → output path relative to
  `outDir`: strip leading `/`, append `index.html` for a directory URL
  (`/` → `index.html`, `/posts/hello-world/` → `posts/hello-world/index.html`);
  a missing trailing slash is treated as a directory (`/about` →
  `about/index.html`).
- `applyPermalink(template: string, ctx: { slug: string; date?: Date }):
  string` — permalink templates with placeholders `:slug`, `:year` (4-digit),
  `:month`/`:day` (2-digit zero-padded), taken from `ctx` (`date` read with UTC
  getters so results are timezone-independent). Output is normalized to a
  leading and trailing `/`. A `:word` token that is not a known placeholder →
  error `unknown permalink placeholder ":word" in "<template>"`; `:year`,
  `:month`, `:day` without `ctx.date` → error `placeholder ":year" requires a
  date`; a colon not followed by letters is literal (e.g. `http:` never
  appears in templates but must not be eaten).
- All functions are pure (no fs, no config access) and synchronous.
- Path handling must be correct on both `/` and `\` separators; tests must
  include at least one Windows-style input.

## Acceptance criteria

- [ ] `slugify` unicode cases: `Café Münster — 日本語` →
      `café-münster-日本語`, `你好，世界！` → `你好世界` (punctuation dropped,
      no crash), `'!!!'` and `''` → `untitled`.
- [ ] `urlForPath('posts/Hello World.md')` → `/posts/hello-world/`;
      `urlForPath('about/index.md')` → `/about/`; `urlForPath('index.md')` →
      `/`; `urlForPath('posts\\hello.md')` → `/posts/hello/`.
- [ ] `filePathForUrl('/posts/hello-world/')` → `posts/hello-world/index.html`;
      `filePathForUrl('/')` → `index.html`.
- [ ] `applyPermalink('/posts/:year/:month/:slug/', { slug: 'hi', date: new
      Date('2024-05-01') })` → `/posts/2024/05/hi/`.
- [ ] `applyPermalink` with `:foo` → throws naming `:foo` and the template;
      with `:year` and no date → throws naming `:year`.
- [ ] `applyPermalink('posts/:slug', …)` (no slashes) → output gains leading
      and trailing `/` → `/posts/<slug>/`.
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
npm test -- test/slug.test.ts     # unit: slugs, path→URL, URL→file, permalink expansion
npm run typecheck && npm test     # both exit 0
```

## Non-goals

- No reading of files or frontmatter (callers pass strings/dates), no
  collection/date-based directory schemes beyond what the template expresses,
  no redirect tables, no config options (defaults above are fixed).
