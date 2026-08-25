import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = fileURLToPath(new URL("../test", import.meta.url));

async function nodeTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(async (entry) => {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) return nodeTestFiles(filename);
      return entry.isFile() && entry.name.endsWith(".test.mjs") ? [filename] : [];
    }));
  return files.flat();
}

const files = await nodeTestFiles(testDirectory);
if (files.length === 0) throw new Error("No Node test files were found");

const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", ...files], {
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
