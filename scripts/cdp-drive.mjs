#!/usr/bin/env node
//
// cdp-drive.mjs — drive a real Chrome over the DevTools Protocol with real
// mouse and keyboard input. Zero dependencies; needs Node 22+ (global WebSocket).
//
// This is a rebuild (2026-09-26) of the original harness lost in the move to
// the AGENT share. The project lesson it exists for: UI behaviour verified with
// real input beats reasoning about code — the guide's pointer-capture bug, the
// divider hit-test and the dead-recovery ladder were all found this way.
//
// Library use:
//   import { launchChrome, connectCdp, drive } from "./cdp-drive.mjs";
//   const chrome = await launchChrome();            // or {wsUrl} to attach
//   const page = await connectCdp(chrome.wsUrl);
//   const d = await drive(page);
//   await d.goto("http://localhost:8085");
//   await d.clickSelector("#some-button");
//   await d.typeInto('input[name="username"]', "localdev");
// CLI smoke use:
//   node scripts/cdp-drive.mjs <url>   # navigates and prints the page title
//
// Env: CHROME_BIN (defaults to Google Chrome on macOS), CDP_HEADLESS=0 to show
// the browser (default headless).

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME_BIN =
  process.env.CHROME_BIN ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// --- launching ---------------------------------------------------------------

export async function launchChrome({
  headless = process.env.CDP_HEADLESS !== "0",
  wsUrl = null,
} = {}) {
  if (wsUrl) return { wsUrl, child: null, userDataDir: null };
  const userDataDir = mkdtempSync(join(tmpdir(), "cdp-drive-"));
  const child = spawn(
    CHROME_BIN,
    [
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=DialMediaRouteProvider", // keeps the log line clean
      headless ? "--headless=new" : "--start-maximized",
      "--window-size=1600,1000",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const wsUrlFromLog = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Chrome did not report a DevTools endpoint in 15s")),
      15000,
    );
    const onData = (buf) => {
      const m = String(buf).match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stderr.on("data", onData);
    child.on("exit", (code) => reject(new Error(`Chrome exited early (${code})`)));
  });
  return { wsUrl: wsUrlFromLog, child, userDataDir };
}

export function closeChrome(chrome) {
  try {
    chrome.child?.kill();
  } catch {}
  try {
    if (chrome.userDataDir) rmSync(chrome.userDataDir, { recursive: true, force: true });
  } catch {}
}

// --- CDP connection ----------------------------------------------------------
//
// One WebSocket to the browser endpoint; every page command goes through a
// flat session (Target.attachToTarget), so multiple targets stay usable.

export async function connectCdp(browserWsUrl) {
  const ws = new WebSocket(browserWsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("WebSocket to Chrome failed"));
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners) fn(msg);
    }
  };
  const rawSend = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  async function attachToPage(targetId) {
    const { sessionId } = await rawSend("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const page = {
      sessionId,
      send: (method, params) => rawSend(method, params, sessionId),
      on: (fn) => {
        listeners.push(fn);
        return () => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
    };
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Log.enable");
    return page;
  }

  async function newPage(url = "about:blank") {
    const { targetId } = await rawSend("Target.createTarget", { url });
    return attachToPage(targetId);
  }

  return {
    rawSend,
    newPage,
    attachToPage,
    close: () => ws.close(),
  };
}

// --- the driver (one page) ---------------------------------------------------

export async function drive(page) {
  const consoleLines = [];
  page.on((msg) => {
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
      consoleLines.push(`[console.${msg.params.type}] ${text}`);
    } else if (msg.method === "Log.entryAdded") {
      consoleLines.push(`[${msg.params.entry.source}] ${msg.params.entry.text}`);
    }
  });

  const evalJs = async (expression, { awaitPromise = false } = {}) => {
    const r = await page.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description || "evaluate failed");
    return r.result?.value;
  };

  const centerOf = (selector) =>
    evalJs(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);

  const mouse = (type, x, y, extra = {}) =>
    page.send("Input.dispatchMouseEvent", {
      type, x, y, button: "left", buttons: type === "mousePressed" || extra.dragging ? 1 : 0,
      clickCount: extra.clickCount ?? (type === "mousePressed" || type === "mouseReleased" ? 1 : 0),
      ...extra,
    });

  const d = {
    page,
    consoleLines,

    async goto(url, { timeout = 30000 } = {}) {
      const loaded = new Promise((res) => {
        const off = page.on((msg) => {
          if (msg.method === "Page.loadEventFired") {
            off();
            res();
          }
        });
        setTimeout(() => {
          off();
          res();
        }, timeout); // never hang the harness on a slow page
      });
      await page.send("Page.navigate", { url });
      await loaded;
      return evalJs("document.title");
    },

    // Real mouse events at coordinates — the default click.
    async clickAt(x, y) {
      await mouse("mouseMoved", x, y);
      await sleep(30);
      await mouse("mousePressed", x, y);
      await sleep(40);
      await mouse("mouseReleased", x, y);
    },

    async clickSelector(selector) {
      const pos = await centerOf(selector);
      if (!pos) throw new Error(`nothing visible to click: ${selector}`);
      await d.clickAt(pos.x, pos.y);
      return pos;
    },

    // In-page .click() — for virtualized lists where the framework retargets
    // synthetic coordinates (the v0.12/v0.17 pointer-capture lesson).
    async domClick(selector) {
      return evalJs(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false; el.click(); return true; })()`,
      );
    },

    async drag(x1, y1, x2, y2, { steps = 12 } = {}) {
      await mouse("mouseMoved", x1, y1);
      await mouse("mousePressed", x1, y1);
      for (let i = 1; i <= steps; i++) {
        await mouse(
          "mouseMoved",
          x1 + ((x2 - x1) * i) / steps,
          y1 + ((y2 - y1) * i) / steps,
          { dragging: true },
        );
        await sleep(16);
      }
      await mouse("mouseReleased", x2, y2);
    },

    async pressKey(key, { code, modifiers = 0 } = {}) {
      const k = key.length === 1 ? { text: key, key, unmodifiedText: key } : { key };
      await page.send("Input.dispatchKeyEvent", {
        type: "keyDown", code: code ?? key, windowsVirtualKeyCode: 0, modifiers, ...k,
      });
      await page.send("Input.dispatchKeyEvent", {
        type: "keyUp", code: code ?? key, windowsVirtualKeyCode: 0, modifiers, key,
      });
    },

    async typeInto(selector, text) {
      await d.clickSelector(selector);
      for (const ch of text) {
        await page.send("Input.dispatchKeyEvent", {
          type: "keyDown", code: "", key: ch, text: ch, unmodifiedText: ch,
        });
        await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code: "" });
      }
    },

    // Poll a predicate (given as a JS expression string) until truthy.
    async waitFor(expression, { timeout = 15000, interval = 250 } = {}) {
      const deadline = Date.now() + timeout;
      for (;;) {
        let v = null;
        try {
          v = await evalJs(expression);
        } catch {} // transient evaluate errors during navigation are normal
        if (v) return v;
        if (Date.now() > deadline)
          throw new Error(`waitFor timed out (${timeout}ms): ${expression}`);
        await sleep(interval);
      }
    },

    async screenshot(file) {
      const { data } = await page.send("Page.captureScreenshot", { format: "png" });
      if (file) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(file, Buffer.from(data, "base64"));
      }
      return data;
    },

    text: () => evalJs("document.body.innerText"),
  };
  return d;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- CLI smoke: navigate and report -------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.argv[2];
  if (!url) {
    console.error("usage: node scripts/cdp-drive.mjs <url>");
    process.exit(2);
  }
  const chrome = await launchChrome();
  try {
    const cdp = await connectCdp(chrome.wsUrl);
    const page = await cdp.newPage();
    const d = await drive(page);
    const title = await d.goto(url);
    console.log(`title: ${title}`);
    console.log(`console lines: ${d.consoleLines.length}`);
    await cdp.close();
  } finally {
    closeChrome(chrome);
  }
}
