import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveTypeScriptBinary,
  runTypecheck,
  typecheckEnvironment,
} from "../scripts/typecheck.mjs";

test("typecheck launcher uses the platform native compiler with inherited environment and exact arguments", () => {
  const packageJson = "/fixture/node_modules/@typescript/typescript-win32-x64/package.json";
  const executable = "/fixture/node_modules/@typescript/typescript-win32-x64/lib/tsc.exe";
  let invocation;

  const result = runTypecheck({
    argv: ["-p", "web/tsconfig.json", "--noEmit"],
    env: { PATH: "/fixture/bin", LAUNCHER_SENTINEL: "kept", GOMAXPROCS: "invalid" },
    platform: "win32",
    arch: "x64",
    resolve(specifier) {
      assert.equal(specifier, "@typescript/typescript-win32-x64/package.json");
      return packageJson;
    },
    exists(candidate) {
      return candidate === executable;
    },
    spawn(command, args, options) {
      invocation = { command, args, options };
      return { status: 0 };
    },
  });

  assert.equal(result, 0);
  assert.equal(invocation.command, executable);
  assert.deepEqual(invocation.args, ["-p", "web/tsconfig.json", "--noEmit"]);
  assert.equal(invocation.options.env.PATH, "/fixture/bin");
  assert.equal(invocation.options.env.LAUNCHER_SENTINEL, "kept");
  assert.equal(invocation.options.env.GOMAXPROCS, "2");
  assert.equal(invocation.options.stdio, "inherit");
  assert.equal(typecheckEnvironment({ GOMAXPROCS: "8" }).GOMAXPROCS, "8");
  assert.equal(
    resolveTypeScriptBinary({
      platform: "linux",
      arch: "arm64",
      resolve(specifier) {
        assert.equal(specifier, "@typescript/typescript-linux-arm64/package.json");
        return "/fixture/node_modules/@typescript/typescript-linux-arm64/package.json";
      },
      exists(candidate) {
        return candidate.endsWith("/lib/tsc");
      },
    }),
    "/fixture/node_modules/@typescript/typescript-linux-arm64/lib/tsc",
  );
});
