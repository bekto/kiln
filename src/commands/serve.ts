/**
 * `kiln serve` — statically serve the built output directory over
 * `node:http` on the configured port. No watching, no reloading: those
 * arrive later (T027/T028) as `src/server/*.ts` middleware picked up by
 * `scanRouter`. Discovered by T002's auto-discovery; `src/cli.ts` never
 * names this file.
 */
import { once } from "node:events";
import { readdir, stat } from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "../config.ts";
import { createServer } from "../server/static.ts";
import type { Middleware } from "../server/static.ts";

export const name = "serve";
export const description = "Serve the built site";

const USAGE = "usage: kiln serve [--port <n>]";

const MAX_PORT = 65535;

/**
 * `src/server/` — resolved relative to this module (not cwd), mirroring
 * cli.ts's COMMANDS_DIR, so middleware discovery works from any directory.
 */
const SERVER_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "server",
);

/**
 * Build the ordered router: every `src/server/*.ts` module except
 * `static.ts` itself may export `middleware` (an array of `(req, res,
 * next)` entries) that runs before the static handler. Specifiers are built
 * at runtime from the directory listing, so no static import can name them
 * and a missing module never appears; a present module that fails to load
 * or exports a malformed `middleware` throws naming the file (T002 style —
 * never a silent skip).
 */
async function scanRouter(): Promise<Middleware[]> {
  const files = (await readdir(SERVER_DIR))
    .filter((entry) => entry.endsWith(".ts") && entry !== "static.ts")
    .sort();

  const router: Middleware[] = [];
  for (const entry of files) {
    // Runtime-selected: the file list comes from the directory scan.
    const specifier = pathToFileURL(path.join(SERVER_DIR, entry)).href;
    let mod: Record<string, unknown>;
    try {
      mod = (await import(specifier)) as Record<string, unknown>;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`src/server/${entry}: failed to load (${reason})`);
    }
    const middleware = mod.middleware;
    if (middleware === undefined) continue; // module without middleware: ignored
    if (
      !Array.isArray(middleware) ||
      middleware.some((item) => typeof item !== "function")
    ) {
      throw new Error(
        `src/server/${entry}: 'middleware' must be an array of functions`,
      );
    }
    router.push(...(middleware as Middleware[]));
  }
  return router;
}

/**
 * Parse `--port <n>` from the raw argv tokens after the command name.
 * Returns `{ ok: false }` after printing the usage error (exit 2) for a
 * missing, non-integer, or out-of-range value.
 */
function parsePort(args: string[]):
  | { ok: true; port: number | undefined }
  | { ok: false } {
  let port: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port") {
      const raw = args[i + 1];
      const value = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isInteger(value) || value < 1 || value > MAX_PORT) {
        process.stderr.write(
          `kiln: ${name}: invalid value for --port: '${raw ?? ""}' ` +
            `(expected an integer 1..${MAX_PORT})\n${USAGE}\n`,
        );
        process.exitCode = 2;
        return { ok: false };
      }
      port = value;
      i += 1; // the value token is consumed with its flag
    } else {
      process.stderr.write(
        `kiln: ${name}: unknown argument '${arg}'\n${USAGE}\n`,
      );
      process.exitCode = 2;
      return { ok: false };
    }
  }
  return { ok: true, port };
}

export async function run(args: string[]): Promise<void> {
  const parsed = parsePort(args);
  if (!parsed.ok) return;

  // T003 owns the 4173 default; `--port` beats the config key per run.
  const config = await loadConfig();
  const root = config.outDir;
  const port = parsed.port ?? config.port;

  // A built site is a prerequisite: dist must exist before we accept
  // connections, so the user gets "run kiln build" instead of a server
  // that 404s every request. Checked before listen → nothing binds.
  let built = false;
  try {
    built = (await stat(root)).isDirectory();
  } catch {
    built = false;
  }
  if (!built) {
    const rel = path.relative(process.cwd(), root);
    throw new Error(
      `no built site at ${rel || root}/ — run \`kiln build\` first`,
    );
  }

  const router = await scanRouter();
  const server: Server = createServer(router, { root });

  // `events.once` rejects on "error", so EADDRINUSE surfaces with no
  // executor and no stack: rethrow it as the ticket's actionable message.
  const listening = once(server, "listening");
  server.listen(port);
  try {
    await listening;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      const alt = port < MAX_PORT ? port + 1 : port - 1;
      throw new Error(
        `port ${port} is already in use — pick another with ` +
          `kiln serve --port ${alt}`,
      );
    }
    throw error;
  }

  const rel = path.relative(process.cwd(), root) || root;
  process.stdout.write(`serving ${rel}/ at http://localhost:${port}\n`);
}
