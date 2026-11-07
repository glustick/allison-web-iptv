#!/usr/bin/env node
// One scripted check of the thing that actually matters: sign in → Live TV → play a channel → the
// playhead moves. Everything else in this repo's test suite is unit-level; this is the smoke test
// the ROADMAP has been asking for since September ("a single scripted login → guide → drag → play
// check that a future change runs by default rather than assembling each time").
//
// It drives a real Chrome over the DevTools Protocol (scripts/cdp-drive.mjs) and asserts on the real
// <video> element, so a broken attach path, a CSP regression or a dead relay fails here.
//
// Prerequisites — both must be running:
//   node scripts/fixture-provider.mjs                      # a fake Xtream panel on :8091
//   DATA_DIR=/tmp/iptv-check PORT=8099 SESSION_SECRET=... node dist/server/index.js
// and the account must exist and have that fixture configured. Then:
//   APP_PASS=… node scripts/verify-ui.mjs
//
// Env: BASE_URL, APP_USER, APP_PASS (required), CHANNEL_TIMEOUT_MS.
import { launchChrome, closeChrome, connectCdp, drive } from './cdp-drive.mjs'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8099'
const USER = process.env.APP_USER ?? 'chris'
const PASS = process.env.APP_PASS
const TIMEOUT = Number(process.env.CHANNEL_TIMEOUT_MS ?? 20000)

if (!PASS) {
  console.error('verify-ui: APP_PASS is required (the account password for APP_USER)')
  process.exit(2)
}

const fail = (message, d) => {
  console.error(`FAIL  ${message}`)
  if (d?.consoleLines?.length) {
    console.error('--- page console ---')
    for (const line of d.consoleLines.slice(-20)) console.error(`  ${line}`)
  }
  process.exit(1)
}

/**
 * Set a field the way React sees it: the native value setter plus an `input` event. `typeInto`
 * synthesises keystrokes, which needs the element to be visible and focused — fine in a wide window,
 * brittle in a headless one, and irrelevant to what this script is proving.
 */
const setInput = (d, selector, value) =>
  d.waitFor(
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`,
    { timeout: 10000 }
  )

const clickByText = (d, text) =>
  d.waitFor(
    `(() => {
      const el = [...document.querySelectorAll('button, a')].find((b) => b.textContent.trim() === ${JSON.stringify(text)});
      if (!el) return false;
      el.click();
      return true;
    })()`,
    { timeout: 10000 }
  )

let chrome
let cdp
try {
  chrome = await launchChrome()
  cdp = await connectCdp(chrome.wsUrl)
  const page = await cdp.newPage()
  const d = await drive(page)

  console.log(`verify-ui: ${BASE}`)
  await d.goto(BASE)

  // Sign in — unless a session is already live, in which case the form is not there.
  const needsLogin = await d.waitFor(
    `Boolean(document.querySelector('input[type="password"]')) || Boolean(document.querySelector('.tab'))`,
    { timeout: 15000 }
  )
  if (needsLogin === true) {
    const hasForm = await d.waitFor(`Boolean(document.querySelector('input[type="password"]'))`, { timeout: 3000 }).catch(() => false)
    if (hasForm) {
      // React omits `type="text"` (it is the default), so an attribute selector for it never
      // matches — select "the input that is not the password one" instead.
      await setInput(d, 'input:not([type="password"])', USER)
      await setInput(d, 'input[type="password"]', PASS)
      await clickByText(d, 'Sign in')
    }
  }

  // A first-run admin lands on the provider setup screen; skip into the console instead.
  await d.waitFor(`Boolean(document.querySelector('.tab')) || Boolean(document.querySelector('input[type="url"], input[placeholder*="server"]'))`, { timeout: 20000 })
  const onSetup = await d.waitFor(`Boolean([...document.querySelectorAll('button')].find((b) => b.textContent.includes('without IPTV setup')))`, { timeout: 2000 }).catch(() => false)
  if (onSetup) await clickByText(d, 'Open the admin console without IPTV setup')

  await d.waitFor(`Boolean(document.querySelector('.tab'))`, { timeout: 15000 })
  console.log('  signed in')

  // Live TV, then the whole catalogue: the landing view is Favourites, which may be empty.
  const liveTab = await d.waitFor(
    `(() => { const b = [...document.querySelectorAll('.tab')].find((t) => t.textContent.trim() === 'Live TV'); if (!b || b.disabled) return false; b.click(); return true; })()`,
    { timeout: 10000 }
  )
  if (!liveTab) fail('Live TV tab is not available (no provider configured?)', d)

  await clickByText(d, 'All').catch(() => {})
  await d.waitFor(`Boolean(document.querySelector('.epg-block:not(.epg-block--past)')) || Boolean(document.querySelector('.channel-row'))`, { timeout: 15000 })
  console.log('  guide/list rendered')

  // Play the first live programme block. This must be a **real mouse event**, not el.click(): a
  // synthetic click is not a user gesture, so Chrome blocks autoplay with sound and the playhead
  // never moves — which looks exactly like a broken player.
  const target = (await d.waitFor(`Boolean(document.querySelector('.epg-block:not(.epg-block--past)'))`, { timeout: 10000 }))
    ? '.epg-block:not(.epg-block--past)'
    : '.channel-row'
  await d.clickSelector(target)
  console.log(`  clicked ${target}`)

  // The assertion: a <video> exists and its playhead has advanced.
  const advanced = await d.waitFor(
    `(() => { const v = document.querySelector('video'); return Boolean(v) && !v.paused && v.currentTime > 1; })()`,
    { timeout: TIMEOUT, interval: 500 }
  ).catch(() => false)

  if (!advanced) {
    const state = await d.waitFor(`(() => { const v = document.querySelector('video'); return v ? { paused: v.paused, t: v.currentTime, src: v.currentSrc } : 'no video' })()`, { timeout: 2000 })
    fail(`playback did not advance: ${JSON.stringify(state)}`, d)
  }

  const info = await d.waitFor(
    `(() => { const v = document.querySelector('video'); return { t: Number(v.currentTime.toFixed(1)), w: v.videoWidth, h: v.videoHeight }; })()`,
    { timeout: 3000 }
  )
  console.log(`  playing: t=${info.t}s, ${info.w}x${info.h}`)
  console.log('PASS  login → Live TV → play → playhead advancing')
} catch (err) {
  console.error(`FAIL  ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
} finally {
  try {
    await cdp?.close()
  } catch {}
  if (chrome) closeChrome(chrome)
}
