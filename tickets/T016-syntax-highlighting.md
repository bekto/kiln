# T016 — Syntax highlighting

|            |                                      |
| ---------- | ------------------------------------ |
| Wave/batch | W3·B1                                |
| Depends on | T012                                 |
| Blocks     | T033                                 |
| Owns       | `src/features/highlight.ts`, `test/highlight.test.ts` |
| Size       | M                                    |

## Goal

Every fenced code block in rendered pages is syntax-highlighted at build time
(pre-colored `<span>`s, zero client-side JS), with a language label on the block.

## Requirements

- Feature module `src/features/highlight.ts` exporting a `Feature` whose
  `extendMarkdown(md)` registers a fence renderer using `highlight.js`.
- Recognized languages (at minimum): `js`, `ts`, `json`, `bash`, `html`, `css`,
  `python`. Unknown language or absent language → escaped plain `<code>`, never
  a crash and never blank output.
- `hljs` class on the `<code>` element plus `language-<lang>`; render class
  names prefixed `hljs-` so themes can target them.
- Language label rendered from the info string (e.g. ```` ```ts title=x.ts ````
  → label `ts`, renderer gets `title=x.ts` — take the first token only).
- Theme: default `github-dark` CSS emitted as `dist/assets/hljs.css`, included
  only when at least one code block was highlighted (feature exposes
  `onBuildEnd` to write the file). Config key: `features.highlight.theme`
  (string, default `github-dark`); invalid theme name → clear config error
  naming the key.
- `hljs.getLanguage(name)` is the allowlist — never pass raw fence text to
  `highlight()`.

## Acceptance criteria

- [ ] A `ts` code block renders with `hljs` spans; snapshot test asserts
      `class="hljs-keyword"` or equivalent token span appears.
- [ ] An `unknownlang` fence renders escaped text inside `<code>`, exit 0.
- [ ] A fence with no language renders unhighlighted but valid HTML.
- [ ] `dist/assets/hljs.css` exists after a build containing code, and does not
      exist after a build with none.
- [ ] Setting `features.highlight.theme` to a bogus value fails the build with
      an error naming `features.highlight.theme`.
- [ ] `npm run typecheck && npm test` green.

## Verification

```bash
npm test -- test/highlight.test.ts   # unit: fences → HTML
node src/cli.ts build && ls dist/assets/hljs.css
```

## Non-goals

- No client-side highlighting, no line numbers, no copy buttons, no diff
  highlighting.
