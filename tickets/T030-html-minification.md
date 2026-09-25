# T030 — HTML minification

|            |                                                 |
| ---------- | ----------------------------------------------- |
| Wave/batch | W5·B1                                           |
| Depends on | T012                                            |
| Blocks     | —                                               |
| Owns       | `src/features/minify.ts`, `test/minify.test.ts` |
| Size       | M                                               |

## Goal

With `features.minify` set in `kiln.config.ts`, every emitted `.html` file
under `dist/` is rewritten smaller at the end of the build — collapsed
whitespace, stripped comments — via `html-minifier-terser@7`, while the
contents of every `<pre>` and `<code>` element stay byte-for-byte identical.
With the key absent the feature is a complete no-op (default off).

## Requirements

- Feature module `src/features/minify.ts` exporting a `Feature` whose
  `onBuildEnd` rewrites each `**/*.html` file under `dist/` in place.
  Non-HTML outputs (`feed.xml`, `sitemap.xml`, `search-index.json`,
  `assets/**`, images) are never opened or rewritten — byte-identical.
- Opt-in semantics and defaults:
  - `features.minify` absent → no file is read, written, or minified.
  - `features.minify` present → must be a plain object; array/string/number/
    null → the build fails with an error naming `features.minify`.
  - Keys — all optional booleans, merged over these defaults; a non-boolean
    value fails the build with an error naming the exact key (e.g.
    `features.minify.minifyCSS`), matching the validation style of the other
    features:
    - `collapseWhitespace` — default `true` once the feature is on.
    - `removeComments` — default `true` (HTML comments removed).
    - `minifyCSS` — default `false`; minifies inline `<style>` contents only.
    - `minifyJS` — default `false`; minifies inline `<script>` contents only.
  - These four keys are the entire exposed surface. Library options that
    would alter markup semantics beyond them (e.g. `removeAttributeQuotes`)
    are not configurable and stay off.
- Reference opt-in config (documented in the ticket/docs as the canonical
  example):

```ts
// kiln.config.ts
export default {
  features: {
    minify: { collapseWhitespace: true, removeComments: true, minifyCSS: true },
  },
};
```

- `<pre>`/`<code>` invariant: the inner HTML of every `<pre>` and `<code>`
  element — including inline `<code>` outside a `<pre>` — is preserved
  byte-for-byte (whitespace runs, indentation, comments, text). Whatever
  mechanism the feature uses to enforce this, the fixture test is the
  contract; if the library's defaults alone don't guarantee it, the feature
  must guard it.
- Syntax-highlight output survives minification: `hljs`/`language-*` classes
  and token spans inside code blocks are unchanged.
- `<!doctype html>` preserved; entities never double-escaped (`&amp;` never
  becomes `&amp;amp;`, `&nbsp;` intact).
- `minify` from `html-minifier-terser@7` is async — `onBuildEnd` may be
  async and must resolve only after every HTML file is rewritten.
- Deterministic: identical input → byte-identical output (no timestamps, no
  random ids). Empty or whitespace-only HTML files pass through without
  error.
- Dependency: the feature imports `minify` from `html-minifier-terser@7`
  (stack table); if it is not yet in `dependencies`, run
  `npm install html-minifier-terser@7` — this ticket introduces the package.
- A minifier failure on unexpected input fails the build with a plain `Error`
  naming the offending output file (`kiln: <message>`, exit 1).

## Acceptance criteria

- [ ] No `features.minify` in config → fixture HTML files are byte-identical
      (sha256 before/after) — the feature rewrote nothing.
- [ ] `features.minify: {}` → fixture page loses its `<!-- … -->` comments
      and collapses inter-tag whitespace runs, exiting 0.
- [ ] Fixture with `<pre><code class="language-ts hljs">` and an inline
      `<code>a    b</code>` → both elements' inner HTML byte-equal to the
      input; `hljs` class spans still present.
- [ ] Inline `<style>` byte-identical with `minifyCSS` at its default,
      shorter with `minifyCSS: true` (same for `<script>`/`minifyJS`).
- [ ] After a minified build, non-HTML files (`feed.xml`,
      `search-index.json`, `assets/*.js`) are byte-identical to an
      unminified build's.
- [ ] `features.minify: 'on'` → build fails naming `features.minify`;
      `{ minifyCSS: 1 }` → fails naming `features.minify.minifyCSS`;
      `{ collapseWhitespace: 'yes' }` → fails naming
      `features.minify.collapseWhitespace`. Exit 1 each time.
- [ ] Two consecutive minified builds of the same input are byte-identical.
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
npm test -- test/minify.test.ts   # fixture HTML: collapse, comments, pre/code invariant, config errors
npm run typecheck && npm test     # both exit 0
```

## Non-goals

- No CSS/JS *file* pipeline — `dist/assets/*.css`/`*.js` are never minified;
  only inline `<style>`/`<script>` behind the two flags.
- No gzip/brotli compression, image/SVG optimization, size report, or source
  maps.
- No exposure of the rest of `html-minifier-terser`'s option surface, no
  second minification library.
- Not on by default; the example site does not enable it (`site/**` is
  T034's). No changes to templates, content, or non-HTML outputs.
