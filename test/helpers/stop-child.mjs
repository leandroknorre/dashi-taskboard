import { once } from "node:events";

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

export async function stopChild(child, { timeoutMs = 5_000, name = "Child process" } = {}) {
  if (!child || hasExited(child)) return;
  const exited = once(child, "exit");
  if (hasExited(child)) return;

  const terminated = child.kill("SIGTERM");
  if (!terminated && hasExited(child)) return;
  if (hasExited(child)) return;
  try {
    await withTimeout(exited, timeoutMs, `${name} did not stop after SIGTERM`);
    return;
  } catch (terminateError) {
    if (hasExited(child)) return;
    const killed = child.kill("SIGKILL");
    if (!killed && hasExited(child)) return;
    if (hasExited(child)) return;
    try {
      await withTimeout(exited, timeoutMs, `${name} did not stop after SIGKILL`);
    } catch (killError) {
      if (hasExited(child)) return;
      throw new AggregateError([terminateError, killError], `${name} teardown failed`);
    }
    if (!hasExited(child)) throw terminateError;
  }
}
