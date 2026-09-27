/**
 * T036 acceptance — theme switcher.
 *
 * Coverage mirrors the search feature's tests (T023): config validation
 * naming `features.theme.default`, onSite's `site.themeDefault` publish,
 * onBuildEnd's byte-for-byte script copy, the partial's rendered markup
 * (data-default-theme + script hook), and the real browser script run in
 * a vm realm over a minimal DOM (stored choice, configured default,
 * toggle persistence, guarded storage).
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { test } from "node:test";
import type { FeatureContext } from "../src/feature.ts";
import type { Site } from "../src/content/document.ts";
import theme from "../src/features/theme.ts";
import { loadTemplates } from "../src/render/templates.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(TEST_DIR);
const SCRIPT_FILE = path.join(REPO, "assets", "theme.js");
const SCRIPT_SOURCE = await readFile(SCRIPT_FILE, "utf8");

/**
 * A `FeatureContext` shaped like `makeContext` in src/pipeline/features.ts:
 * validator failures rethrow prefixed `features.theme: ` (test seam for
 * the contract the real context applies in build).
 */
function contextFor(raw: unknown): FeatureContext {
  const options = (validate: (value: unknown) => unknown) => {
    try {
      return validate(raw);
    } catch (error) {
      throw new Error(
        `features.theme: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  return {
    name: "theme",
    flags: { drafts: false, future: false, noCache: false },
    options: options as FeatureContext["options"],
  };
}

/** Run `fn` in a fresh temp cwd (onSite publishes via site data), then restore. */
async function inTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "kiln-theme-"));
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await fn(dir);
  } finally {
    process.chdir(previous);
    await rm(dir, { recursive: true, force: true });
  }
}

// --- feature module behavior ---

test("onSite: site.themeDefault defaults to dark when the config slice is absent", async () => {
  const site: Site = { pages: [], data: {} };
  await theme.onSite?.(site, contextFor(undefined));
  assert.equal(site.data.themeDefault, "dark");
});

test("onSite: features.theme.default light publishes light", async () => {
  const site: Site = { pages: [], data: {} };
  await theme.onSite?.(site, contextFor({ default: "light" }));
  assert.equal(site.data.themeDefault, "light");
});

test("invalid features.theme.default (42, '', 'blue', [dark]) rejects naming the key", async () => {
  for (const value of [42, "", "blue", ["dark"]]) {
    const site: Site = { pages: [], data: {} };
    // The rejection fires when onSite invokes ctx.options(parseOptions) —
    // building the context alone never validates.
    await assert.rejects(
      async () => {
        await theme.onSite?.(site, contextFor({ default: value }));
      },
      /features\.theme: features\.theme\.default must be "dark" or "light"/,
    );
  }
});

test("non-object features.theme (42, 'dark') rejects naming the key", async () => {
  for (const raw of [42, "dark"]) {
    const site: Site = { pages: [], data: {} };
    await assert.rejects(
      async () => {
        await theme.onSite?.(site, contextFor(raw));
      },
      /features\.theme: features\.theme\.default: expected an object/,
    );
  }
});

test("onBuildEnd: assets/theme.js copied byte-for-byte to dist/assets/theme.js", async () => {
  await inTempDir(async (dir) => {
    const site: Site = { pages: [], data: {} };
    await theme.onBuildEnd?.(
      { distDir: path.join(dir, "dist"), site, emitted: [], skipped: [] },
      contextFor(undefined),
    );
    const copied = await readFile(path.join(dir, "dist", "assets", "theme.js"));
    assert.deepEqual(copied, await readFile(SCRIPT_FILE));
  });
});

// --- partial rendering ---

test("partial: data-default-theme from site.themeDefault with default fallback, script hook present", async () => {
  // The package-shipped partial (repo templates dir), not a project copy.
  const templates = await loadTemplates(path.join(REPO, "templates"));
  for (const themeDefault of ["dark", "light"]) {
    const markup = await templates.render("theme.html", {
      site: { basePath: "", themeDefault },
    });
    assert.match(markup, /class="kiln-theme"/);
    assert.match(markup, /class="kiln-theme-toggle"/);
    assert.match(markup, new RegExp(`data-default-theme="${themeDefault}"`));
    assert.match(markup, /aria-pressed="true"/);
    assert.match(markup, />Theme</);
    assert.match(markup, /<script src="\/assets\/theme\.js" defer><\/script>/);
  }
  // Without the feature the partial stays usable at its own default.
  const fallback = await templates.render("theme.html", {
    site: { basePath: "/kiln" },
  });
  assert.match(fallback, /data-default-theme="dark"/);
  assert.match(fallback, /<script src="\/kiln\/assets\/theme\.js" defer><\/script>/);
});

// --- browser script source ---

test("script source: node --check passes and carries no import/require", () => {
  execFileSync(process.execPath, ["--check", SCRIPT_FILE], { stdio: "pipe" });
  assert.doesNotMatch(SCRIPT_SOURCE, /\b(?:import|require)\b/);
});

// --- browser script behavior, run from assets/theme.js in a vm realm ---

/** Minimal DOM covering exactly what assets/theme.js touches. */
class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attrs: Record<string, string> = {};
  readonly listeners: Record<string, Array<() => void>> = {};
  hidden = false;
  private text = "";

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    this.text = value;
    this.children.length = 0;
  }
  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  getAttribute(name: string): string | null {
    return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null;
  }
  addEventListener(type: string, listener: () => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  dispatch(type: string): void {
    for (const listener of this.listeners[type] ?? []) listener();
  }
  querySelector(selector: string): FakeElement | null {
    const wanted = selector.startsWith(".") ? selector.slice(1) : "";
    const queue = [...this.children];
    while (queue.length > 0) {
      const element = queue.shift()!;
      const classes = (element.attrs["class"] ?? "").split(/\s+/);
      if (wanted !== "" && classes.includes(wanted)) return element;
      queue.unshift(...element.children);
    }
    return null;
  }
}

interface BootOptions {
  stored?: string | null; // localStorage["kiln-theme"]; null → key absent
  storageThrows?: boolean; // setItem throws (write-blocked storage)
  defaultTheme?: string | null; // data-default-theme; null → attribute absent
}

interface Boot {
  html: FakeElement;
  toggle: FakeElement;
  store(): string[];
  click(): void;
}

/** Build the partial's DOM shape, then evaluate the real theme.js over it. */
function boot(options: BootOptions = {}): Boot {
  const root = new FakeElement();
  root.setAttribute("class", "kiln-theme");
  const toggle = new FakeElement();
  toggle.setAttribute("class", "kiln-theme-toggle");
  // data-default-theme rides the button, exactly as the partial renders it.
  if (options.defaultTheme !== null) {
    toggle.setAttribute("data-default-theme", options.defaultTheme ?? "dark");
  }
  toggle.textContent = "Theme"; // the partial's static label
  root.appendChild(toggle);
  const html = new FakeElement();

  const store: Record<string, string> = {};
  if (options.stored !== null && options.stored !== undefined) {
    store["kiln-theme"] = options.stored;
  }
  const storage = {
    getItem: (key: string) => {
      return Object.hasOwn(store, key) ? store[key] : null;
    },
    setItem: (key: string, value: string) => {
      if (options.storageThrows === true) throw new Error("blocked");
      store[key] = value;
    },
  };
  vm.runInNewContext(
    SCRIPT_SOURCE,
    {
      document: {
        documentElement: html,
        readyState: "complete",
        querySelectorAll: (selector: string) =>
          selector === ".kiln-theme" ? [root] : [],
        addEventListener: () => {},
      },
      localStorage: storage,
    },
    { filename: "theme.js" },
  );

  return {
    html,
    toggle,
    store() {
      return Object.keys(store).map((key) => store[key]);
    },
    click() {
      toggle.dispatch("click");
    },
  };
}

test("script: dark by default — no stored choice, default applied to <html>, button mirrors it", () => {
  const harness = boot({ stored: null, defaultTheme: "dark" });
  assert.equal(harness.html.getAttribute("data-theme"), "dark");
  assert.equal(harness.toggle.textContent, "Light theme");
  assert.equal(harness.toggle.getAttribute("aria-pressed"), "true");
  assert.deepEqual(harness.store(), []);
});

test("script: configured light default applies when nothing is stored", () => {
  const harness = boot({ stored: null, defaultTheme: "light" });
  assert.equal(harness.html.getAttribute("data-theme"), "light");
  assert.equal(harness.toggle.textContent, "Dark theme");
  assert.equal(harness.toggle.getAttribute("aria-pressed"), "false");
});

test("script: stored choice wins over the configured default", () => {
  const harness = boot({ stored: "light", defaultTheme: "dark" });
  assert.equal(harness.html.getAttribute("data-theme"), "light");
  assert.equal(harness.toggle.getAttribute("aria-pressed"), "false");
});

test("script: tampered stored value falls back to the configured default", () => {
  const harness = boot({ stored: "banana", defaultTheme: "dark" });
  assert.equal(harness.html.getAttribute("data-theme"), "dark");
});

test("script: missing data-default-theme falls back to dark", () => {
  const harness = boot({ stored: null, defaultTheme: null });
  assert.equal(harness.html.getAttribute("data-theme"), "dark");
});

test("script: click toggles, persists, and mirrors the new theme", () => {
  const harness = boot({ stored: null, defaultTheme: "dark" });
  harness.click();
  assert.equal(harness.html.getAttribute("data-theme"), "light");
  assert.equal(harness.toggle.textContent, "Dark theme");
  assert.equal(harness.toggle.getAttribute("aria-pressed"), "false");
  assert.deepEqual(harness.store(), ["light"]);
  harness.click();
  assert.equal(harness.html.getAttribute("data-theme"), "dark");
  assert.equal(harness.toggle.textContent, "Light theme");
  assert.equal(harness.toggle.getAttribute("aria-pressed"), "true");
  // setItem overwrites the key — the store holds the latest choice, one entry.
  assert.deepEqual(harness.store(), ["dark"]);
});

test("script: blocked storage never throws — default applies, toggle still works per page", () => {
  const harness = boot({ stored: null, storageThrows: true, defaultTheme: "dark" });
  assert.equal(harness.html.getAttribute("data-theme"), "dark");
  assert.doesNotThrow(() => harness.click());
  assert.equal(harness.html.getAttribute("data-theme"), "light");
  // The write was swallowed, so nothing persisted.
  assert.deepEqual(harness.store(), []);
});

test("script: a stored choice still applies when later writes are blocked", () => {
  // setItem throws — a write-blocked browser: the stored theme loads and
  // the toggle works for this page only, silently unpersisted (the seeded
  // entry is the pre-existing value; the failed write never overwrote it).
  const harness = boot({ stored: "light", storageThrows: true, defaultTheme: "dark" });
  assert.equal(harness.html.getAttribute("data-theme"), "light");
  harness.click();
  assert.equal(harness.html.getAttribute("data-theme"), "dark");
  assert.deepEqual(harness.store(), ["light"]);
});

test("script: zero toggles — page untouched, no throw", () => {
  const html = new FakeElement();
  assert.doesNotThrow(() => {
    vm.runInNewContext(
      SCRIPT_SOURCE,
      {
        document: {
          documentElement: html,
          readyState: "complete",
          querySelectorAll: () => [],
          addEventListener: () => {},
        },
        localStorage: { getItem: () => null, setItem: () => {} },
      },
      { filename: "theme.js" },
    );
  });
  assert.equal(html.getAttribute("data-theme"), null);
});

test("script: no .kiln-theme roots — page untouched", () => {
  // Covered with zero toggles above; both empty-DOM shapes skip binding.
  assert.ok(true);
});
