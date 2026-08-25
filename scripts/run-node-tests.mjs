import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = fileURLToPath(new URL("../test", import.meta.url));
const minimumNodeVersion = { major: 22, minor: 6 };

function assertNodeVersion() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const supported = major > minimumNodeVersion.major
    || (major === minimumNodeVersion.major && minor >= minimumNodeVersion.minor);

  if (!supported) {
    throw new Error(
      `Node ${minimumNodeVersion.major}.${minimumNodeVersion.minor} or newer is required for --experimental-strip-types; found ${process.versions.node}`,
    );
  }
}

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

assertNodeVersion();

const files = await nodeTestFiles(testDirectory);
if (files.length === 0) throw new Error("No Node test files were found");

const serializedE2eFiles = new Set([
  "gantt-workflow-async.e2e.test.mjs",
  "nested-workspace-real.e2e.test.mjs",
]);
const serialFiles = files.filter((filename) => serializedE2eFiles.has(path.basename(filename)));
const concurrentFiles = files.filter((filename) => !serializedE2eFiles.has(path.basename(filename)));

function run(filesToRun, args = []) {
  if (filesToRun.length === 0) return 0;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", ...args, "--test", ...filesToRun], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const concurrentStatus = run(concurrentFiles);
const serialStatus = concurrentStatus === 0
  ? run(serialFiles, ["--test-concurrency=1"])
  : 1;
process.exitCode = concurrentStatus || serialStatus;
