import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { copyAssets } from "../src/render/assets.ts";

const tempRoots: string[] = [];

after(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

/** Create a unique temp project root. */
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kiln-assets-test-"));
  tempRoots.push(root);
  return root;
}

/** Lay out `{ publicDir, distDir }` under a fresh temp root. */
async function makeSite(): Promise<{ publicDir: string; distDir: string }> {
  const root = await makeRoot();
  return { publicDir: path.join(root, "public"), distDir: path.join(root, "dist") };
}

/** Write `content` at POSIX `rel` under `base`, creating parent directories. */
async function writeAt(base: string, rel: string, content: string): Promise<void> {
  const abs = path.join(base, ...rel.split("/"));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

test("mirror: every public file lands in dist with identical bytes, dotfiles included", async () => {
  const { publicDir, distDir } = await makeSite();
  await writeAt(publicDir, "style.css", "body { color: red; }\n");
  await writeAt(publicDir, "img/logo.png", "fake-png-bytes");
  await writeAt(publicDir, ".nojekyll", "");

  const report = await copyAssets({ publicDir, distDir });

  assert.deepEqual(report.copied, [".nojekyll", "img/logo.png", "style.css"]);
  assert.deepEqual(report.skipped, []);
  assert.deepEqual(report.collisions, []);
  assert.equal(report.rewritten, 0);
  for (const rel of [".nojekyll", "img/logo.png", "style.css"]) {
    const source = await readFile(path.join(publicDir, ...rel.split("/")));
    const copied = await readFile(path.join(distDir, ...rel.split("/")));
    assert.deepEqual(copied, source, `${rel} bytes`);
  }
});

test("second run skips unchanged files; touching one source recopies exactly it", async () => {
  const { publicDir, distDir } = await makeSite();
  await writeAt(publicDir, "style.css", "body {}\n");
  await writeAt(publicDir, "img/logo.png", "png");
  await writeAt(publicDir, ".nojekyll", "");

  await copyAssets({ publicDir, distDir });
  const second = await copyAssets({ publicDir, distDir });
  assert.deepEqual(second.copied, []);
  assert.deepEqual(second.skipped, [".nojekyll", "img/logo.png", "style.css"]);

  // Move one source's mtime strictly past the copied destination's.
  const touched = path.join(publicDir, "style.css");
  const future = new Date(Date.now() + 5000);
  await utimes(touched, future, future);

  const third = await copyAssets({ publicDir, distDir });
  assert.deepEqual(third.copied, ["style.css"]);
  assert.deepEqual(third.skipped, [".nojekyll", "img/logo.png"]);
});

test("missing or empty public/ resolves an all-zero report without throwing", async () => {
  const { publicDir, distDir } = await makeSite();
  const zero = { copied: [], skipped: [], collisions: [], rewritten: 0 };
  assert.deepEqual(await copyAssets({ publicDir, distDir }), zero);

  const emptyDir = `${publicDir}-empty`;
  await mkdir(emptyDir);
  assert.deepEqual(await copyAssets({ publicDir: emptyDir, distDir }), zero);
});

test("an emitted page is never overwritten by a static file of the same name", async () => {
  const { publicDir, distDir } = await makeSite();
  await writeAt(publicDir, "index.html", "<h1>static index</h1>");
  await writeAt(publicDir, "style.css", "body {}\n");
  const emittedBytes = "<!doctype html><title>emitted</title>";
  await writeAt(distDir, "index.html", emittedBytes);

  const report = await copyAssets({ publicDir, distDir, emitted: new Set(["index.html"]) });

  assert.deepEqual(report.collisions, ["index.html"]);
  // The build continues: the non-colliding asset still lands.
  assert.deepEqual(report.copied, ["style.css"]);
  assert.equal(await readFile(path.join(distDir, "index.html"), "utf8"), emittedBytes);
  assert.equal(await readFile(path.join(distDir, "style.css"), "utf8"), "body {}\n");
});

test("hashBust: hashed rename, reference rewrite, stable second run", async () => {
  const { publicDir, distDir } = await makeSite();
  const appSource = "console.log('kiln');\n";
  await writeAt(publicDir, "app.js", appSource);
  const html = [
    '<script src="/app.js"></script>',
    '<script src="/not-copied.js"></script>',
    '<script src="https://cdn.example.com/app.js"></script>',
    '<script src="//cdn.example.com/app.js"></script>',
    '<a href="/app.js">home</a>',
    '<script data-src="/app.js"></script>',
  ].join("\n");
  await writeAt(distDir, "index.html", html);

  const hash = createHash("sha256").update(appSource).digest("hex").slice(0, 8);
  const hashed = `app.${hash}.js`;

  const first = await copyAssets({
    publicDir,
    distDir,
    emitted: new Set(["index.html"]),
    hashBust: true,
  });
  assert.deepEqual(first.copied, [hashed]);
  assert.equal(first.rewritten, 1);
  assert.deepEqual(await readFile(path.join(distDir, hashed)), Buffer.from(appSource));

  const rewrittenHtml = await readFile(path.join(distDir, "index.html"), "utf8");
  assert.ok(rewrittenHtml.includes(`<script src="/${hashed}"></script>`), "src rewritten");
  assert.ok(rewrittenHtml.includes(`<a href="/${hashed}">home</a>`), "href rewritten");
  assert.ok(rewrittenHtml.includes('<script src="/not-copied.js"></script>'), "uncopied ref untouched");
  assert.ok(
    rewrittenHtml.includes('<script src="https://cdn.example.com/app.js"></script>'),
    "external URL untouched",
  );
  assert.ok(
    rewrittenHtml.includes('<script src="//cdn.example.com/app.js"></script>'),
    "protocol-relative URL untouched",
  );
  assert.ok(rewrittenHtml.includes('<script data-src="/app.js"></script>'), "lookalike attr untouched");

  const second = await copyAssets({
    publicDir,
    distDir,
    emitted: new Set(["index.html"]),
    hashBust: true,
  });
  assert.deepEqual(second.copied, []);
  assert.equal(second.rewritten, 0);
  assert.equal(await readFile(path.join(distDir, "index.html"), "utf8"), rewrittenHtml);
});

test("a regular file occupying the destination path rejects, naming that path", async () => {
  const { publicDir, distDir } = await makeSite();
  await writeAt(publicDir, "style.css", "body {}\n");
  await writeFile(distDir, "i am not a directory");

  await assert.rejects(
    copyAssets({ publicDir, distDir }),
    (error: unknown) => error instanceof Error && error.message.includes(distDir),
  );
});

test("a broken symlink lands in skipped without failing the run", async () => {
  const { publicDir, distDir } = await makeSite();
  await writeAt(publicDir, "ok.txt", "fine\n");
  await symlink("missing-target", path.join(publicDir, "broken"));

  const report = await copyAssets({ publicDir, distDir });
  assert.deepEqual(report.copied, ["ok.txt"]);
  assert.deepEqual(report.skipped, ["broken"]);
  assert.deepEqual(report.collisions, []);
});

test("symlinked directories are not descended; hidden directories are mirrored", async () => {
  const { publicDir, distDir } = await makeSite();
  await writeAt(publicDir, "real/a.txt", "a\n");
  await writeAt(publicDir, ".hid/x.css", "x {}\n");
  await symlink("real", path.join(publicDir, "link"));

  const report = await copyAssets({ publicDir, distDir });
  assert.deepEqual(report.copied, [".hid/x.css", "real/a.txt"]);
  await assert.rejects(readdir(path.join(distDir, "link")), { code: "ENOENT" });
});
