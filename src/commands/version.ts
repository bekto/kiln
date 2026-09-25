import { readFile } from "node:fs/promises";

export const name = "version";
export const description = "Print the kiln version";

export async function run(_args: string[]): Promise<void> {
  const pkg = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  process.stdout.write(`kiln ${pkg.version}\n`);
}
