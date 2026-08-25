const maxStderrBytes = 16 * 1024;

export function captureStderrTail(stream, limitBytes = maxStderrBytes) {
  let tail = Buffer.alloc(0);
  stream?.on("data", (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (bytes.length >= limitBytes) {
      tail = bytes.subarray(bytes.length - limitBytes);
      return;
    }
    tail = tail.length === 0 ? bytes : Buffer.concat([tail, bytes]);
    if (tail.length > limitBytes) tail = tail.subarray(tail.length - limitBytes);
  });
  return () => tail.toString("utf8");
}

function replaceExact(value, target, replacement) {
  return target ? value.split(target).join(replacement) : value;
}

export function sanitizeChromeDiagnostic(value, paths = {}) {
  let sanitized = String(value ?? "")
    .replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|][^\u0007]*(?:\u0007|\u001B\\))/g, "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ");
  for (const [target, replacement] of [
    [paths.profile, "<profile>"],
    [paths.tempDirectory, "<tmp>"],
    [paths.tempRoot, "<tmp>"],
    [paths.homeDirectory, "<home>"],
  ].sort(([left], [right]) => (right?.length ?? 0) - (left?.length ?? 0))) {
    sanitized = replaceExact(sanitized, target, replacement);
  }
  return sanitized.replace(/\s+/g, " ").trim();
}

export function chromeStartupDiagnostic({ child, stderrTail, paths, startupError = null }) {
  let alive = "unknown";
  if (Number.isInteger(child?.pid)) {
    try {
      process.kill(child.pid, 0);
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

export { maxStderrBytes };
