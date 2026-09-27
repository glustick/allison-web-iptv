#!/usr/bin/env node
//
// cdp-verify-live.mjs — live-playback verification, rebuilt 2026-09-26.
//
// Walks the app's core loop with real input: sign in → guide loads → click a
// live channel → the player's video actually advances. Reports the engine's
// vitals (currentTime, buffered, resolution) so a failure says what happened.
//
// Usage:
//   BASE_URL=http://localhost:8085 IPTV_USER=localdev IPTV_PASS=... \
//     node scripts/cdp-verify-live.mjs ["channel name substring"]
//
// NOTE (rebuild): the semantic steps are from the original harness's contract;
// the selectors below were written against the app's documented structure and
// need one tuning pass against a running deployment before they are trusted.

import { launchChrome, connectCdp, drive, closeChrome } from "./cdp-drive.mjs";

const BASE = process.env.BASE_URL || "http://localhost:8085";
const USER = process.env.IPTV_USER;
const PASS = process.env.IPTV_PASS;
const CHANNEL = process.argv[2] || "";

// --- selectors: tune these against the real deployment if they drift ---------
const SEL = {
  username: 'input[name="username"], input[type="text"]',
  password: 'input[name="password"], input[type="password"]',
  submit: 'button[type="submit"]',
  setupScreen: 'text=IPTV setup', // heuristic: setup screen heading
  channelRow: '[data-stream-id], .channel-row, [class*="channel"] li, [class*="channel-item"]',
  video: "video",
};

const step = (m) => console.log(`→ ${m}`);
const fail = (m) => {
  console.error(`FAIL — ${m}`);
  process.exit(1);
};

if (!USER || !PASS) fail("set IPTV_USER and IPTV_PASS");

const chrome = await launchChrome();
try {
  const cdp = await connectCdp(chrome.wsUrl);
  const page = await cdp.newPage();
  const d = await drive(page);

  step(`open ${BASE}`);
  await d.goto(BASE, { timeout: 20000 });
  await d.waitFor("document.readyState === 'complete'");

  if (await d.page.send("Runtime.evaluate", { expression: `document.body.innerText.includes("IPTV setup")`, returnByValue: true }).then((r) => r.result.value)) {
    fail("the app is showing the IPTV setup screen — complete provider setup once in a browser first");
  }

  step("sign in");
  await d.waitFor(`!!document.querySelector(${JSON.stringify(SEL.username)})`);
  await d.typeInto(SEL.username, USER);
  await d.typeInto(SEL.password, PASS);
  await d.clickSelector(SEL.submit);
  await d.waitFor(`!document.querySelector(${JSON.stringify(SEL.password)}) || !document.querySelector(${JSON.stringify(SEL.password)}).offsetParent`, { timeout: 15000 });
  step("signed in");

  step("wait for the channel list");
  await d.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.channelRow)}).length > 0`, { timeout: 30000 });

  step(`open a live channel${CHANNEL ? ` matching "${CHANNEL}"` : ""}`);
  const clicked = await d.page.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const rows = [...document.querySelectorAll(${JSON.stringify(SEL.channelRow)})];
      const target = rows.find(r => ${JSON.stringify(CHANNEL)} ? r.innerText.toLowerCase().includes(${JSON.stringify(CHANNEL.toLowerCase())}) : true);
      if (!target) return false;
      target.click();                      // virtualized lists need the in-page click
      return target.innerText.slice(0, 80);
    })()`,
  });
  if (!clicked.result.value) fail("no channel row matched");
  step(`clicked: ${clicked.result.value}`);

  step("wait for the player");
  await d.waitFor(`(() => { const v = document.querySelector(${JSON.stringify(SEL.video)}); return v && v.readyState >= 2; })()`, { timeout: 45000 });

  step("measure playback advancing");
  const t0 = await d.page.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(SEL.video)}).currentTime`, returnByValue: true }).then((r) => r.result.value);
  await new Promise((r) => setTimeout(r, 8000));
  const t1 = await d.page.send("Runtime.evaluate", { expression: `(() => { const v = document.querySelector(${JSON.stringify(SEL.video)}); return { t: v.currentTime, w: v.videoWidth, h: v.videoHeight, buffered: v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0 }; })()`, returnByValue: true }).then((r) => r.result.value);

  console.log(`  playhead: ${t0.toFixed(1)}s → ${t1.t.toFixed(1)}s  (${(t1.t - t0).toFixed(1)}s in 8s)`);
  console.log(`  resolution: ${t1.w}x${t1.h}, buffered to ${t1.buffered.toFixed(1)}s`);
  if (t1.t - t0 < 4) fail("playhead did not advance at realtime — playback is stalled");
  console.log(`PASS — live playback advancing${t1.w ? " with video" : " (AUDIO ONLY — no video frames)"}`);
  await cdp.close();
} catch (err) {
  fail(err.message);
} finally {
  closeChrome(chrome);
}
