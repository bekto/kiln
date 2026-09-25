/**
 * T018 acceptance — the Atom feed at `dist/feed.xml`.
 *
 * Builds run in-process through `kiln build`'s `run` (no CLI spawn: a
 * concurrent spawn could race `test/cli.test.ts`'s command discovery);
 * `process.exitCode` is restored after every inspection and stdout is
 * captured so report lines can be asserted. Fixtures materialize in the OS
 * temp dir and `chdir` into it (T009 resolves `templates/` against the
 * cwd). By default they ship NO `templates/partials/feed.xml`: the
 * feature-shipped partial belongs to the kiln package, so the feature must
 * fall back to it — two dedicated tests pin the resolution order (package
 * fallback renders byte-identical output; a project-shipped partial
 * wins), and the rest of the suite exercises the package path end-to-end.
 *
 * The XML is verified with a small hand-rolled parser (the suite installs
 * no dependencies): it enforces the declaration, tag balance, attribute
 * quoting, and entity well-formedness, which is what "parses as XML"
 * means for this test.
 */
import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { run as runBuildCommand } from "../src/commands/build.ts";
import type { BuildEnd, FeatureContext } from "../src/feature.ts";
import feedFeature from "../src/features/feed.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(TEST_DIR);
const PARTIAL = path.join(REPO, "templates", "partials", "feed.xml");

const ORIGIN = "https://example.com";
const DECLARATION = '<?xml version="1.0" encoding="utf-8"?>';

/** Minimal strict layout: the markdown body, nothing else. */
const LAYOUT =
  '<!doctype html>\n<html lang="en"><head><title>{{ site.title }}</title></head>' +
  "<body>{{ content | safe }}</body></html>\n";

const DEFAULT_CONFIG =
  `export default { site: { title: "Feed test", url: "${ORIGIN}" } };\n`;

/** Frontmatter + body for one fixture document; values are JSON-encoded
 * (a valid YAML double-quoted scalar), so any title round-trips. */
function markdown(meta: Record<string, unknown>, body: string): string {
  const frontmatter = Object.entries(meta)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n");
  return `---\n${frontmatter}\n---\n${body}\n`;
}

/**
 * Materialize a project in the OS temp dir, chdir into it, run `fn`, then
 * restore the cwd and clean up — even when `fn` throws. Defaults supply a
 * layout, a valid config, and the real feed partial; per-fixture entries
 * override them.
 */
async function withProject<T>(
  files: Record<string, string>,
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "kiln-feed-"));
  try {
    const all: Record<string, string> = {
      "kiln.config.ts": DEFAULT_CONFIG,
      "templates/post.html": LAYOUT,
      ...files,
    };
    for (const [name, source] of Object.entries(all)) {
      const target = path.join(root, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, source, "utf8");
    }
    const previous = process.cwd();
    process.chdir(root);
    try {
      return await fn(root);
    } finally {
      process.chdir(previous);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

interface CommandRun {
  /** The `process.exitCode` left behind (`undefined` = success). */
  exitCode: number | string | undefined;
  stdout: string;
}

/** Run `kiln build` in-process with stdout + exitCode captured. */
async function runBuild(args: string[] = []): Promise<CommandRun> {
  const previousExit = process.exitCode;
  const previousWrite = process.stdout.write;
  process.exitCode = undefined;
  const out: string[] = [];
  process.stdout.write = ((chunk: unknown): boolean => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await runBuildCommand(args);
    return { exitCode: process.exitCode, stdout: out.join("") };
  } finally {
    process.stdout.write = previousWrite;
    process.exitCode = previousExit;
  }
}

/** Parsed XML element: attributes as written, direct children, direct text. */
interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

/** Every XML entity this feed is allowed to emit. */
const ENTITY = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;

/**
 * Parse `xml` or fail the running test: declaration first, balanced and
 * matching tags, quoted well-formed attributes, no raw `&` outside an
 * entity, a single root. Enough structure to prove Atom shape without an
 * XML dependency.
 */
function parseXml(xml: string): XmlNode {
  assert.equal(xml.slice(0, DECLARATION.length), DECLARATION, "declaration must be the first bytes");
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  let index = DECLARATION.length;

  const flushText = (raw: string): void => {
    if (raw.trim() === "") return;
    const top = stack[stack.length - 1];
    assert.ok(top !== undefined, `text outside the root element: ${JSON.stringify(raw.slice(0, 60))}`);
    const stray = raw.replace(ENTITY, "");
    assert.ok(!stray.includes("&"), `unescaped "&" in text: ${JSON.stringify(raw.slice(0, 60))}`);
    top.text += raw;
  };

  while (index < xml.length) {
    const lt = xml.indexOf("<", index);
    if (lt === -1) {
      flushText(xml.slice(index));
      break;
    }
    flushText(xml.slice(index, lt));
    const gt = xml.indexOf(">", lt);
    assert.ok(gt !== -1, `unterminated tag at offset ${lt}`);
    const tag = xml.slice(lt + 1, gt);
    index = gt + 1;

    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      const top = stack.pop();
      assert.ok(top !== undefined, `closing </${name}> without an opener`);
      assert.equal(name, top.name, `mismatched close: </${top.name}> then </${name}>`);
      continue;
    }
    const selfClosing = tag.endsWith("/");
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const named = /^[A-Za-z_][\w.:-]*/.exec(body);
    assert.ok(named !== null, `tag without a name: <${tag}>`);
    const node: XmlNode = {
      name: named[0],
      attrs: parseAttrs(body.slice(named[0].length), tag),
      children: [],
      text: "",
    };
    const parent = stack[stack.length - 1];
    if (parent !== undefined) {
      parent.children.push(node);
    } else {
      assert.equal(root, null, `second root element <${node.name}>`);
      root = node;
    }
    if (!selfClosing) stack.push(node);
  }

  assert.equal(stack.length, 0, `unclosed element <${stack[stack.length - 1]?.name ?? "?"}>`);
  assert.ok(root !== null, "no root element");
  return root;
}

/** Attribute assignments of one tag body: ` name="value"` pairs, nothing else. */
function parseAttrs(raw: string, tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let rest = raw;
  const ATTR = /^\s*([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/;
  while (rest !== "") {
    const match = ATTR.exec(rest);
    assert.ok(match !== null, `malformed attributes in <${tag}> near ${JSON.stringify(rest.slice(0, 40))}`);
    const value = match[2].replace(ENTITY, "");
    assert.ok(!value.includes("&"), `unescaped "&" in attribute ${match[1]} of <${tag}>`);
    attrs[match[1]] = match[2];
    rest = rest.slice(match[0].length);
  }
  return attrs;
}

/** Direct children named `name`; the feed shape this suite asserts on. */
function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name);
}

/** The first direct child named `name`, or fail saying what is there. */
function child(node: XmlNode, name: string): XmlNode {
  const found = node.children.find((candidate) => candidate.name === name);
  assert.ok(found !== undefined, `<${node.name}> lacks <${name}> (has: ${node.children.map((c) => c.name).join(", ")})`);
  return found;
}

/** Reverse the escaping the template's autoescape applied to text. */
function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#34;|&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

const DATE_OLD = "2026-01-15T00:00:00.000Z";
const DATE_MID = "2026-03-02T08:30:00.000Z";
const DATE_NEW = "2026-06-01T12:00:00.000Z";
const DATE_FUTURE = "2030-06-01T00:00:00.000Z";

/** A three-post site (plus a non-post home page), the main-line fixture. */
function threePostSite(): Record<string, string> {
  return {
    "content/index.md": markdown({ title: "Home" }, "Home page."),
    "content/posts/oldest.md": markdown({ title: "Oldest", date: DATE_OLD }, "Oldest body."),
    "content/posts/middle.md": markdown({ title: "Middle", date: DATE_MID }, "Middle body."),
    "content/posts/newest.md": markdown(
      { title: "Newest", date: DATE_NEW },
      "## Section\n\nInline `x = 1` code and **bold** text.",
    ),
  };
}

test("valid Atom 1.0: namespace, structure, newest-first absolute entries, full escaped content", async () => {
  await withProject(threePostSite(), async (root) => {
    const run = await runBuild();
    assert.equal(run.exitCode, undefined, run.stdout);

    const xml = await readFile(path.join(root, "dist", "feed.xml"), "utf8");
    const feed = parseXml(xml);

    // Root: Atom namespace, feed-level identity.
    assert.equal(feed.name, "feed");
    assert.equal(feed.attrs.xmlns, "http://www.w3.org/2005/Atom");
    assert.equal(child(feed, "title").text, "Feed test");
    assert.equal(child(feed, "id").text, `${ORIGIN}/`);
    assert.equal(child(feed, "updated").text, DATE_NEW);
    const self = child(feed, "link");
    assert.equal(self.attrs.rel, "self");
    assert.equal(self.attrs.href, `${ORIGIN}/feed.xml`);

    // Entries: min(20, 3) of them, newest first, all absolute.
    const entries = children(feed, "entry");
    assert.equal(entries.length, 3);
    assert.deepEqual(
      entries.map((entry) => child(entry, "id").text),
      [`${ORIGIN}/posts/newest/`, `${ORIGIN}/posts/middle/`, `${ORIGIN}/posts/oldest/`],
    );
    assert.deepEqual(
      entries.map((entry) => child(entry, "updated").text),
      [DATE_NEW, DATE_MID, DATE_OLD],
    );
    for (const entry of entries) {
      assert.ok(child(entry, "title").text.length > 0, "entry title");
      const id = child(entry, "id").text;
      assert.ok(id.startsWith(ORIGIN), `id not absolute: ${id}`);
      const alternate = child(entry, "link");
      assert.equal(alternate.attrs.rel, "alternate");
      assert.ok(alternate.attrs.href.startsWith(ORIGIN), `href not absolute: ${alternate.attrs.href}`);
    }
    assert.ok(!xml.includes('href="/'), "a relative href reached the feed");

    // The entry carries the full rendered markup, XML-escaped — not raw
    // markdown, not an excerpt.
    const content = child(entries[0], "content");
    assert.equal(content.attrs.type, "html");
    assert.ok(xml.includes("&lt;h2&gt;Section&lt;/h2&gt;"), "escaped <h2> block missing");
    assert.ok(xml.includes("&lt;code&gt;x = 1&lt;/code&gt;"), "escaped <code> block missing");
    const decoded = decode(content.text);
    assert.ok(decoded.includes("<h2>Section</h2>"), "rendered heading missing after decode");
    assert.ok(decoded.includes("<code>x = 1</code>"), "rendered code missing after decode");
    assert.ok(decoded.includes("<strong>bold</strong>"), "rendered emphasis missing");
    assert.ok(!decoded.includes("## Section"), "raw markdown leaked into content");
  });
});

test("default cap: 25 posts yield exactly 20 entries, newest first", async () => {
  const files: Record<string, string> = {
    "content/index.md": markdown({ title: "Home" }, "Home page."),
  };
  for (let i = 1; i <= 25; i++) {
    const n = String(i).padStart(2, "0");
    files[`content/posts/post-${n}.md`] = markdown(
      { title: `Post ${n}`, date: `2026-01-${n}T00:00:00.000Z` },
      `Body ${n}.`,
    );
  }
  await withProject(files, async (root) => {
    const run = await runBuild();
    assert.equal(run.exitCode, undefined, run.stdout);
    const feed = parseXml(await readFile(path.join(root, "dist", "feed.xml"), "utf8"));
    const entries = children(feed, "entry");
    assert.equal(entries.length, 20);
    assert.equal(child(entries[0], "id").text, `${ORIGIN}/posts/post-25/`);
    assert.equal(child(entries[19], "id").text, `${ORIGIN}/posts/post-06/`);
  });
});

test("features.feed.limit: 1 keeps only the newest; a limit beyond the count keeps all", async () => {
  // One project per config: `readConfig` imports kiln.config.ts by file URL,
  // so a rewrite inside the same process would still see the cached module.
  await withProject(
    {
      ...threePostSite(),
      "kiln.config.ts":
        `export default { site: { title: "Feed test", url: "${ORIGIN}" }, features: { feed: { limit: 1 } } };\n`,
    },
    async (root) => {
      const run = await runBuild();
      assert.equal(run.exitCode, undefined, run.stdout);
      const feed = parseXml(await readFile(path.join(root, "dist", "feed.xml"), "utf8"));
      const entries = children(feed, "entry");
      assert.equal(entries.length, 1);
      assert.equal(child(entries[0], "id").text, `${ORIGIN}/posts/newest/`);
    },
  );

  await withProject(
    {
      ...threePostSite(),
      "kiln.config.ts":
        `export default { site: { title: "Feed test", url: "${ORIGIN}" }, features: { feed: { limit: 50 } } };\n`,
    },
    async (root) => {
      const run = await runBuild();
      assert.equal(run.exitCode, undefined, run.stdout);
      const feed = parseXml(await readFile(path.join(root, "dist", "feed.xml"), "utf8"));
      assert.equal(children(feed, "entry").length, 3); // no padding, no error
    },
  );
});

test("invalid features.feed.limit fails the build with features.feed in the report", async () => {
  for (const limit of [0, -1, 1.5, "20"]) {
    await withProject(
      {
        ...threePostSite(),
        "kiln.config.ts":
          `export default { site: { title: "Feed test", url: "${ORIGIN}" }, ` +
          `features: { feed: { limit: ${JSON.stringify(limit)} } } };\n`,
      },
      async () => {
        const run = await runBuild();
        assert.equal(run.exitCode, 1, `limit ${JSON.stringify(limit)} should fail:\n${run.stdout}`);
        assert.ok(run.stdout.includes("features.feed"), `report must name features.feed:\n${run.stdout}`);
        assert.ok(run.stdout.includes("limit"), `report must name the key:\n${run.stdout}`);
      },
    );
  }
});

test("invalid site.url (empty or relative) fails the build naming site.url", async () => {
  for (const url of ["", "/blog", "blog.example.com", "//host"]) {
    await withProject(
      {
        ...threePostSite(),
        "kiln.config.ts":
          `export default { site: { title: "Feed test", url: ${JSON.stringify(url)} } };\n`,
      },
      async () => {
        const run = await runBuild();
        assert.equal(run.exitCode, 1, `url ${JSON.stringify(url)} should fail:\n${run.stdout}`);
        assert.ok(run.stdout.includes("site.url"), `report must name site.url:\n${run.stdout}`);
      },
    );
  }
});

test("site.url with a path prefix joins base + page path with no double slashes", async () => {
  await withProject(
    {
      ...threePostSite(),
      "kiln.config.ts":
        `export default { site: { title: "Feed test", url: ${JSON.stringify(`${ORIGIN}/blog/`)} } };\n`,
    },
    async (root) => {
      const run = await runBuild();
      assert.equal(run.exitCode, undefined, run.stdout);
      const xml = await readFile(path.join(root, "dist", "feed.xml"), "utf8");
      const feed = parseXml(xml);
      // Trailing slash on site.url is normalized, then the site-relative
      // path joins with exactly one separator.
      assert.equal(child(feed, "id").text, `${ORIGIN}/blog/`);
      assert.equal(child(feed, "link").attrs.href, `${ORIGIN}/blog/feed.xml`);
      const entries = children(feed, "entry");
      assert.equal(entries.length, 3);
      assert.equal(child(entries[0], "id").text, `${ORIGIN}/blog/posts/newest/`);
      assert.equal(child(entries[0], "link").attrs.href, `${ORIGIN}/blog/posts/newest/`);
      assert.ok(!xml.includes("/blog//"), "double slash in a base join");
      assert.ok(!xml.includes('href="/'), "a relative href reached the feed");
    },
  );
});

test("no project partial: package-bundled fallback builds exit 0 with byte-identical output", async () => {
  // Main's integration regression: a fixture (or real project) with no
  // templates/partials/feed.xml must still build, and the package copy
  // must render exactly what a project shipping the partial renders.
  let withoutPartial = "";
  await withProject(threePostSite(), async (root) => {
    const run = await runBuild();
    assert.equal(run.exitCode, undefined, run.stdout);
    withoutPartial = await readFile(path.join(root, "dist", "feed.xml"), "utf8");
    assert.equal(children(parseXml(withoutPartial), "entry").length, 3);
  });

  await withProject(threePostSite(), async (root) => {
    const partialDir = path.join(root, "templates", "partials");
    await mkdir(partialDir, { recursive: true });
    await copyFile(PARTIAL, path.join(partialDir, "feed.xml"));
    const run = await runBuild();
    assert.equal(run.exitCode, undefined, run.stdout);
    const withPartial = await readFile(path.join(root, "dist", "feed.xml"), "utf8");
    assert.equal(
      withPartial,
      withoutPartial,
      "package fallback and project-shipped partial must produce the same bytes",
    );
  });
});

test("a project's own templates/partials/feed.xml overrides the shipped partial", async () => {
  const custom =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<feed xmlns="http://www.w3.org/2005/Atom">\n' +
    "  <title>{{ title }}</title>\n" +
    "  <id>{{ feedId }}</id>\n" +
    "  <updated>{{ updated }}</updated>\n" +
    '  <link rel="self" href="{{ selfHref }}"/>\n' +
    "  <generator>project-feed-partial</generator>\n" +
    "{% for entry in entries %}  <entry>\n" +
    "    <title>{{ entry.title }}</title>\n" +
    "    <id>{{ entry.id }}</id>\n" +
    "    <updated>{{ entry.updated }}</updated>\n" +
    '    <link rel="alternate" href="{{ entry.link }}"/>\n' +
    '    <content type="html">{{ entry.content }}</content>\n' +
    "  </entry>\n{% endfor %}</feed>\n";
  await withProject(
    { ...threePostSite(), "templates/partials/feed.xml": custom },
    async (root) => {
      const run = await runBuild();
      assert.equal(run.exitCode, undefined, run.stdout);
      const xml = await readFile(path.join(root, "dist", "feed.xml"), "utf8");
      assert.ok(
        xml.includes("<generator>project-feed-partial</generator>"),
        "the project-shipped partial must win",
      );
      const feed = parseXml(xml);
      assert.equal(feed.attrs.xmlns, "http://www.w3.org/2005/Atom");
      assert.equal(children(feed, "entry").length, 3);
    },
  );
});

test("missing site.url rejects onBuildEnd with an error naming site.url", async () => {
  // A real config cannot omit the key (T003 defaults it), so the missing
  // case is pinned at the hook seam the build calls.
  const root = await mkdtemp(path.join(tmpdir(), "kiln-feed-unit-"));
  try {
    const end: BuildEnd = {
      distDir: path.join(root, "dist"),
      site: { pages: [], data: { title: "No url configured" } },
      emitted: [],
      skipped: [],
    };
    const ctx: FeatureContext = {
      name: "feed",
      flags: { drafts: false, future: false, noCache: false },
      options<T>(validate: (raw: unknown) => T): T {
        return validate(undefined);
      },
    };
    const hook = feedFeature.onBuildEnd;
    assert.ok(hook !== undefined, "feed must export onBuildEnd");
    await assert.rejects(async () => {
      await hook(end, ctx);
    }, /site\.url/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("zero posts: valid empty feed with a build-timestamp <updated>, exit 0", async () => {
  await withProject({ "content/index.md": markdown({ title: "Home" }, "No posts yet.") }, async (root) => {
    const before = Date.now();
    const run = await runBuild();
    assert.equal(run.exitCode, undefined, run.stdout);

    const xml = await readFile(path.join(root, "dist", "feed.xml"), "utf8");
    const feed = parseXml(xml);
    assert.equal(feed.name, "feed");
    assert.equal(feed.attrs.xmlns, "http://www.w3.org/2005/Atom");
    assert.equal(children(feed, "entry").length, 0);
    assert.equal(child(feed, "title").text, "Feed test");
    assert.equal(child(feed, "id").text, `${ORIGIN}/`);
    assert.equal(child(feed, "link").attrs.href, `${ORIGIN}/feed.xml`);

    const updated = child(feed, "updated").text;
    assert.match(updated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const stamp = Date.parse(updated);
    assert.ok(stamp >= before && stamp - before < 5 * 60_000, `expected the build timestamp, got ${updated}`);
  });
});

test("titles and content are XML-escaped; unicode passes through as UTF-8", async () => {
  const title = 'Café ☕ — "Quotes" & <angle> — émigré';
  await withProject(
    { "content/posts/i18n.md": markdown({ title, date: DATE_MID }, "Body with **strong** text.") },
    async (root) => {
      const run = await runBuild();
      assert.equal(run.exitCode, undefined, run.stdout);

      const xml = await readFile(path.join(root, "dist", "feed.xml"), "utf8");
      const feed = parseXml(xml); // entity/tag well-formedness of the whole file
      const entry = children(feed, "entry")[0];
      assert.ok(entry !== undefined, "entry missing");
      assert.equal(decode(child(entry, "title").text), title);
      assert.ok(xml.includes("Café ☕"), "unicode must pass through unescaped");
      assert.ok(xml.includes("&lt;angle&gt;"), "angle brackets must be escaped");
      assert.ok(xml.includes("&amp;"), "ampersand must be escaped");
      assert.ok(!xml.includes("<angle>"), "raw <angle> must not appear");
    },
  );
});

test("drafts and future posts follow --drafts/--future in the feed", async () => {
  await withProject(
    {
      "content/index.md": markdown({ title: "Home" }, "Home."),
      "content/posts/live.md": markdown({ title: "Live", date: DATE_OLD }, "Live body."),
      "content/posts/wip.md": markdown({ title: "WIP", date: DATE_OLD, draft: true }, "Draft body."),
      "content/posts/soon.md": markdown({ title: "Soon", date: DATE_FUTURE }, "Future body."),
    },
    async (root) => {
      const feedPath = path.join(root, "dist", "feed.xml");
      const entryIds = async (): Promise<string[]> => {
        const feed = parseXml(await readFile(feedPath, "utf8"));
        return children(feed, "entry").map((entry) => child(entry, "id").text);
      };
      const live = `${ORIGIN}/posts/live/`;
      const draft = `${ORIGIN}/posts/wip/`;
      const future = `${ORIGIN}/posts/soon/`;

      let run = await runBuild();
      assert.equal(run.exitCode, undefined, run.stdout);
      let ids = await entryIds();
      assert.ok(ids.includes(live), "live post must always be in the feed");
      assert.ok(!ids.includes(draft), "draft leaked into a default build's feed");
      assert.ok(!ids.includes(future), "future post leaked into a default build's feed");

      run = await runBuild(["--drafts"]);
      assert.equal(run.exitCode, undefined, run.stdout);
      ids = await entryIds();
      assert.ok(ids.includes(draft), "draft must appear with --drafts");
      assert.ok(!ids.includes(future), "future post still hidden with only --drafts");

      run = await runBuild(["--future"]);
      assert.equal(run.exitCode, undefined, run.stdout);
      ids = await entryIds();
      assert.ok(ids.includes(future), "future post must appear with --future");
      assert.ok(!ids.includes(draft), "draft still hidden with only --future");

      run = await runBuild(["--drafts", "--future"]);
      assert.equal(run.exitCode, undefined, run.stdout);
      ids = await entryIds();
      assert.ok(ids.includes(draft) && ids.includes(future), "--drafts --future must include both");
    },
  );
});
