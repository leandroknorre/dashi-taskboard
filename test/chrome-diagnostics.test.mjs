import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  captureStderrTail,
  chromeStartupDiagnostic,
  maxStderrBytes,
  sanitizeChromeDiagnostic,
  waitForChromeDebugPort,
} from "./helpers/chrome-diagnostics.mjs";

test("Chrome stderr diagnostics retain only a bounded tail while draining", () => {
  const stream = new PassThrough();
  const capture = captureStderrTail(stream);
  stream.write("a".repeat(maxStderrBytes + 64));
  stream.end("final stderr line");

  const output = capture.read();
  assert.ok(Buffer.byteLength(output) <= maxStderrBytes);
  assert.match(output, /final stderr line$/);
  capture.dispose();
  assert.equal(stream.listenerCount("data"), 0);
  assert.equal(stream.listenerCount("error"), 0);
});

test("Chrome stderr diagnostics keep UTF-8 boundaries at the byte limit", () => {
  const stream = new PassThrough();
  const capture = captureStderrTail(stream);
  stream.end(`xx€${"a".repeat(maxStderrBytes - 2)}`);

  const output = sanitizeChromeDiagnostic(capture.read());
  assert.ok(Buffer.byteLength(output) <= maxStderrBytes);
  assert.equal(output.includes("�"), false);
  capture.dispose();
});

test("Chrome stderr diagnostics remove controls and local profile paths", () => {
  const profile = "/tmp/taskboard-profile/chrome";
  const tempDirectory = "/tmp/taskboard-profile";
  const homeDirectory = "/home/tester";
  const output = sanitizeChromeDiagnostic(
    `\u001B[31mfailed ${profile}\n${tempDirectory}\u0000${homeDirectory}\u001B[0m`,
    { profile, tempDirectory, tempRoot: "/tmp", homeDirectory },
  );

  assert.equal(output.includes(profile), false);
  assert.equal(output.includes(tempDirectory), false);
  assert.equal(output.includes(homeDirectory), false);
  assert.equal(/[\u0000-\u001F\u007F-\u009F]/.test(output), false);
  assert.match(output, /<profile>/);
  assert.match(output, /<tmp>/);
  assert.match(output, /<home>/);
});

const safePaths = {
  profile: "/tmp/chrome-test/profile",
  tempDirectory: "/tmp/chrome-test",
  tempRoot: "/tmp",
  homeDirectory: "/home/tester",
};

function fakeChild(overrides = {}) {
  return {
    exitCode: null,
    signalCode: null,
    killed: false,
    pid: undefined,
    ...overrides,
  };
}

test("Chrome startup diagnostics report a spawn error without exposing local paths", async () => {
  const child = fakeChild();
  await assert.rejects(
    waitForChromeDebugPort({
      child,
      stderrTail: () => "",
      getStartupError: () => new Error(`failed at ${safePaths.profile}`),
      paths: safePaths,
      readPort: async () => null,
      timeoutMs: 50,
    }),
    (error) => {
      assert.match(error.message, /spawnError=failed at <profile>/);
      assert.equal(error.message.includes(safePaths.profile), false);
      return true;
    },
  );
});

test("Chrome startup diagnostics fail immediately for an exited child", async () => {
  const child = fakeChild({ exitCode: 1 });
  let reads = 0;
  await assert.rejects(
    waitForChromeDebugPort({
      child,
      stderrTail: () => "",
      paths: safePaths,
      readPort: async () => { reads += 1; return null; },
      timeoutMs: 50,
    }),
    /exitCode=1/,
  );
  assert.equal(reads, 0);
});

test("Chrome startup diagnostics timeout with a bounded diagnostic", async () => {
  const child = fakeChild();
  await assert.rejects(
    waitForChromeDebugPort({
      child,
      stderrTail: () => "still waiting",
      paths: safePaths,
      readPort: async () => null,
      timeoutMs: 10,
      pollMs: 1,
    }),
    /stderr=still waiting/,
  );
});

test("Chrome startup diagnostics use signal zero only as a liveness probe", () => {
  const child = fakeChild({ pid: 4242 });
  const calls = [];
  const diagnostic = chromeStartupDiagnostic({
    child,
    stderrTail: () => "",
    paths: safePaths,
    livenessProbe: (pid) => calls.push(pid),
  });

  assert.deepEqual(calls, [4242]);
  assert.match(diagnostic, /alive=true/);
  assert.equal(child.killed, false);
});
