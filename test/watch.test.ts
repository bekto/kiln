/**
 * T027 acceptance — watcher & incremental rebuild.
 *
 * Every test materializes a fixture site in the OS temp dir, chdirs into it
 * (T010 resolves `templates/` against the cwd, exactly as `kiln build`
 * does in normal use), captures stdout/stderr, and drives the watcher through
 * `startWatching(loadConfig(root))`. Rebuild counts come from `onAfterRebuild`
 * (the same seam T028 consumes), never from parsing build output.
 *
 * Timing is deliberately tolerant: debounce windows are waited out with
 * generous settles (a missing extra rebuild is proven by sleeping several
 * windows past the expected count), and every wait has a long timeout. The
 * suite runs under `--test-concurrency=1`, so the probe feature written into
 * `src/features/` for the queueing test cannot race other files.
 */
import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import { build } from "../src/pipeline/build.ts";
import type { AfterRebuild } from "../src/watch.ts";
import { onAfterRebuild, startWatching } from "../src/watch.ts";

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

/** Same fixture with no `public/` — exercises the missing-root warning. */
const NO_PUBLIC: Record<string, string> = {
  "templates/post.html": LAYOUT,
  "content/index.md": "---\ntitle: Home\n---\nHello **world**.",
  "content/posts/p.md": "---\ntitle: Post\ndate: 2026-01-01\n---\nBody text.",
};

/**
 * Probe feature: sleeps 300 ms per page in `onDocument` (before emit, so a
 * cache can never make the rebuild fast), stretching every rebuild in the
 * queueing test well past its debounce window.
 */
const SLOW_FEATURE = [
  "export default {",
  "  async onDocument() {",
  "    await new Promise((resolve) => setTimeout(resolve, 300));",
  "  },",
  "};",
  "",
].join("\n");

interface Captured<T> {
  value: T;
  stdout: string;
  stderr: string;
}

/**
 * Run `fn` with `process.stdout`/`process.stderr` writes captured (withheld
 * from the runner's stream) so printed reports, rebuild lines, and warnings
 * can be asserted verbatim; the original streams are restored even when
 * `fn` throws.
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

/**
 * Materialize a project in the OS temp dir, chdir into it, run `fn`, then
 * restore the cwd and clean up — even when `fn` throws.
 */
async function withProject<T>(
  files: Record<string, string>,
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "kiln-watch-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const target = path.join(root, rel);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
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
 * Poll `condition` every 25 ms until it holds or `timeoutMs` elapses.
 *
 * Real wall-clock waits, deliberately — the exception this suite is built
 * on: the debounce timer lives inside the watcher module and its trigger is
 * real inotify delivery, so fake timers cannot advance either. Waits poll
 * for the expected condition; the fixed sleeps only ever prove that NO
 * further activity arrives (the acceptance criterion itself is temporal).
 */
async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(25);
  }
}

/** Overwrite the home page's body — one watched content-file change. */
async function editContent(root: string, body: string): Promise<void> {
  await writeFile(
    path.join(root, "content", "index.md"),
    `---\ntitle: Home\n---\n${body}\n`,
    "utf8",
  );
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** Collect `onAfterRebuild` results for one test; call `off()` in `finally`. */
function collectRebuilds(): { events: AfterRebuild[]; off: () => void } {
  const events: AfterRebuild[] = [];
  const off = onAfterRebuild((result) => {
    events.push(result);
  });
  return { events, off };
}

test("editing a content file yields exactly one rebuild and prints its duration", async () => {
  await withProject(PROJECT, async (root) => {
    const { events, off } = collectRebuilds();
    try {
      const { stdout } = await capture(async () => {
        const config = await loadConfig(root);
        const handle = startWatching(config);
        try {
          await editContent(root, "edited once");
          await waitFor(() => events.length >= 1, 8000, "the rebuild");
          await sleep(400); // 4× debounce: a second rebuild would surface here
          assert.equal(events.length, 1, "one edit must yield exactly one rebuild");
        } finally {
          await handle.close();
        }
      });
      assert.match(stdout, /rebuild in \d+ms/);
      assert.match(stdout, /pages emitted: \d+/);
      assert.match(stdout, /pages skipped \(cache\): \d+/);
      const first = events[0];
      assert.equal(first?.ok, true);
      assert.equal(first?.error, undefined);
      assert.equal(typeof first?.report?.durationMs, "number");
      assert.ok(Array.isArray(first?.report?.emitted));
    } finally {
      off();
    }
  });
});

test("debounce windows: edits 30ms apart coalesce; 500ms apart rebuild twice", async () => {
  await withProject(PROJECT, async (root) => {
    const { events, off } = collectRebuilds();
    try {
      await capture(async () => {
        const config = await loadConfig(root);
        const handle = startWatching(config);
        try {
          await editContent(root, "burst one");
          await sleep(30);
          await editContent(root, "burst two");
          await waitFor(() => events.length >= 1, 8000, "the coalesced rebuild");
          await sleep(400);
          assert.equal(
            events.length,
            1,
            "two edits 30ms apart must produce one rebuild",
          );

          await editContent(root, "solo one");
          await waitFor(() => events.length >= 2, 8000, "first solo rebuild");
          await sleep(500); // the second edit sits 500ms+ after the first
          await editContent(root, "solo two");
          await waitFor(() => events.length >= 3, 8000, "second solo rebuild");
          await sleep(400);
          assert.equal(
            events.length,
            3,
            "two edits 500ms apart (after the earlier burst) must each rebuild",
          );
        } finally {
          await handle.close();
        }
      });
    } finally {
      off();
    }
  });
});

test("watch.debounceMs: 500 widens the coalescing window", async () => {
  const files: Record<string, string> = {
    ...PROJECT,
    "kiln.config.ts": 'export default { watch: { debounceMs: 500 } };\n',
  };
  await withProject(files, async (root) => {
    const { events, off } = collectRebuilds();
    try {
      await capture(async () => {
        const config = await loadConfig(root);
        assert.equal(config.watch.debounceMs, 500);
        const handle = startWatching(config);
        try {
          await editContent(root, "wide one");
          await sleep(300); // inside the 500ms window; default 100 would fire
          await editContent(root, "wide two");
          await waitFor(() => events.length >= 1, 8000, "the coalesced rebuild");
          await sleep(1500); // 3× the widened window: nothing else may fire
          assert.equal(
            events.length,
            1,
            "edits 300ms apart must coalesce when debounceMs is 500",
          );
        } finally {
          await handle.close();
        }
      });
    } finally {
      off();
    }
  });
});

test("deleting a content file prunes its output; unmapped outputs survive", async () => {
  await withProject(PROJECT, async (root) => {
    const { events, off } = collectRebuilds();
    try {
      const { stdout } = await capture(async () => {
        await build(); // seed dist/ so deletion has an output to lose
        await mkdir(path.join(root, "dist", "stray"), { recursive: true });
        await writeFile(
          path.join(root, "dist", "stray", "index.html"),
          "<p>stale</p>",
        );
        await writeFile(path.join(root, "dist", "notes.txt"), "keep me");
        const config = await loadConfig(root);
        const handle = startWatching(config);
        try {
          await rm(path.join(root, "content", "posts", "p.md"));
          await waitFor(() => events.length >= 1, 8000, "the rebuild");
          await sleep(400);
          assert.equal(events.length, 1);
          assert.equal(events[0]?.ok, true);
          assert.equal(
            await exists(path.join(root, "dist", "posts", "p", "index.html")),
            false,
            "the deleted source's output page must be pruned",
          );
          assert.equal(
            await exists(path.join(root, "dist", "index.html")),
            true,
            "a living page's output stays",
          );
          assert.equal(
            await exists(path.join(root, "dist", "stray", "index.html")),
            false,
            "a page-shaped output with no source is pruned",
          );
          assert.equal(
            await exists(path.join(root, "dist", "notes.txt")),
            true,
            "an output that cannot map to a source is never pruned",
          );
          assert.equal(
            await exists(path.join(root, "dist", "app.css")),
            true,
            "static assets are re-copied, never pruned",
          );
        } finally {
          await handle.close();
        }
      });
      assert.match(stdout, /rebuild in \d+ms/);
    } finally {
      off();
    }
  });
});

test("renaming a content file: one rebuild, old output gone, new present", async () => {
  await withProject(PROJECT, async (root) => {
    const { events, off } = collectRebuilds();
    try {
      await capture(async () => {
        await build(); // seed dist/
        const config = await loadConfig(root);
        const handle = startWatching(config);
        try {
          await rename(
            path.join(root, "content", "posts", "p.md"),
            path.join(root, "content", "posts", "r.md"),
          );
          await waitFor(() => events.length >= 1, 8000, "the rebuild");
          await sleep(400);
          assert.equal(
            events.length,
            1,
            "an atomic rename must land as exactly one rebuild",
          );
          assert.equal(events[0]?.ok, true);
          assert.equal(
            await exists(path.join(root, "dist", "posts", "p", "index.html")),
            false,
            "the old output must be gone",
          );
          assert.equal(
            await exists(path.join(root, "dist", "posts", "r", "index.html")),
            true,
            "the new output must be present",
          );
        } finally {
          await handle.close();
        }
      });
    } finally {
      off();
    }
  });
});

test("a broken template fails a rebuild on stderr; fixing it rebuilds green", async () => {
  await withProject(PROJECT, async (root) => {
    const { events, off } = collectRebuilds();
    try {
      const { stdout, stderr } = await capture(async () => {
        const config = await loadConfig(root);
        const handle = startWatching(config);
        try {
          await writeFile(path.join(root, "templates", "post.html"), "{{ broken");
          await waitFor(() => events.length >= 1, 8000, "the failed rebuild");
          assert.equal(events[0]?.ok, false);
          assert.notEqual(events[0]?.error, undefined);

          await writeFile(path.join(root, "templates", "post.html"), LAYOUT);
          await waitFor(() => events.length >= 2, 8000, "the recovering rebuild");
          await sleep(400);
          assert.equal(events.length, 2, "exactly the break and the fix rebuild");
          assert.equal(events[1]?.ok, true);
        } finally {
          await handle.close(); // the handle survived the failed rebuild
        }
      });
      assert.match(stderr, /rebuild failed in \d+ms: .+/);
      assert.match(stdout, /rebuild in \d+ms/);
    } finally {
      off();
    }
  });
});

test("editor noise and dist writes trigger no rebuild; a real edit still does", async () => {
  await withProject(PROJECT, async (root) => {
    const { events, off } = collectRebuilds();
    try {
      await capture(async () => {
        await build(); // dist/ must exist so the test can write into it
        const config = await loadConfig(root);
        const handle = startWatching(config);
        try {
          await writeFile(path.join(root, "content", "a.md~"), "temp\n");
          await writeFile(path.join(root, "content", ".a.md.swp"), "swap\n");
          await writeFile(path.join(root, "content", "b.tmp"), "tmp\n");
          await writeFile(path.join(root, "content", "c.part"), "part\n");
          await writeFile(path.join(root, "content", "posts", "d.md~"), "temp\n");
          await writeFile(path.join(root, "dist", "out.html"), "<p>output</p>");
          await sleep(700); // 7× debounceMs: every filtered event stays silent
          assert.equal(events.length, 0, "noise and dist writes must not rebuild");

          await editContent(root, "a real edit");
          await waitFor(() => events.length >= 1, 8000, "the real rebuild");
          await sleep(400);
          assert.equal(events.length, 1, "the watcher stays live after filtering");
        } finally {
          await handle.close();
        }
      });
    } finally {
      off();
    }
  });
});

test("events during a rebuild defer to exactly one follow-up rebuild", async () => {
  await withProject(PROJECT, async (root) => {
    const probe = path.join(FEATURES_DIR, "__watchslow.ts");
    await writeFile(probe, SLOW_FEATURE, "utf8");
    const { events, off } = collectRebuilds();
    try {
      await capture(async () => {
        const config = await loadConfig(root);
        const handle = startWatching(config);
        try {
          // Rebuild #1 runs ~600ms+ (300ms × 2 pages), so both later edits
          // — in two separate debounce windows — land mid-flight.
          await editContent(root, "slow one");
          await sleep(200);
          await editContent(root, "slow two");
          await sleep(150); // > debounceMs apart from the previous edit
          await editContent(root, "slow three");
          await waitFor(() => events.length >= 2, 15000, "the follow-up rebuild");
          await sleep(600); // any wrongly-per-event rebuild would surface here
          assert.equal(
            events.length,
            2,
            "queued events must collapse into exactly one follow-up",
          );
          assert.ok(events.every((event) => event.ok === true));
        } finally {
          await handle.close();
        }
      });
    } finally {
      off();
      await rm(probe, { force: true });
    }
  });
});

test("a missing root warns by name while the remaining roots keep watching", async () => {
  await withProject(NO_PUBLIC, async (root) => {
    const { events, off } = collectRebuilds();
    try {
      const { stderr } = await capture(async () => {
        const config = await loadConfig(root);
        const handle = startWatching(config);
        try {
          await editContent(root, "still watched");
          await waitFor(() => events.length >= 1, 8000, "the rebuild");
          await sleep(400);
          assert.equal(
            events.length,
            1,
            "the existing roots must keep triggering rebuilds",
          );
        } finally {
          await handle.close();
        }
      });
      assert.ok(
        stderr.includes(
          `watch: root ${path.join(root, "public")} does not exist, skipping`,
        ),
        `missing-root warning not found in: ${stderr}`,
      );
    } finally {
      off();
    }
  });
});

test("startWatching with no existing root throws naming all of them", async () => {
  await withProject({}, async (root) => {
    const config = await loadConfig(root);
    assert.throws(
      () => startWatching(config),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return (
          message.includes(config.contentDir) &&
          message.includes(config.templatesDir) &&
          message.includes(config.publicDir)
        );
      },
      "the error must name every watchable root",
    );
  });
});

test("close() resolves: later edits and pending timers never rebuild", async () => {
  await withProject(PROJECT, async (root) => {
    const { events, off } = collectRebuilds();
    try {
      await capture(async () => {
        const config = await loadConfig(root);
        const handle = startWatching(config);
        await editContent(root, "before close");
        await waitFor(() => events.length >= 1, 8000, "the rebuild before close");
        await handle.close();
        await editContent(root, "after close");
        await sleep(500);
        assert.equal(events.length, 1, "no rebuild may follow close()");

        // A debounce timer still pending at close() must be cancelled too.
        const second = startWatching(config);
        await editContent(root, "before quick close");
        await second.close();
        await sleep(500);
        assert.equal(events.length, 1, "a pending timer must not outlive close()");
      });
    } finally {
      off();
    }
  });
});
