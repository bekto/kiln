/**
 * T012 acceptance — build orchestrator, feature contract, report.
 *
 * Probe features are written into the repo's `src/features/` and deleted in
 * `finally` (cleanup runs even when an assertion throws). No test spawns the
 * CLI: `test/cli.test.ts` creates temporary malformed command files in a
 * parallel process, and any CLI spawn of mine could race its discovery — so
 * command behavior is exercised by importing `run` directly, with
 * `process.exitCode` restored after every inspection.
 */
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { run as runBuildCommand } from "../src/commands/build.ts";
import { build } from "../src/pipeline/build.ts";
import { formatReport } from "../src/pipeline/report.ts";
import type { BuildReport } from "../src/pipeline/report.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(TEST_DIR);
const FEATURES_DIR = path.join(REPO, "src", "features");

/** Minimal strict layout: doctype, site title, and the markdown body. */
const LAYOUT =
  '<!doctype html>\n<html lang="en"><head><title>{{ site.title }}</title></head>' +
  "<body>{{ content | safe }}</body></html>\n";

/** A two-page fixture (index + post), a public asset, and a layout. */
const PROJECT: Record<string, string> = {
  "templates/post.html": LAYOUT,
  "content/index.md": "---\ntitle: Home\n---\nHello **world**.",
  "content/posts/p.md": "---\ntitle: Post\ndate: 2026-01-01\n---\nBody text.",
  "public/app.css": "body{}",
};

interface Captured<T> {
  value: T;
  stdout: string;
  stderr: string;
}

/**
 * Run `fn` with `process.stdout`/`process.stderr` writes captured (withheld
 * from the runner's stream) so printed reports and usage errors can be
 * asserted verbatim; the original streams are restored even when `fn` throws.
 */
async function capture<T>(fn: () => Promise<T>): Promise<Captured<T>> {
  const out: string[] = [];
  const err: string[] = [];
  const previousOut = process.stdout.write;
  const previousErr = process.stderr.write;
  process.stdout.write = ((chunk: unknown): boolean => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown): boolean => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const value = await fn();
    return { value, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = previousOut;
    process.stderr.write = previousErr;
  }
}

interface CommandRun {
  stdout: string;
  stderr: string;
  /** The `process.exitCode` this invocation left behind (`undefined` = 0). */
  exitCode: number | string | undefined;
}

/** Invoke `kiln build`'s `run` in-process with streams + exitCode captured. */
async function runCommand(args: string[]): Promise<CommandRun> {
  const previousExit = process.exitCode;
  process.exitCode = undefined;
  try {
    const captured = await capture(() => runBuildCommand(args));
    return {
      stdout: captured.stdout,
      stderr: captured.stderr,
      exitCode: process.exitCode,
    };
  } finally {
    process.exitCode = previousExit;
  }
}

/**
 * Materialize a project in the OS temp dir, chdir into it (T010 resolves
 * `templates/` against the cwd), run `fn`, then restore the cwd and clean up
 * — even when `fn` throws.
 */
async function withProject<T>(
  files: Record<string, string>,
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "kiln-build-"));
  try {
    for (const [name, source] of Object.entries(files)) {
      const target = path.join(root, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, source);
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

/**
 * Write probe feature modules into the repo's `src/features/`, run `fn`,
 * then delete them — cleanup runs even when `fn` or an assertion throws. The
 * directory itself is dropped only when these probes emptied it, so a repo
 * that already has real features keeps them.
 */
async function withFeatures<T>(
  files: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  await mkdir(FEATURES_DIR, { recursive: true });
  const targets = Object.keys(files).map((file) => path.join(FEATURES_DIR, file));
  for (const [file, source] of Object.entries(files)) {
    await writeFile(path.join(FEATURES_DIR, file), source);
  }
  try {
    return await fn();
  } finally {
    await Promise.all(targets.map((target) => rm(target, { force: true })));
    if ((await readdir(FEATURES_DIR)).length === 0) {
      await rm(FEATURES_DIR, { recursive: true });
    }
  }
}

test("fixture project: build emits both pages, copies assets, prints the report", async () => {
  await withProject(PROJECT, async (root) => {
    const { value: report, stdout } = await capture(() => build());

    assert.equal(report.emitted.length, 2);
    assert.equal(report.skipped.length, 0);
    assert.deepEqual(report.featureErrors, []);
    assert.equal(typeof report.durationMs, "number");
    assert.ok(report.durationMs >= 0);

    // The printed report: always-present lines, no feature-error block.
    assert.match(stdout, /^kiln build$/m);
    assert.match(stdout, /^ {2}pages emitted: 2$/m);
    assert.match(stdout, /^ {2}pages skipped \(cache\): 0$/m);
    assert.match(stdout, /^ {2}duration: \d+ms$/m);
    assert.doesNotMatch(stdout, /feature errors/);

    // Output tree: pages + public asset.
    await readFile(path.join(root, "dist", "index.html"), "utf8");
    await readFile(path.join(root, "dist", "app.css"), "utf8");
    await readFile(path.join(root, "dist", "posts", "p", "index.html"), "utf8");
  });
});

test("auto-discovery probe: onBuildEnd writes dist/probe.marker; deleting it restores a green build", async () => {
  const PROBE = [
    'import { writeFile } from "node:fs/promises";',
    'import path from "node:path";',
    "export default {",
    "  onBuildEnd(result, ctx) {",
    "    return writeFile(",
    '      path.join(result.distDir, "probe.marker"),',
    '      ctx.name + "|" + ctx.flags.drafts + "|" + ctx.flags.future,',
    "    );",
    "  },",
    "};",
    "",
  ].join("\n");

  await withProject(PROJECT, async (root) => {
    await withFeatures({ "__probe.ts": PROBE }, async () => {
      const { value: report } = await capture(() =>
        build({ flags: { drafts: true, future: true, noCache: true } }),
      );
      assert.deepEqual(report.featureErrors, []);
      assert.equal(report.emitted.length, 2);

      // The hook ran, knew its own stem, and saw the build's flags.
      const marker = await readFile(
        path.join(root, "dist", "probe.marker"),
        "utf8",
      );
      assert.equal(marker, "__probe|true|true");
    });

    // Cleanup removed the probe: a fresh build discovers zero features.
    const { value: again } = await capture(() => build());
    assert.deepEqual(again.featureErrors, []);
    assert.equal(again.emitted.length, 2);
    assert.equal(again.skipped.length, 0);
  });
});

test("ordering proof: sorted filenames — __a before __z — yield title AZ", async () => {
  const A = "export default { onSite(site) { site.data.title = 'A'; } };";
  const Z = [
    'import { writeFile } from "node:fs/promises";',
    'import path from "node:path";',
    "export default {",
    "  onSite(site) { site.data.title = String(site.data.title) + 'Z'; },",
    "  onBuildEnd(result) {",
    "    return writeFile(",
    '      path.join(result.distDir, "title.txt"),',
    "      String(result.site.data.title),",
    "    );",
    "  },",
    "};",
    "",
  ].join("\n");

  await withProject(PROJECT, async (root) => {
    await withFeatures({ "__a.ts": A, "__z.ts": Z }, async () => {
      const { value: report } = await capture(() => build());
      assert.deepEqual(report.featureErrors, []);
      const title = await readFile(path.join(root, "dist", "title.txt"), "utf8");
      assert.equal(title, "AZ");
    });
  });
});

test("feature failure in onSite: report recorded, build stops before emit, command exits 1", async () => {
  const BAD = "export default { onSite() { throw new Error('boom'); } };";

  await withProject(PROJECT, async () => {
    await withFeatures({ "__bad.ts": BAD }, async () => {
      const { value: report, stdout } = await capture(() => build());

      // Returned, not thrown: one failure, partial counts, printed report.
      assert.equal(report.featureErrors.length, 1);
      assert.equal(report.featureErrors[0].feature, "src/features/__bad.ts");
      assert.equal(report.featureErrors[0].hook, "onSite");
      assert.equal(report.featureErrors[0].message, "boom");
      assert.equal(report.emitted.length, 0);
      assert.match(stdout, /^ {2}pages emitted: 0$/m);
      assert.match(stdout, /^ {2}feature errors: 1$/m);
      assert.match(stdout, /^ {4}src\/features\/__bad\.ts \(onSite\): boom$/m);

      // The command maps non-empty featureErrors to exit code 1.
      const failed = await runCommand([]);
      assert.equal(failed.exitCode, 1);
      assert.match(failed.stdout, /src\/features\/__bad\.ts \(onSite\): boom/);
    });
  });
});

test("invalid feature module (no default export): load error names the file, command exits 1", async () => {
  await withProject(PROJECT, async () => {
    await withFeatures({ "__nodefault.ts": "export const notAFeature = 1;\n" }, async () => {
      const { value: report, stdout } = await capture(() => build());

      assert.equal(report.featureErrors.length, 1);
      assert.equal(report.featureErrors[0].feature, "src/features/__nodefault.ts");
      assert.equal(report.featureErrors[0].hook, "load");
      assert.match(report.featureErrors[0].message, /default export/);
      assert.equal(report.emitted.length, 0); // aborted before any emit stage
      assert.match(stdout, /^ {4}src\/features\/__nodefault\.ts \(load\):/m);

      const failed = await runCommand([]);
      assert.equal(failed.exitCode, 1);
      assert.match(failed.stdout, /src\/features\/__nodefault\.ts/);
    });
  });
});

test("ctx.options validation failure is prefixed features.__opt: and records the hook", async () => {
  const OPT = [
    "export default {",
    "  onSite(site, ctx) {",
    "    ctx.options((raw) => {",
    '      if (raw !== "nope") throw new Error(`unexpected value: ${String(raw)}`);',
    '      throw new Error("must be an object");',
    "    });",
    "  },",
    "};",
    "",
  ].join("\n");
  const withConfig = {
    ...PROJECT,
    "kiln.config.ts": 'export default { features: { __opt: "nope" } };',
  };

  await withProject(withConfig, async () => {
    await withFeatures({ "__opt.ts": OPT }, async () => {
      const { value: report, stdout } = await capture(() => build());
      assert.equal(report.featureErrors.length, 1);
      // Exact message proves the validator saw the raw config value untouched
      // (an undefined pass-through would read `unexpected value: undefined`).
      assert.equal(
        report.featureErrors[0].message,
        "features.__opt: must be an object",
      );
      assert.match(stdout, /^ {4}src\/features\/__opt\.ts \(onSite\): features\.__opt: must be an object$/m);
    });
  });
});

test("empty content directory: build throws 'no markdown files found'", async () => {
  await withProject(
    { "templates/post.html": LAYOUT, "content/.keep": "" },
    async () => {
      await assert.rejects(() => build(), /no markdown files found/);
    },
  );
});

test("missing content directory: build throws 'content directory not found'", async () => {
  await withProject({ "templates/post.html": LAYOUT }, async () => {
    await assert.rejects(() => build(), /content directory not found/);
  });
});

test("layout: bogus fails the build with 'template not found' naming it", async () => {
  const badLayout = {
    ...PROJECT,
    "content/index.md": "---\ntitle: Home\nlayout: bogus\n---\nHi",
  };
  await withProject(badLayout, async () => {
    await assert.rejects(
      () => build(),
      /template not found: "bogus\.html"/,
    );
  });
});

test("two sequential builds in one process are safe; cache skips the second (watch-mode precondition)", async () => {
  await withProject(PROJECT, async () => {
    const first = await capture(() => build());
    const second = await capture(() => build());
    // Both runs must account for the identical page set — emitted on a
    // cold build, cache-skipped on the warm one (T029).
    assert.deepEqual(
      [...second.value.emitted, ...second.value.skipped],
      [...first.value.emitted, ...first.value.skipped],
    );
    assert.equal(second.value.emitted.length, 0);
    assert.equal(second.value.skipped.length, first.value.emitted.length);
    assert.deepEqual(second.value.featureErrors, []);
  });
});

test("command flags: unknown flag or positional → usage on stderr, exit 2", async () => {
  for (const bad of [["--bogus"], ["extra"]]) {
    const run = await runCommand(bad);
    assert.equal(run.exitCode, 2);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /^kiln: build: unknown argument /m);
    assert.match(run.stderr, /^usage: kiln build \[--drafts\] \[--future\] \[--no-cache\]$/m);
  }
});

test("command --no-cache: accepted, exit 0, report shows zero cache skips", async () => {
  await withProject(PROJECT, async () => {
    const run = await runCommand(["--no-cache"]);
    assert.equal(run.exitCode, undefined); // untouched → success
    assert.match(run.stdout, /^kiln build$/m);
    assert.match(run.stdout, /^ {2}pages emitted: 2$/m);
    assert.match(run.stdout, /^ {2}pages skipped \(cache\): 0$/m);
  });
});

test("extendMarkdown seam: a feature plugin's markup reaches every emitted page", async () => {
  const MD = [
    "export default {",
    "  extendMarkdown(md) {",
    '    md.renderer.rules.strong_open = () => "<strong data-probe>";',
    '    md.renderer.rules.strong_close = () => "</strong>";',
    "  },",
    "};",
    "",
  ].join("\n");

  await withProject(PROJECT, async (root) => {
    await withFeatures({ "__md.ts": MD }, async () => {
      const { value: report } = await capture(() => build());
      assert.deepEqual(report.featureErrors, []);
      assert.equal(report.emitted.length, 2);
      // Both pages rendered through the registered plugin (fresh renderer
      // per page), and the layout phase survived the mutation.
      const index = await readFile(path.join(root, "dist", "index.html"), "utf8");
      assert.match(index, /<strong data-probe>world<\/strong>/);
      await readFile(path.join(root, "dist", "posts", "p", "index.html"), "utf8");
    });
  });
});

test("extendMarkdown sync throw: recorded as a feature failure, emit aborted", async () => {
  const MDBAD = [
    "export default {",
    "  extendMarkdown() {",
    "    throw new Error('md boom');",
    "  },",
    "};",
    "",
  ].join("\n");

  await withProject(PROJECT, async () => {
    await withFeatures({ "__mdbad.ts": MDBAD }, async () => {
      const { value: report, stdout } = await capture(() => build());
      assert.equal(report.featureErrors.length, 1);
      assert.equal(report.featureErrors[0].hook, "extendMarkdown");
      assert.equal(report.featureErrors[0].feature, "src/features/__mdbad.ts");
      assert.equal(report.featureErrors[0].message, "md boom");
      assert.equal(report.emitted.length, 0); // stopped mid-emit
      assert.match(stdout, /^ {4}src\/features\/__mdbad\.ts \(extendMarkdown\): md boom$/m);
    });
  });
});

test("extendMarkdown async rejection: honored after emit, later stages skipped", async () => {
  const MDASYNC = [
    "export default {",
    "  async extendMarkdown() {",
    "    await null;",
    "    throw new Error('late boom');",
    "  },",
    "};",
    "",
  ].join("\n");

  await withProject(PROJECT, async (root) => {
    await withFeatures({ "__mdasync.ts": MDASYNC }, async () => {
      const { value: report } = await capture(() => build());
      assert.equal(report.featureErrors.length, 1);
      assert.equal(report.featureErrors[0].hook, "extendMarkdown");
      assert.equal(report.featureErrors[0].message, "late boom");
      // The sync render seam could not abort, so pages were written — but
      // copyAssets/record/onBuildEnd never ran (app.css absent).
      assert.equal(report.emitted.length, 2);
      await assert.rejects(readFile(path.join(root, "dist", "app.css"), "utf8"));
    });
  });
});

test("formatReport: always-present lines, feature-error block with doc annotation", () => {
  const sample: BuildReport = {
    emitted: [
      { url: "/", file: "index.html" },
      { url: "/posts/p/", file: "posts/p/index.html" },
    ],
    skipped: [{ url: "/about/", file: "about/index.html" }],
    durationMs: 412,
    featureErrors: [],
  };
  assert.equal(
    formatReport(sample),
    [
      "kiln build",
      "  pages emitted: 2",
      "  pages skipped (cache): 1",
      "  duration: 412ms",
    ].join("\n"),
  );

  const failed: BuildReport = {
    ...sample,
    featureErrors: [
      {
        feature: "src/features/feed.ts",
        hook: "onSite",
        message: "features.feed: bad option",
      },
      {
        feature: "src/features/toc.ts",
        hook: "onDocument",
        message: "boom",
        doc: "/abs/content/post.md",
      },
    ],
  };
  assert.equal(
    formatReport(failed),
    [
      "kiln build",
      "  pages emitted: 2",
      "  pages skipped (cache): 1",
      "  duration: 412ms",
      "  feature errors: 2",
      "    src/features/feed.ts (onSite): features.feed: bad option",
      "    src/features/toc.ts (onDocument): boom [doc /abs/content/post.md]",
    ].join("\n"),
  );
});
