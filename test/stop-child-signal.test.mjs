import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import test from "node:test";

import { hasExited, stopChild } from "./helpers/stop-child.mjs";

class FakeChild extends EventEmitter {
  exitCode = null;
  signalCode = null;

  constructor(kill) {
    super();
    this.kill = kill.bind(this);
  }
}

function assertNoWaiters(child) {
  assert.equal(child.listenerCount("exit"), 0, "exit waiter must be removed");
  assert.equal(child.listenerCount("error"), 0, "error waiter must be removed");
}

test("stopChild recognizes a process that exits by signal", { timeout: 5_000 }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });
  await once(child, "spawn");

  await stopChild(child, { timeoutMs: 250, name: "Signal fixture" });

  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, "SIGTERM");
  assert.equal(hasExited(child), true);
});

test("stopChild clears its waiter when kill reports false after an exit race", async () => {
  const child = new FakeChild(function kill() {
    this.signalCode = "SIGTERM";
    return false;
  });

  await stopChild(child, { timeoutMs: 20, name: "Race fixture" });

  assert.equal(hasExited(child), true);
  assertNoWaiters(child);
});

test("stopChild fails loudly after SIGTERM timeout even when SIGKILL cleans up", async () => {
  const child = new FakeChild(function kill(signal) {
    if (signal === "SIGTERM") return true;
    this.signalCode = "SIGKILL";
    queueMicrotask(() => this.emit("exit", null, "SIGKILL"));
    return true;
  });

  await assert.rejects(
    stopChild(child, { timeoutMs: 10, killTimeoutMs: 100, name: "Escalation fixture" }),
    /did not stop after SIGTERM/,
  );
  assert.equal(child.signalCode, "SIGKILL");
  assertNoWaiters(child);
});

test("stopChild reports both timeouts and leaves no waiters when the child stays alive", async () => {
  const child = new FakeChild(() => true);

  await assert.rejects(
    stopChild(child, { timeoutMs: 10, killTimeoutMs: 10, name: "Stuck fixture" }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /teardown failed/);
      return true;
    },
  );
  assert.equal(hasExited(child), false);
  assertNoWaiters(child);
});
