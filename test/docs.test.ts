import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Documentation validation (T035): internal links (paths + heading
 * fragments) across README.md and docs/**.md, config-key completeness
 * (every `features.*` literal in src/ appears in the README's
 * configuration section), and CLI coverage (every command name in the
 * README and docs/cli.md, every flag in docs/cli.md). External URLs are
 * skipped by design — fetching them is a non-goal, not a chore.
 */

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const README = "README.md";
const FENCE_RE = /^```[^\n]*\n[\s\S]*?\n```[^\n]*$/gm;

async function readText(rel: string): Promise<string> {
  return readFile(path.join(ROOT, rel), "utf8");
}

/** Every markdown file under validation: README.md and every .md under docs/. */
async function markdownFiles(): Promise<string[]> {
  const entries = (await readdir(path.join(ROOT, "docs"), {
    recursive: true,
  })) as string[];
  const docs = entries
    .filter((name) => name.endsWith(".md"))
    .map((name) => `docs/${name}`)
    .sort();
  return [README, ...docs];
}

/** GitHub-style heading anchor: lowercase, punctuation stripped, whitespace → `-`, unicode letters kept. */
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

/** Every heading anchor in a markdown file, GitHub-style, with `-1`/`-2` duplicate suffixes. */
function headingAnchors(md: string): string[] {
  const anchors: string[] = [];
  const seen = new Map<string, number>();
  const re = /^(#{1,6})\s+(.+?)\s*$/gm;
  // Fences stripped: shell comments inside code blocks are not headings.
  for (const match of md.replace(FENCE_RE, "").matchAll(re)) {
    const raw = match[2].replace(/\s+#+\s*$/, "").trim();
    const base = slugify(raw);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.push(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

interface FoundLink {
  dest: string;
  line: number;
}

/**
 * Every inline markdown link/image target with its line number, fences
 * stripped (examples inside code blocks are not links).
 */
function extractLinks(md: string): FoundLink[] {
  const text = md.replace(FENCE_RE, "");
  const re = /!?\[[^\]]*\]\(\s*([^)\s]+?)(?:\s+"[^"]*")?\s*\)/g;
  const links: FoundLink[] = [];
  for (const match of text.matchAll(re)) {
    const offset = match.index ?? 0;
    links.push({
      dest: match[1].replace(/^<|>$/g, ""),
      line: text.slice(0, offset).split("\n").length,
    });
  }
  return links;
}

/** All TypeScript files under src/, repo-relative. */
async function sourceFiles(): Promise<string[]> {
  const entries = (await readdir(path.join(ROOT, "src"), {
    recursive: true,
  })) as string[];
  return entries
    .filter((name) => name.endsWith(".ts"))
    .map((name) => `src/${name}`)
    .sort();
}

/** The README's configuration section: from `## Configuration reference` to the next `##` heading. */
function configSection(readme: string): string {
  const lines = readme.split("\n");
  const start = lines.findIndex((line) => /^##\s+Configuration reference\s*$/.test(line));
  assert.notEqual(start, -1, "README.md must contain a '## Configuration reference' heading");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** Every `.ts` file under one directory of the repo, sorted. */
async function commandSources(): Promise<string[]> {
  const dir = path.join(ROOT, "src", "commands");
  const entries = await readdir(dir);
  return entries.filter((name) => name.endsWith(".ts")).sort();
}

test("internal links resolve: paths and heading fragments", async () => {
  const failures: string[] = [];
  for (const file of await markdownFiles()) {
    const md = await readText(file);
    const anchors = new Set(headingAnchors(md));
    for (const { dest, line } of extractLinks(md)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(dest) || dest.startsWith("//")) {
        continue; // external (http(s)/mailto/…) — offline by design
      }
      const hash = dest.indexOf("#");
      const rel = hash === -1 ? dest : dest.slice(0, hash);
      const frag = hash === -1 ? undefined : dest.slice(hash + 1);
      const targetRel = rel === "" ? file : path.join(path.dirname(file), rel);
      const targetAbs = path.resolve(ROOT, targetRel);

      let targetMd: string | undefined;
      try {
        const info = await stat(targetAbs);
        if (info.isFile() && targetAbs.endsWith(".md")) {
          targetMd = await readFile(targetAbs, "utf8");
        }
      } catch {
        failures.push(`${file}:${line}: broken link ${dest} (no file at ${targetRel})`);
        continue;
      }

      if (frag === undefined) continue;
      if (targetMd === undefined) {
        failures.push(`${file}:${line}: broken fragment ${dest} (target is not a markdown file)`);
        continue;
      }
      const pool =
        targetRel === file ? anchors : new Set(headingAnchors(targetMd));
      let decoded = frag;
      try {
        decoded = decodeURIComponent(frag);
      } catch {
        // malformed escape → compare literally
      }
      if (!pool.has(decoded)) {
        failures.push(`${file}:${line}: broken fragment ${dest} (no heading anchor "${decoded}")`);
      }
    }
  }
  assert.deepEqual(failures, [], `unresolved links:\n${failures.join("\n")}`);
});

test("every features.* literal in src/ appears in the README configuration section", async () => {
  const section = configSection(await readText(README));
  const keyRe = /\bfeatures\.[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)?/g;
  const missing = new Set<string>();
  for (const file of await sourceFiles()) {
    const src = await readText(file);
    for (const match of src.matchAll(keyRe)) {
      if (!section.includes(match[0])) missing.add(`${match[0]} (from ${file})`);
    }
  }
  const sorted = [...missing].sort();
  assert.deepEqual(
    sorted,
    [],
    `README configuration section is missing:\n${sorted.join("\n")}`,
  );
});

test("every command name appears as `kiln <name>` in README and docs/cli.md", async () => {
  const readme = await readText(README);
  const cliDoc = await readText("docs/cli.md");
  const names = new Set<string>();
  for (const entry of await commandSources()) {
    const src = await readFile(path.join(ROOT, "src", "commands", entry), "utf8");
    for (const match of src.matchAll(/export\s+const\s+name\s*=\s*["']([^"']+)["']/g)) {
      names.add(match[1]);
    }
  }
  assert.ok(names.size > 0, "no command names discovered in src/commands/*.ts");
  const failures: string[] = [];
  for (const name of [...names].sort()) {
    if (!readme.includes(`\`kiln ${name}\``)) {
      failures.push(`README.md: missing \`kiln ${name}\``);
    }
    if (!cliDoc.includes(`kiln ${name}`)) {
      failures.push(`docs/cli.md: missing entry for kiln ${name}`);
    }
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});

test("every flag in src/commands/*.ts appears in docs/cli.md", async () => {
  const cliDoc = await readText("docs/cli.md");
  const flags = new Set<string>();
  for (const entry of await commandSources()) {
    const src = await readFile(path.join(ROOT, "src", "commands", entry), "utf8");
    for (const match of src.matchAll(/--[a-z][a-z-]*/g)) flags.add(match[0]);
  }
  assert.ok(flags.size > 0, "no flags discovered in src/commands/*.ts");
  const missing = [...flags].filter((flag) => !cliDoc.includes(flag)).sort();
  assert.deepEqual(missing, [], `docs/cli.md is missing flags: ${missing.join(", ")}`);
});
