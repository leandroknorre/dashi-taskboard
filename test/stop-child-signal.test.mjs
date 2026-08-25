import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

import { hasExited, stopChild } from "./helpers/stop-child.mjs";

test("stopChild recognizes a process that exits by signal", { timeout: 5_000 }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });
  await once(child, "spawn");

  await stopChild(child, { timeoutMs: 250, name: "Signal fixture" });

  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, "SIGTERM");
  assert.equal(hasExited(child), true);
});
