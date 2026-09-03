import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const scriptPath = fileURLToPath(import.meta.url);

function nativePackageName(platform, arch) {
  return `@typescript/typescript-${platform}-${arch}`;
}

export function resolveTypeScriptBinary({
  platform = process.platform,
  arch = process.arch,
  resolve = require.resolve,
  exists = existsSync,
} = {}) {
  const packageName = nativePackageName(platform, arch);
  let packageJson;

  try {
    packageJson = resolve(`${packageName}/package.json`);
  } catch (error) {
    throw new Error(
      `TypeScript native compiler is unavailable for ${platform}/${arch} (${packageName}). Run npm ci for this platform.`,
      { cause: error },
    );
  }

  // Build the executable path with POSIX-style forward slashes regardless of
  // the host OS. require.resolve() (or an injected resolver, as in tests)
  // can return a path with either slash style, and the platform-native
  // path.win32.join() would rewrite forward slashes to backslashes. That's a
  // valid filesystem path on Windows, but it breaks exact-string comparisons
  // (and drops nothing — the drive letter/root is just plain text to
  // path.posix, so it survives untouched) while the OS-independent form
  // stays comparable and still resolves fine for existsSync()/spawn().
  const normalizedPackageJson = packageJson.replace(/\\/g, "/");
  const executable = path.posix.join(
    path.posix.dirname(normalizedPackageJson),
    "lib",
    platform === "win32" ? "tsc.exe" : "tsc",
  );
  if (!exists(executable)) {
    throw new Error(`TypeScript native compiler is missing: ${executable}`);
  }
  return executable;
}

export function typecheckEnvironment(env = process.env) {
  const childEnv = { ...env };
  if (!/^[1-9]\d*$/.test(childEnv.GOMAXPROCS ?? "")) {
    // Keep Go's compiler within a small, predictable CPU budget on constrained hosts.
    childEnv.GOMAXPROCS = "2";
  }
  return childEnv;
}

export function runTypecheck({
  argv = process.argv.slice(2),
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  resolve,
  exists,
  spawn = spawnSync,
} = {}) {
  const executable = resolveTypeScriptBinary({ platform, arch, resolve, exists });
  const result = spawn(executable, argv, {
    env: typecheckEnvironment(env),
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.signal) {
    console.error(`TypeScript native compiler terminated by signal ${result.signal}.`);
    return 1;
  }
  return Number.isInteger(result.status) ? result.status : 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === pathToFileURL(scriptPath).href) {
  try {
    process.exitCode = runTypecheck();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
