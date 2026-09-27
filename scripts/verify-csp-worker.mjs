#!/usr/bin/env node
//
// verify-csp-worker.mjs — the CSP worker-src check, rebuilt 2026-09-26.
//
// Why this exists: hls.js runs its demuxer in a blob: worker; a Content-
// Security-Policy without `worker-src` makes the browser refuse it, after
// which hls.js never starts and EVERY stream hangs with one console line and
// no other symptom. Server-side checks all pass while that is true — this
// script loads the real app in a real Chrome, creates a blob: worker, and
// asserts it answers. On failure it quotes the browser's own error line.
//
// Usage:  node scripts/verify-csp-worker.mjs [base-url]     (default :8085)
// Exit:   0 = a blob: worker was created and answered; 1 = refused (CSP or otherwise).
//
// Verified both ways at rebuild time: passes against an uncsp'd page, fails
// against a page with `Content-Security-Policy: worker-src 'none'`.

import { launchChrome, connectCdp, drive, closeChrome } from "./cdp-drive.mjs";

const base = process.argv[2] || process.env.BASE_URL || "http://localhost:8085";

const chrome = await launchChrome();
let failed = false;
try {
  const cdp = await connectCdp(chrome.wsUrl);
  const page = await cdp.newPage();
  const d = await drive(page);
  await d.goto(base, { timeout: 20000 });
  await d.waitFor("document.readyState === 'complete'", { timeout: 15000 });

  const result = await d.page.send("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      const src = "self.onmessage = e => self.postMessage({ pong: true, echo: e.data });";
      const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      try {
        const w = new Worker(url);
        const answer = await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("worker never answered (5s)")), 5000);
          w.onmessage = (e) => { clearTimeout(t); resolve(e.data); };
          w.onerror = (e) => { clearTimeout(t); reject(new Error(e.message || "worker errored")); };
          w.postMessage("ping");
        });
        w.terminate();
        return { ok: answer.pong && answer.echo === "ping" };
      } catch (err) {
        return { ok: false, error: String(err.message || err) };
      }
    })()`,
  });

  const cspLines = d.consoleLines.filter((l) =>
    /Content Security Policy|worker-src/i.test(l),
  );

  if (result.result?.value?.ok) {
    console.log(`PASS — blob: worker created and answered on ${base}`);
  } else {
    failed = true;
    console.log(`FAIL — blob: worker refused on ${base}`);
    const msg = result.result?.value?.error || "unknown error";
    console.log(`  browser said: ${msg}`);
    if (cspLines.length) console.log(`  console: ${cspLines[0]}`);
  }
  await cdp.close();
} catch (err) {
  failed = true;
  console.log(`FAIL — could not run the check: ${err.message}`);
} finally {
  closeChrome(chrome);
}
process.exit(failed ? 1 : 0);
