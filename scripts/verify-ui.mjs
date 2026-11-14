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

  // --- watched state (v0.97.0): tick a film, see the badge, hide it, bring it back ------------
  const moviesTab = await d.waitFor(
    `(() => { const b = [...document.querySelectorAll('.tab')].find((t) => t.textContent.trim() === 'Movies'); if (!b || b.disabled) return false; b.click(); return true; })()`,
    { timeout: 10000 }
  )
  if (!moviesTab) fail('Movies tab is not available', d)
  await clickByText(d, 'All').catch(() => {})
  await d.waitFor(`document.querySelectorAll('.channel-row').length > 0`, { timeout: 15000 })

  const ticked = await d.waitFor(
    `(() => { const b = document.querySelector('.watched-toggle'); if (!b) return false; b.click(); return true; })()`,
    { timeout: 8000 }
  )
  if (!ticked) fail('no watched toggle on a film row', d)

  const badged = await d.waitFor(`Boolean(document.querySelector('.watched-badge'))`, { timeout: 8000 }).catch(() => false)
  if (!badged) fail('ticking a film did not show the watched badge', d)
  console.log('  watched badge appears')

  const beforeHide = await d.waitFor(`document.querySelectorAll('.channel-row').length`, { timeout: 3000 })
  const hid = await d.waitFor(
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.startsWith('Hide watched')); if (!b) return false; b.click(); return true; })()`,
    { timeout: 8000 }
  )
  if (!hid) fail('no Hide watched toggle after ticking a film', d)
  const afterHide = await d.waitFor(`document.querySelectorAll('.channel-row').length`, { timeout: 5000 })
  if (!(afterHide === beforeHide - 1)) fail(`hiding watched did not remove exactly one row (${beforeHide} → ${afterHide})`, d)

  const restored = await d.waitFor(
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.startsWith('Show watched')); if (!b) return false; b.click(); return true; })()`,
    { timeout: 8000 }
  )
  if (!restored) fail('no Show watched toggle to restore the row', d)
  const afterRestore = await d.waitFor(`document.querySelectorAll('.channel-row').length`, { timeout: 5000 })
  if (afterRestore !== beforeHide) fail(`restoring watched did not bring the row back (${afterHide} → ${afterRestore})`, d)

  // Leave the fixture as it was found: untick the film we ticked.
  await d.waitFor(
    `(() => { const b = document.querySelector('.watched-toggle.active'); if (!b) return false; b.click(); return true; })()`,
    { timeout: 5000 }
  ).catch(() => {})
  console.log('  watched filter hides and restores the row')

  // --- v0.102 attribution: the connections endpoint answers per-account buckets -------------
  // While a stream is playing is the moment the count is non-zero. The page's own cookie rides
  // the fetch, so this is the authenticated shape the toolbar reads.
  // waitFor polls a synchronous expression, so the fetch stashes its answer on the window and
  // the poll waits for it to land.
  await d.waitFor(
    `(() => { if (window.__conn) return true; fetch('/api/iptv/connections').then((r) => r.json()).then((j) => { window.__conn = j }).catch(() => { window.__conn = { error: true } }); return Boolean(window.__conn); })()`,
    { timeout: 8000 }
  ).catch(() => fail('connections endpoint did not answer', d))
  const connections = await d.waitFor(`window.__conn`, { timeout: 3000 })
  const bucketSum = (connections.accounts ?? []).reduce((sum, row) => sum + row.used, 0)
  if (!Array.isArray(connections.accounts)) fail(`connections endpoint answers no accounts array: ${JSON.stringify(connections).slice(0, 200)}`, d)
  if (bucketSum !== connections.used) fail(`account buckets (${bucketSum}) do not add up to the total (${connections.used})`, d)
  if (connections.used < 1) fail(`connection count is ${connections.used} while a stream is playing — the ledger is not counting`, d)
  console.log(`  connections: ${connections.used} in use, ${connections.accounts.length} account bucket(s), buckets sum to the total`)

  // --- v0.102 audit filters: the Auth log narrows to one outcome -----------------------------
  // Admin and System open in their OWN tab (v0.16.0), so there is no tab to click here —
  // their ?tab= deep links navigate this page to the same screens instead.
  const isAdmin = await d.waitFor(`document.querySelector('.tab')?.textContent`, { timeout: 3000 }).catch(() => null)
  if (typeof isAdmin !== 'string') {
    console.log('  (no tab bar — skipping the Auth log filter check)')
  } else {
    await d.goto(`${BASE}/?tab=admin`)
    // The deep link's first render can land on the login screen while the session is still
    // being confirmed — the same sign-in as at the top, run again when needed.
    // The deep link's first render can flash the login screen while the session is being
    // confirmed — content first, and only a PERSISTENT login card (the admin console has
    // password fields of its own) is worth signing into again.
    let auditReady = await d.waitFor(`Boolean(document.querySelector('.audit-outcome'))`, { timeout: 8000 }).catch(() => false)
    if (!auditReady) {
      const loginStays = await d.waitFor(`Boolean(document.querySelector('.login-card input[type="password"]'))`, { timeout: 4000 }).catch(() => false)
      if (!loginStays) fail('Admin tab rendered neither the Auth log nor a login screen', d)
      await setInput(d, '.login-card input:not([type="password"])', USER)
      await setInput(d, '.login-card input[type="password"]', PASS)
      await clickByText(d, 'Sign in')
      auditReady = await d.waitFor(`Boolean(document.querySelector('.audit-outcome'))`, { timeout: 10000 }).catch(() => false)
      if (!auditReady) fail('Auth log did not render after signing in', d)
    }
    const before = await d.waitFor(`document.querySelectorAll('.audit-outcome').length`, { timeout: 5000 })
    // The outcome filter is the select whose options are outcomes ('logout' is never a role) —
    // the admin console's role dropdown comes first in the DOM and is not this control.
    const choseOutcome = await d.waitFor(
      `(() => { const sel = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'logout')); if (!sel) return false; sel.value = 'ok'; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
      { timeout: 8000 }
    )
    if (!choseOutcome) fail('Auth log has no outcome filter select', d)
    await d.waitFor(
      `(() => { const rows = [...document.querySelectorAll('.audit-outcome')]; return rows.length > 0 && rows.every((r) => r.textContent.trim() === 'ok'); })()`,
      { timeout: 8000 }
    ).catch(() => fail('filtering the Auth log to outcome=ok left non-ok rows (or none)', d))
    const after = await d.waitFor(`document.querySelectorAll('.audit-outcome').length`, { timeout: 5000 })
    console.log(`  Auth log filter: ${before} rows → ${after} rows, all outcome=ok`)
  }

  // --- v0.105 Safari HEVC probe: the section is present in System -----------------------------
  await d.goto(`${BASE}/?tab=system`)
  {
    // Content-first, exactly like the admin check above: the deep link's first render can flash
    // the login screen while the session is confirmed, and matching the flash (this once did)
    // races the re-login into a card that has already been replaced by content.
    let systemReady = await d.waitFor(`[...document.querySelectorAll('h2')].some((h) => h.textContent.trim() === 'Safari HEVC probe')`, { timeout: 8000 }).catch(() => false)
    if (!systemReady) {
      const loginStays = await d.waitFor(`Boolean(document.querySelector('.login-card input[type="password"]'))`, { timeout: 4000 }).catch(() => false)
      if (!loginStays) fail('System tab rendered neither its panels nor a login screen', d)
      await setInput(d, '.login-card input:not([type="password"])', USER)
      await setInput(d, '.login-card input[type="password"]', PASS)
      await clickByText(d, 'Sign in')
      systemReady = await d.waitFor(`[...document.querySelectorAll('h2')].some((h) => h.textContent.trim() === 'Safari HEVC probe')`, { timeout: 10000 }).catch(() => false)
      if (!systemReady) fail('System tab did not render its panels after signing in', d)
    }
    await d
      .waitFor(`[...document.querySelectorAll('h2')].some((h) => h.textContent.trim() === 'Safari HEVC probe')`, { timeout: 10000 })
      .catch(() => fail('Safari HEVC probe section missing from System', d))
    console.log('  Safari HEVC probe section present in System')
  }

  console.log('PASS  login → Live TV → play → playhead advancing → watched toggle → filter → attribution → audit filters → probe present')
} catch (err) {
  console.error(`FAIL  ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
} finally {
  try {
    await cdp?.close()
  } catch {}
  if (chrome) closeChrome(chrome)
}
