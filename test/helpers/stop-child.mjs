export function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child, timeoutMs, message) {
  let settle;
  let timer;
  let onExit;
  let onError;
  let settled = false;
  const promise = new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    settle = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    onExit = () => settle();
    onError = (error) => settle(error);
    if (hasExited(child)) {
      settle();
      return;
    }
    child.once("exit", onExit);
    child.once("error", onError);
    if (hasExited(child)) {
      settle();
      return;
    }
    timer = setTimeout(() => settle(new Error(message)), timeoutMs);
  });
  return { promise, cancel: () => settle() };
}

export async function stopChild(child, {
  timeoutMs = 5_000,
  killTimeoutMs = timeoutMs,
  name = "Child process",
} = {}) {
  if (!child || hasExited(child)) return;
  const termWait = waitForExit(child, timeoutMs, `${name} did not stop after SIGTERM`);

  const terminated = child.kill("SIGTERM");
  if (!terminated && hasExited(child)) {
    termWait.cancel();
    return;
  }
  if (hasExited(child)) {
    termWait.cancel();
    return;
  }
  try {
    await termWait.promise;
    return;
  } catch (terminateError) {
    if (hasExited(child)) throw terminateError;
    const killWait = waitForExit(child, killTimeoutMs, `${name} did not stop after SIGKILL`);
    const killed = child.kill("SIGKILL");
    if (!killed && hasExited(child)) {
      killWait.cancel();
      throw terminateError;
    }
    if (hasExited(child)) {
      killWait.cancel();
      throw terminateError;
    }
    try {
      await killWait.promise;
    } catch (killError) {
      if (hasExited(child)) throw terminateError;
      throw new AggregateError([terminateError, killError], `${name} teardown failed`);
    }
    throw terminateError;
  }
}
