import { StringDecoder } from "node:string_decoder";

const maxStderrBytes = 16 * 1024;

function trimUtf8Tail(value, limitBytes = maxStderrBytes) {
  let bytes = Buffer.from(value, "utf8");
  if (bytes.length <= limitBytes) return value;
  bytes = bytes.subarray(bytes.length - limitBytes);
  while (bytes.length > 0 && (bytes[0] & 0xc0) === 0x80) bytes = bytes.subarray(1);
  return bytes.toString("utf8");
}

export function captureStderrTail(stream, limitBytes = maxStderrBytes) {
  const decoder = new StringDecoder("utf8");
  let tail = "";
  const onData = (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    tail = trimUtf8Tail(`${tail}${decoder.write(bytes)}`, limitBytes);
  };
  const onError = () => {};
  stream?.on("data", onData);
  stream?.on("error", onError);
  return {
    read: () => tail,
    dispose: () => {
      stream?.off("data", onData);
      stream?.off("error", onError);
    },
  };
}

function replaceExact(value, target, replacement) {
  return target ? value.split(target).join(replacement) : value;
}

export function sanitizeChromeDiagnostic(value, paths = {}, limitBytes = maxStderrBytes) {
  let sanitized = String(value ?? "")
    .replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|][^\u0007]*(?:\u0007|\u001B\\))/g, "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\uFFFD/g, "");
  for (const [target, replacement] of [
    [paths.profile, "<profile>"],
    [paths.tempDirectory, "<tmp>"],
    [paths.tempRoot, "<tmp>"],
    [paths.homeDirectory, "<home>"],
  ].sort(([left], [right]) => (right?.length ?? 0) - (left?.length ?? 0))) {
    sanitized = replaceExact(sanitized, target, replacement);
  }
  return trimUtf8Tail(sanitized.replace(/\s+/g, " ").trim(), limitBytes);
}

export function childHasExited(child) {
  return Boolean(child) && [child.exitCode, child.signalCode]
    .some((value) => value !== null && value !== undefined);
}

export function chromeStartupDiagnostic({
  child,
  stderrTail,
  paths,
  startupError = null,
  livenessProbe = (pid) => process.kill(pid, 0),
}) {
  let alive = "unknown";
  if (Number.isInteger(child?.pid)) {
    try {
      livenessProbe(child.pid);
      alive = "true";
    } catch {
      alive = "false";
    }
  }
  const stderr = sanitizeChromeDiagnostic(stderrTail?.(), paths);
  const error = sanitizeChromeDiagnostic(startupError?.message, paths);
  return [
    `exitCode=${child?.exitCode ?? "null"}`,
    `signalCode=${child?.signalCode ?? "null"}`,
    `alive=${alive}`,
    `killRequested=${child?.killed ?? "unknown"}`,
    error && `spawnError=${error}`,
    stderr && `stderr=${stderr}`,
  ].filter(Boolean).join("; ");
}

function chromeDebugPortError(options) {
  return new Error(`Chrome did not publish its DevTools port (${chromeStartupDiagnostic(options)})`);
}

export async function waitForChromeDebugPort({
  child,
  stderrTail,
  getStartupError = () => null,
  paths,
  readPort,
  timeoutMs,
  pollMs = 100,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  livenessProbe,
}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const startupError = getStartupError();
    if (childHasExited(child) || startupError) {
      throw chromeDebugPortError({ child, stderrTail, paths, startupError, livenessProbe });
    }
    try {
      const port = await readPort();
      if (port) return port;
    } catch {
      // Chrome creates DevToolsActivePort asynchronously.
    }
    await sleep(pollMs);
  }
  throw chromeDebugPortError({ child, stderrTail, paths, startupError: getStartupError(), livenessProbe });
}

export { maxStderrBytes };
