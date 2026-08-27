import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { captureStderrTail, waitForChromeDebugPort } from "./helpers/chrome-diagnostics.mjs";
import { stopChild } from "./helpers/stop-child.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const instanceToken = "7a6f8d37-78ce-46c9-87a8-08e10db88da2";
const instanceSecret = "2e587946-96d6-47b5-930a-1ba70214fa88";
const sourceRef = process.env.TASKBOARD_INJECTION_SOURCE_REF;
const source = sourceRef
  ? (await execFileAsync(
      "git",
      ["show", `${sourceRef}:inject/codex-taskboard.user.js`],
      { cwd: projectRoot, maxBuffer: 2 * 1024 * 1024 },
    )).stdout
  : await readFile(new URL("../inject/codex-taskboard.user.js", import.meta.url), "utf8");
const embeddedHostSource = await readFile(
  new URL("../web/src/embeddedHost.mjs", import.meta.url),
  "utf8",
);
const embeddedHostClassicSource = embeddedHostSource.replaceAll("export ", "");
const cdpTimeoutMs = 12_000;

async function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch (_) {}
  }
  return null;
}

async function chromeDebugPort(profile, child, stderrCapture, getStartupError) {
  return waitForChromeDebugPort({
    child,
    stderrTail: stderrCapture.read,
    getStartupError,
    paths: {
      profile,
      tempDirectory: path.dirname(profile),
      tempRoot: os.tmpdir(),
      homeDirectory: process.env.HOME,
    },
    timeoutMs: cdpTimeoutMs,
    readPort: async () => {
      const lines = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
      return Number(lines[0]) || null;
    },
  });
}

async function connectCdp(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(cdpTimeoutMs),
  });
  assert.ok(response.ok, "Chrome DevTools target list must be available");
  const target = (await response.json()).find((candidate) => candidate.type === "page");
  assert.ok(target?.webSocketDebuggerUrl, "Chrome must expose a page DevTools target");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  const eventWaiters = new Map();
  const rejectPending = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
    for (const waiters of eventWaiters.values()) {
      for (const { reject } of waiters) reject(error);
    }
    eventWaiters.clear();
  };
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) {
      const waiters = eventWaiters.get(message.method);
      if (!waiters) return;
      for (const waiter of [...waiters]) {
        if (!waiter.matches(message.params)) continue;
        waiters.delete(waiter);
        waiter.resolve(message.params);
      }
      if (waiters.size === 0) eventWaiters.delete(message.method);
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  socket.addEventListener("error", () => rejectPending(new Error("Chrome DevTools WebSocket failed")));
  socket.addEventListener("close", () => rejectPending(new Error("Chrome DevTools WebSocket closed")));
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    send,
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    },
    waitForEvent(method, matches = () => true) {
      return new Promise((resolve, reject) => {
        const waiters = eventWaiters.get(method) ?? new Set();
        eventWaiters.set(method, waiters);
        waiters.add({ resolve, reject, matches });
      });
    },
    async close() {
      if (socket.readyState === WebSocket.OPEN) {
        try { await send("Browser.close"); } catch (_) {}
      }
      socket.close();
    },
  };
}

function fixtureHtml(origin) {
  const encodedSource = Buffer.from(source).toString("base64");
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      html, body { width: 1200px; height: 800px; margin: 0; }
      aside { position: absolute; width: 200px; height: 800px; }
      main { position: absolute; left: 200px; width: 1000px; height: 700px; }
      main > header { position: absolute; z-index: 2; width: 1000px; height: 48px; }
      #surface { width: 1000px; height: 700px; }
      [data-app-shell-main-content-layout] { position: absolute; width: 1000px; height: 700px; }
      #conversation { position: absolute; top: 48px; width: 1000px; height: 652px; }
      [data-browser-sidebar-webview] { position: absolute; right: 0; width: 320px; height: 700px; visibility: visible; }
    </style>
  </head>
  <body>
    <aside>
      <nav role="navigation">
        <div data-app-action-sidebar-scroll>
          <div>
            <button><span>首页</span></button>
            <button><span>站点</span></button>
            <button><svg></svg><span class="text-fade-truncate">插件</span></button>
          </div>
          <section data-app-action-sidebar-section>
            <div data-app-action-sidebar-section-heading="项目">项目</div>
          </section>
        </div>
      </nav>
    </aside>
    <main>
      <header>Codex header</header>
      <div id="surface">
        <div data-app-shell-main-content-layout>
          <div id="conversation">Conversation</div>
        </div>
      </div>
      <div data-browser-sidebar-webview>
        <webview
          data-browser-sidebar-conversation-id="conversation-1"
          data-browser-sidebar-browser-tab-id="browser-tab-1"
        ></webview>
      </div>
    </main>
    <output id="result"></output>
    <script>
      window.__CODEX_TASKBOARD_URL__ = ${JSON.stringify(`${origin}/taskboard?host=codex`)};
      window.__CODEX_TASKBOARD_INSTANCE_TOKEN__ = ${JSON.stringify(instanceToken)};
      window.__CODEX_TASKBOARD_INSTANCE_SECRET__ = ${JSON.stringify(instanceSecret)};
      window.__CODEX_TASKBOARD_HOST_CAPABILITY__ = "fullheight-host-capability";
      window.__CODEX_TASKBOARD_SOURCE_HASH__ = "fullheight-regression";
      window.__browserPanelClosed = false;
      window.__injectionError = null;
      window.__frameMessages = [];
      window.__externalOpenUrl = null;
      window.__frameVisibleBeforeNavigation = false;
      window.__statusHiddenBeforeNavigation = false;
      window.__hostileNavigationLoaded = false;
      window.__forgedThreadOpened = false;
      window.addEventListener("error", (event) => {
        window.__injectionError = event.error?.stack || event.message;
      });
      window.addEventListener("unhandledrejection", (event) => {
        window.__injectionError = event.reason?.stack || String(event.reason);
      });
      window.addEventListener("message", (event) => {
        if (typeof event.data?.type === "string" && event.data.type.startsWith("taskboard:")) {
          window.__frameMessages.push({ type: event.data.type, origin: event.origin });
        }
        if (
          event.source === window
          && event.data?.type === "__codexTaskboardHostRequestV1"
          && event.data.capability === "fullheight-host-capability"
        ) {
          const request = event.data.payload;
          if (request.action === "load-frame") {
            const frame = document.querySelector('iframe[name="' + request.frameName + '"]');
            frame.srcdoc = '<a id="external-link" href="https://example.com/review" target="_blank">Review</a>'
              + '<script>'
              + ${JSON.stringify(embeddedHostClassicSource)}
              + '\\nglobalThis.__CODEX_TASKBOARD_FRAME_CAPABILITY__='
              + JSON.stringify(request.frameCapability)
              + ';installEmbeddedExternalLinkHandler();'
              + 'let activated=false;window.addEventListener("message",function(event){'
              + 'if(event.data?.type==="taskboard:frame-challenge"){'
              + 'const challenge=event.data.payload?.challenge;if(!challenge)return;'
              + 'setEmbeddedFrameChallenge(challenge);postEmbeddedHostMessage({type:"taskboard:ready"});return;'
              + '}'
              + 'if(event.data?.type!=="taskboard:host-context"||activated)return;activated=true;'
              + 'parent.postMessage({type:"taskboard:ready"},"*");'
              + 'parent.postMessage({type:"taskboard:open-thread",payload:{threadId:"forged"}},"*");'
              + 'document.getElementById("external-link").click();'
              + '});postEmbeddedHostMessage({type:"taskboard:frame-awaiting-challenge"});<\\/script>';
          }
          if (request.action === "open-external") {
            window.__externalOpenUrl = request.url;
            const frame = document.getElementById("codex-taskboard-frame");
            window.__frameVisibleBeforeNavigation = frame?.hidden === false;
            window.__statusHiddenBeforeNavigation = document.getElementById("codex-taskboard-status")?.hidden === true;
            frame?.addEventListener("load", () => {
              window.__hostileNavigationLoaded = true;
              window.__resolveHostileNavigationLoaded();
            }, { once: true });
            frame.removeAttribute("srcdoc");
            frame.src = ${JSON.stringify(`${origin}/attacker`)};
          }
          window.postMessage({
            type: "__codexTaskboardHostResponseV1",
            capability: "fullheight-host-capability",
            response: { id: request.id, ok: true, loaded: true },
          }, window.location.origin);
        }
        if (event.source === window && event.data?.type === "navigate-to-route") {
          window.__forgedThreadOpened = true;
        }
        if (event.data?.type !== "toggle-browser-panel" || event.data.open !== false) return;
        const panel = document.querySelector("[data-browser-sidebar-webview]");
        panel.style.visibility = "hidden";
        panel.hidden = true;
        const conversation = document.getElementById("conversation");
        conversation.style.top = "0";
        conversation.style.height = "700px";
        window.__browserPanelClosed = true;
      });
    </script>
    <script>eval(atob(${JSON.stringify(encodedSource)}));</script>
    <script>
      (async () => {
        const publishHeartbeat = () => window.postMessage({
            type: "__codexTaskboardHostHeartbeatV1",
            capability: "fullheight-host-capability",
            at: Date.now(),
            startupToken: "fullheight-startup",
          }, window.location.origin);
        publishHeartbeat();
        const heartbeatTimer = setInterval(publishHeartbeat, 500);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const entry = document.getElementById("codex-taskboard-entry");
        const panel = document.querySelector("[data-browser-sidebar-webview]");
        const panelVisibleBefore = getComputedStyle(panel).visibility !== "hidden";
        const hostileNavigationLoaded = new Promise((resolve) => {
          window.__resolveHostileNavigationLoaded = resolve;
        });
        entry?.click();
        await hostileNavigationLoaded;

        const page = document.getElementById("codex-taskboard-page");
        const frame = document.getElementById("codex-taskboard-frame");
        const surface = document.getElementById("surface");
        const conversation = document.getElementById("conversation");
        const result = {
          panelVisibleBefore,
          browserPanelClosed: window.__browserPanelClosed,
          conversationTop: conversation.getBoundingClientRect().top,
          pageMounted: page?.parentElement === surface,
          pageVisible: Boolean(page && !page.hidden && getComputedStyle(page).display !== "none"),
          frameMounted: frame?.parentElement === page,
          frameVisible: Boolean(frame && !frame.hidden && getComputedStyle(frame).display !== "none"),
          frameIsolated: frame?.contentDocument === null,
          statusHidden: document.getElementById("codex-taskboard-status")?.hidden === true,
          frameMessages: window.__frameMessages,
          externalOpenUrl: window.__externalOpenUrl,
          frameVisibleBeforeNavigation: window.__frameVisibleBeforeNavigation,
          statusHiddenBeforeNavigation: window.__statusHiddenBeforeNavigation,
          hostileNavigationRevoked: Boolean(frame?.hidden && !document.getElementById("codex-taskboard-status")?.hidden),
          forgedThreadOpened: window.__forgedThreadOpened,
          injectionError: window.__injectionError,
        };
        document.getElementById("result").textContent = btoa(JSON.stringify(result));
        clearInterval(heartbeatTimer);
        window.__codexTaskboardInjection__?.destroy();
      })();
    </script>
  </body>
</html>`;
}

test("Taskboard fills the workspace, opens HTTPS links and revokes hostile iframe navigation", { timeout: 20_000 }, async (t) => {
  const chrome = await chromeExecutable();
  if (!chrome) {
    t.skip("Chrome or Chromium is not installed");
    return;
  }

  const server = http.createServer((request, response) => {
    response.setHeader("connection", "close");
    if (request.url === "/attacker") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end("<!doctype html><title>attacker</title>");
      return;
    }
    if (request.url?.startsWith("/taskboard")) {
      response.setHeader("access-control-allow-origin", "null");
      response.setHeader("access-control-expose-headers", "x-codex-taskboard-proof");
      response.setHeader("access-control-allow-private-network", "true");
      if (request.method === "OPTIONS") {
        response.statusCode = 204;
        response.end();
        return;
      }
      const challenge = new URL(request.url, "http://127.0.0.1")
        .searchParams.get("__codex_taskboard_challenge");
      response.setHeader(
        "x-codex-taskboard-proof",
        createHmac("sha256", instanceSecret).update(challenge).digest("hex"),
      );
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html><head></head><body><script>parent.postMessage({ type: "taskboard:ready" }, "*")</script></body></html>`);
      return;
    }
    const origin = `http://127.0.0.1:${server.address().port}`;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(fixtureHtml(origin));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));

  const profile = await mkdtemp(path.join(os.tmpdir(), "taskboard-fullheight-chrome-"));
  t.after(() => rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  }));
  const url = `http://127.0.0.1:${server.address().port}/fixture`;
  let child;
  let cdp;
  let stderrCapture;
  let cleanupPromise;
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      let firstError;
      const attempt = async (operation) => {
        try { await operation(); } catch (error) { firstError ??= error; }
      };
      await attempt(() => cdp?.close());
      await attempt(() => stopChild(child, { name: "Chrome fixture" }));
      await attempt(() => stderrCapture?.dispose());
      if (firstError) throw firstError;
    })();
    return cleanupPromise;
  };
  const onAbort = () => { void cleanup().catch(() => {}); };
  t.signal.addEventListener("abort", onAbort, { once: true });
  let encodedResult;
  try {
    child = spawn(chrome, [
      "--headless=new",
      "--disable-background-networking",
      "--disable-gpu",
      "--no-first-run",
      "--no-sandbox",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      url,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    stderrCapture = captureStderrTail(child.stderr);
    let chromeStartupError;
    child.once("error", (error) => { chromeStartupError = error; });
    cdp = await connectCdp(await chromeDebugPort(
      profile,
      child,
      stderrCapture,
      () => chromeStartupError,
    ));
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    const pageLoaded = cdp.waitForEvent("Page.loadEventFired");
    await cdp.send("Page.navigate", { url });
    await pageLoaded;
    encodedResult = await cdp.evaluate(`new Promise((resolve) => {
      const output = document.getElementById("result");
      const finish = () => {
        const value = output?.textContent?.trim();
        if (!value) return;
        observer.disconnect();
        resolve(value);
      };
      const observer = new MutationObserver(finish);
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      finish();
    })`);
  } catch (error) {
    if (!cdp) {
      t.skip("Chrome or Chromium cannot run headless with DevTools in this environment");
      return;
    }
    throw error;
  } finally {
    t.signal.removeEventListener("abort", onAbort);
    await cleanup();
  }
  assert.ok(encodedResult, "fixture did not report an injection result");
  const result = JSON.parse(Buffer.from(encodedResult, "base64").toString("utf8"));
  const { frameMessages, ...stableResult } = result;
  assert.deepEqual(stableResult, {
    panelVisibleBefore: true,
    browserPanelClosed: true,
    conversationTop: 0,
    pageMounted: true,
    pageVisible: true,
    frameMounted: true,
    frameVisible: false,
    frameIsolated: true,
    statusHidden: false,
    externalOpenUrl: "https://example.com/review",
    frameVisibleBeforeNavigation: true,
    statusHiddenBeforeNavigation: true,
    hostileNavigationRevoked: true,
    forgedThreadOpened: false,
    injectionError: null,
  });
  assert.deepEqual(frameMessages[0], {
    type: "taskboard:frame-awaiting-challenge",
    origin: "null",
  });
  assert.ok(frameMessages.length >= 5);
  for (const message of frameMessages.slice(1, -3)) {
    assert.deepEqual(message, { type: "taskboard:ready", origin: "null" });
  }
  assert.deepEqual(frameMessages.slice(-3), [
    { type: "taskboard:ready", origin: "null" },
    { type: "taskboard:open-thread", origin: "null" },
    { type: "taskboard:open-external", origin: "null" },
  ]);
});
