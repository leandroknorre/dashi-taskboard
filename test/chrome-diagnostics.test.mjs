import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  captureStderrTail,
  maxStderrBytes,
  sanitizeChromeDiagnostic,
} from "./helpers/chrome-diagnostics.mjs";

test("Chrome stderr diagnostics retain only a bounded tail while draining", () => {
  const stream = new PassThrough();
  const tail = captureStderrTail(stream);
  stream.write("a".repeat(maxStderrBytes + 64));
  stream.end("final stderr line");

  const output = tail();
  assert.ok(Buffer.byteLength(output) <= maxStderrBytes);
  assert.match(output, /final stderr line$/);
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
