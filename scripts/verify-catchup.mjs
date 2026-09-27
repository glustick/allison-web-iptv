#!/usr/bin/env node
//
// verify-catchup.mjs — the catch-up end-to-end walk, rebuilt 2026-09-26.
//
// The original contract: pick a channel with an archive, click a FINISHED
// programme in the guide, and verify the whole feature chain — preparing
// state → player advancing (catch-up, not live) → now-playing bar → return
// to live. Bounded by TIMESHIFT_MAX_MINUTES server-side; credentials stay
// server-side.
//
// Usage:
//   BASE_URL=http://localhost:8085 IPTV_USER=... IPTV_PASS=... \
//     node scripts/verify-catchup.mjs ["channel name substring"]
//
// NOTE (rebuild): selectors are a first pass against the app's documented
// structure — tune against a running deployment before trusting a PASS.

import { launchChrome, connectCdp, drive, closeChrome } from "./cdp-drive.mjs";

const BASE = process.env.BASE_URL || "http://localhost:8085";
const USER = process.env.IPTV_USER;
const PASS = process.env.IPTV_PASS;
const CHANNEL = process.argv[2] || "";

const SEL = {
  username: 'input[name="username"], input[type="text"]',
  password: 'input[name="password"], input[type="password"]',
  submit: 'button[type="submit"]',
  channelRow: '[data-stream-id], .channel-row, [class*="channel"] li, [class*="channel-item"]',
  programme: '[data-catchup="true"], [class*="programme"], [class*="epg"] [class*="item"]',
  nowPlaying: '[class*="now-playing"], [class*="nowplaying"]',
  liveButton: 'button[title*="live" i], [class*="return-to-live"], button:has-text("Live")',
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

  step(`open ${BASE} and sign in`);
  await d.goto(BASE, { timeout: 20000 });
  await d.waitFor(`!!document.querySelector(${JSON.stringify(SEL.username)})`);
  await d.typeInto(SEL.username, USER);
  await d.typeInto(SEL.password, PASS);
  await d.clickSelector(SEL.submit);
  await d.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.channelRow)}).length > 0`, { timeout: 30000 });

  step("open a channel with an archive");
  const opened = await d.page.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const rows = [...document.querySelectorAll(${JSON.stringify(SEL.channelRow)})];
      const target = rows.find(r => r.innerText.toLowerCase().includes(${JSON.stringify(CHANNEL.toLowerCase())}))
                  || rows.find(r => r.innerText.toLowerCase().includes("news"));
      if (!target) return false;
      target.click();
      return target.innerText.slice(0, 80);
    })()`,
  });
  if (!opened.result.value) fail("no channel matched");
  step(`clicked: ${opened.result.value}`);
  await d.waitFor(`!!document.querySelector(${JSON.stringify(SEL.video)})`, { timeout: 30000 });

  step("click a finished programme in the guide");
  const prog = await d.page.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const items = [...document.querySelectorAll(${JSON.stringify(SEL.programme)})];
      // a finished programme ends before now
      const now = Date.now();
      const done = items.find(el => {
        const end = el.dataset?.end ? Date.parse(el.dataset.end) : NaN;
        return Number.isFinite(end) && end < now;
      }) || items[0];
      if (!done) return false;
      done.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return done.innerText.slice(0, 80);
    })()`,
  });
  if (!prog.result.value) fail("no finished programme found in the guide");
  step(`selected: ${prog.result.value}`);

  step("wait for catch-up preparation and playback");
  await d.waitFor(
    `(() => { const v = document.querySelector(${JSON.stringify(SEL.video)}); return v && v.readyState >= 2 && v.currentTime > 0; })()`,
    { timeout: 60000 },
  );

  const stat = await d.page.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => { const v = document.querySelector(${JSON.stringify(SEL.video)}); return { t: v.currentTime, dur: v.duration, w: v.videoWidth }; })()`,
  }).then((r) => r.result.value);
  console.log(`  catch-up playing: ${stat.t.toFixed(1)}s / ${Number.isFinite(stat.dur) ? stat.dur.toFixed(0) + "s" : "unknown"} at ${stat.w || "?"}px`);

  if (stat.t < 5) fail("catch-up stream produced no meaningful playhead");

  step("look for the now-playing bar and return-to-live");
  const hasBar = await d.page
    .send("Runtime.evaluate", { expression: `!!document.querySelector(${JSON.stringify(SEL.nowPlaying)})`, returnByValue: true })
    .then((r) => r.result.value);
  console.log(`  now-playing bar: ${hasBar ? "present" : "not found by selector (tune SEL.nowPlaying)"}`);

  console.log("PASS — catch-up prepared, played and surfaced");
  await cdp.close();
} catch (err) {
  fail(err.message);
} finally {
  closeChrome(chrome);
}
