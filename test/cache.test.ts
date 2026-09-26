/**
 * T029 acceptance — build cache skip/rebuild decisions.
 *
 * Every scenario runs against a fresh temp project (fresh `dist/`, so a
 * fresh cache): first build captures the page count `N`, later builds assert
 * the split between `report.emitted` and `report.skipped` plus the printed
 * `pages emitted:` / `pages skipped (cache):` lines. Output bytes and mtimes
 * prove skipped pages are left untouched.
 *
 * One scenario needs a subprocess: `readConfig` imports `kiln.config.ts` by
 * file URL, so a rewrite inside this process would still see the cached
 * module — only a fresh process observes a config change. The subprocess
 * imports `build.ts` directly (never `cli.ts`, whose command discovery
 * `test/cli.test.ts` exercises with temporary files).
 *
 * Probe features are written into the repo's `src/features/` and deleted in
 * `finally` (cleanup runs even when an assertion throws).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "../src/pipeline/build.ts";
import type { BuildReport } from "../src/pipeline/report.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(TEST_DIR);
const FEATURES_DIR = path.join(REPO, "src", "features");
const BUILD_URL = pathToFileURL(
  path.join(REPO, "src", "pipeline", "build.ts"),
).href;

/** Minimal strict layout: doctype, site title, and the markdown body. */
const LAYOUT =
  '<!doctype html>\n<html lang="en"><head><title>{{ site.title }}</title></head>' +
  "<body>{{ content | safe }}</body></html>\n";

/** A three-page fixture: home + two posts. */
const PROJECT: Record<string, string> = {
  "templates/post.html": LAYOUT,
  "content/index.md": "---\ntitle: Home\n---\nHello **world**.",
  "content/posts/a.md": "---\ntitle: Post A\ndate: 2026-01-01\n---\nAlpha.",
  "content/posts/b.md": "---\ntitle: Post B\ndate: 2026-01-02\n---\nBeta.",
};

const PLAIN_FLAGS = { drafts: false, future: false, noCache: false };
const NO_CACHE_FLAGS = { drafts: false, future: false, noCache: true };

const cachePath = (root: string): string =>
  path.join(root, "dist", ".kiln-cache.json");

interface Captured<T> {
  value: T;
  stdout: string;
}

/** Run `fn` with `process.stdout` writes captured (restored even on throw). */
async function capture<T>(fn: () => Promise<T>): Promise<Captured<T>> {
  const out: string[] = [];
  const previous = process.stdout.write;
  process.stdout.write = ((chunk: unknown): boolean => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { value: await fn(), stdout: out.join("") };
  } finally {
    process.stdout.write = previous;
  }
}

/**
 * Materialize a project in the OS temp dir, chdir into it (the config and
 * template seams resolve against the cwd), run `fn`, then restore the cwd
 * and clean up — even when `fn` throws.
 */
async function withProject<T>(
  files: Record<string, string>,
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "kiln-cache-"));
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
 * then delete them — cleanup runs even when `fn` or an assertion throws.
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
      await rm(FEATURES_DIR, { recursive: true, force: true });
    }
  }
}

/** One `build()` with stdout captured. */
async function runBuild(
  flags: { drafts: boolean; future: boolean; noCache: boolean } = PLAIN_FLAGS,
): Promise<Captured<BuildReport>> {
  return capture(() => build({ flags }));
}

/** `pages emitted: X` / `pages skipped (cache): Y` as printed by T012. */
function reportLines(stdout: string): { emitted: number; skipped: number } {
  const emitted = /^ {2}pages emitted: (\d+)$/m.exec(stdout);
  const skipped = /^ {2}pages skipped \(cache\): (\d+)$/m.exec(stdout);
  assert.ok(emitted !== null, `no emitted line in:\n${stdout}`);
  assert.ok(skipped !== null, `no skipped line in:\n${stdout}`);
  return { emitted: Number(emitted[1]), skipped: Number(skipped[1]) };
}

/** Fresh-process `build()` (observes rewritten config files). */
function spawnBuild(root: string): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { build } from ${JSON.stringify(BUILD_URL)};\nawait build();\n`,
    ],
    { cwd: root, encoding: "utf8" },
  );
}

interface OutputSnapshot {
  bytes: Buffer;
  mtimeMs: number;
}

/** Bytes + mtime of every dist-relative output file. */
async function snapshot(
  root: string,
  files: string[],
): Promise<Record<string, OutputSnapshot>> {
  const before: Record<string, OutputSnapshot> = {};
  for (const file of files) {
    const target = path.join(root, "dist", file);
    before[file] = {
      bytes: await readFile(target),
      mtimeMs: (await stat(target)).mtimeMs,
    };
  }
  return before;
}

test("unchanged rebuild: emitted 0, skipped N, bytes and mtimes untouched", async () => {
  await withProject(PROJECT, async (root) => {
    const first = await runBuild();
    assert.deepEqual(first.value.featureErrors, []);
    const n = first.value.emitted.length;
    assert.ok(n >= 3, `expected at least the three fixture pages, got ${n}`);
    assert.equal(first.value.skipped.length, 0);

    // The cache file exists and is well-formed after the first build.
    const cache = JSON.parse(await readFile(cachePath(root), "utf8")) as {
      version: number;
      global: string;
      pages: Record<string, { hash: string }>;
    };
    assert.equal(cache.version, 1);
    assert.equal(typeof cache.global, "string");
    assert.equal(Object.keys(cache.pages).length, n);

    const files = first.value.emitted.map((out) => out.file);
    const before = await snapshot(root, files);

    const second = await runBuild();
    assert.deepEqual(second.value.featureErrors, []);
    // Printed report: the two counts stay separate and both are right.
    assert.deepEqual(reportLines(second.stdout), { emitted: 0, skipped: n });
    // report.skipped holds the page set; report.emitted stays empty.
    assert.deepEqual(second.value.emitted, []);
    assert.deepEqual(
      second.value.skipped.map((out) => out.file).sort(),
      [...files].sort(),
    );

    // Skipped outputs: byte- and mtime-identical.
    const after = await snapshot(root, files);
    for (const file of files) {
      const b = before[file];
      const a = after[file];
      assert.ok(a.bytes.equals(b.bytes), `${file} bytes changed`);
      assert.equal(a.mtimeMs, b.mtimeMs, `${file} mtime changed`);
    }
  });
});

test("editing one content file rebuilds exactly that page", async () => {
  await withProject(PROJECT, async (root) => {
    const first = await runBuild();
    const n = first.value.emitted.length;
    await runBuild(); // warm

    await writeFile(
      path.join(root, "content", "posts", "a.md"),
      "---\ntitle: Post A\ndate: 2026-01-01\n---\nAlpha, edited.",
    );
    const third = await runBuild();
    assert.deepEqual(third.value.featureErrors, []);
    assert.deepEqual(reportLines(third.stdout), { emitted: 1, skipped: n - 1 });
    assert.deepEqual(
      third.value.emitted.map((out) => out.file),
      ["posts/a/index.html"],
    );

    const html = await readFile(
      path.join(root, "dist", "posts", "a", "index.html"),
      "utf8",
    );
    assert.ok(html.includes("Alpha, edited."), "edited page must re-render");
  });
});

test("a missing output file is re-emitted even with a valid cache entry", async () => {
  await withProject(PROJECT, async (root) => {
    const first = await runBuild();
    const n = first.value.emitted.length;
    await runBuild(); // warm

    await rm(path.join(root, "dist", "index.html"));
    const third = await runBuild();
    assert.deepEqual(reportLines(third.stdout), { emitted: 1, skipped: n - 1 });
    assert.deepEqual(
      third.value.emitted.map((out) => out.file),
      ["index.html"],
    );
    await readFile(path.join(root, "dist", "index.html"), "utf8");
  });
});

test("adding, editing, or removing a src/features/* module forces a full rebuild", async () => {
  await withProject(PROJECT, async (root) => {
    const first = await runBuild();
    const n = first.value.emitted.length;
    await runBuild(); // warm
    assert.equal((await runBuild()).value.skipped.length, n);

    await withFeatures({ "__t029_probe.ts": "export default {};\n" }, async () => {
      const added = await runBuild();
      assert.deepEqual(added.value.featureErrors, []);
      assert.deepEqual(reportLines(added.stdout), { emitted: n, skipped: 0 });

      await writeFile(
        path.join(FEATURES_DIR, "__t029_probe.ts"),
        "export default { onSite() {} };\n",
      );
      const edited = await runBuild();
      assert.deepEqual(reportLines(edited.stdout), { emitted: n, skipped: 0 });

      await rm(path.join(FEATURES_DIR, "__t029_probe.ts"));
      const removed = await runBuild();
      assert.deepEqual(reportLines(removed.stdout), { emitted: n, skipped: 0 });
    });
  });
});

test("changing an effective kiln.config.ts value forces a full rebuild", async () => {
  const files = {
    ...PROJECT,
    "kiln.config.ts": 'export default { site: { title: "One" } };\n',
  };
  await withProject(files, async (root) => {
    const first = await runBuild();
    const n = first.value.emitted.length;
    const warm = await runBuild();
    assert.deepEqual(reportLines(warm.stdout), { emitted: 0, skipped: n });

    await writeFile(
      path.join(root, "kiln.config.ts"),
      'export default { site: { title: "Two" } };\n',
    );
    const changed = spawnBuild(root);
    assert.equal(changed.status, 0, changed.stderr);
    assert.deepEqual(reportLines(changed.stdout), { emitted: n, skipped: 0 });

    // A fresh process with the same config reuses the cache it did not write:
    // hashes are deterministic across processes.
    const again = spawnBuild(root);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(reportLines(again.stdout), { emitted: 0, skipped: n });
  });
});

test("toggling --drafts or --future forces a full rebuild (both directions)", async () => {
  await withProject(PROJECT, async (root) => {
    const first = await runBuild();
    const n = first.value.emitted.length;
    const warm = await runBuild();
    assert.deepEqual(reportLines(warm.stdout), { emitted: 0, skipped: n });

    const drafts = await runBuild({ ...PLAIN_FLAGS, drafts: true });
    assert.deepEqual(reportLines(drafts.stdout), { emitted: n, skipped: 0 });

    const future = await runBuild({ ...PLAIN_FLAGS, future: true });
    assert.deepEqual(reportLines(future.stdout), { emitted: n, skipped: 0 });

    const plain = await runBuild();
    assert.deepEqual(reportLines(plain.stdout), { emitted: n, skipped: 0 });
  });
});

test("editing a template file forces a full rebuild", async () => {
  await withProject(PROJECT, async (root) => {
    const first = await runBuild();
    const n = first.value.emitted.length;
    await runBuild(); // warm

    await writeFile(
      path.join(root, "templates", "post.html"),
      `${LAYOUT}<!-- edited -->\n`,
    );
    const third = await runBuild();
    assert.deepEqual(reportLines(third.stdout), { emitted: n, skipped: 0 });
  });
});

test("--no-cache rebuilds every page and leaves the cache byte-identical", async () => {
  await withProject(PROJECT, async (root) => {
    const first = await runBuild();
    const n = first.value.emitted.length;
    await runBuild(); // warm
    const before = await readFile(cachePath(root));

    const uncached = await runBuild(NO_CACHE_FLAGS);
    assert.deepEqual(reportLines(uncached.stdout), { emitted: n, skipped: 0 });

    const after = await readFile(cachePath(root));
    assert.ok(after.equals(before), "cache file must not be rewritten");
  });
});

test("corrupt or missing cache: silent full rebuild, valid file regenerated", async () => {
  await withProject(PROJECT, async (root) => {
    const first = await runBuild();
    const n = first.value.emitted.length;
    await runBuild(); // warm

    // Garbage bytes → no warning, no error, full rebuild, healed file.
    await writeFile(cachePath(root), "garbage, not json at all\n");
    const corrupt = await runBuild();
    assert.deepEqual(corrupt.value.featureErrors, []);
    assert.deepEqual(reportLines(corrupt.stdout), { emitted: n, skipped: 0 });
    const healed = JSON.parse(await readFile(cachePath(root), "utf8")) as {
      version: number;
      global: string;
      pages: Record<string, { hash: string }>;
    };
    assert.equal(healed.version, 1);
    assert.equal(typeof healed.global, "string");
    assert.equal(Object.keys(healed.pages).length, n);

    // Deleted file → equally silent, equally regenerated.
    await rm(cachePath(root));
    const missing = await runBuild();
    assert.deepEqual(reportLines(missing.stdout), { emitted: n, skipped: 0 });
    const recreated = JSON.parse(await readFile(cachePath(root), "utf8")) as {
      version: number;
    };
    assert.equal(recreated.version, 1);
  });
});
