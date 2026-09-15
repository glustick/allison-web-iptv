// Drives a real Chrome over the DevTools Protocol using Node's built-in WebSocket (Node 22) — no
// Playwright, no dependencies. Real mouse events (Input.dispatchMouseEvent) reach React's pointer
// handlers, which is the only way to verify a drag end to end.
const PORT = 9222
const APP = 'http://127.0.0.1:8090'
const PW = (await import('node:fs')).readFileSync('/tmp/ui2_pw.txt', 'utf8').trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map()
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result)
    }
  }
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws error')) })
    return new CDP(ws)
  }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((res, rej) => this.pending.set(id, { res, rej }))
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description || ''))
    return r.result.value
  }
  async mouse(type, x, y, buttons) {
    await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: buttons ?? 1, clickCount: type === 'mouseReleased' ? 1 : 0 })
  }
  async drag(x0, y0, x1, y1, steps = 12) {
    await this.mouse('mouseMoved', x0, y0, 0)
    await this.mouse('mousePressed', x0, y0, 1)
    for (let i = 1; i <= steps; i += 1) {
      await this.mouse('mouseMoved', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, 1)
      await sleep(20)
    }
    await this.mouse('mouseReleased', x1, y1, 0)
    await sleep(150)
  }
}

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = targets.find((t) => t.type === 'page' && t.url.startsWith(APP)) || targets.find((t) => t.type === 'page')
const cdp = await CDP.connect(page.webSocketDebuggerUrl)
await cdp.send('Runtime.enable')
await cdp.send('Page.enable')

const out = {}
const waitFor = async (expr, ms = 20000, label = expr) => {
  const start = Date.now()
  for (;;) {
    try { const v = await cdp.eval(expr); if (v) return v } catch (e) {}
    if (Date.now() - start > ms) throw new Error('timeout waiting for ' + label)
    await sleep(150)
  }
}

try {
  await waitFor('!!document.querySelector("input")', 20000, 'login screen')
  out.login = await cdp.eval(`(async () => {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'uitest', password: ${JSON.stringify(PW)} }) })
    return r.status
  })()`)
  await cdp.send('Page.reload')
  await waitFor('!!document.querySelector(".tab")', 25000, 'app tabs')

  await cdp.eval(`[...document.querySelectorAll('.tab')].find(b => /live tv/i.test(b.textContent)).click()`)
  await waitFor('!!document.querySelector(".sidebar .category-btn")', 20000, 'categories')
  await sleep(400)
  out.title_allChannels = await cdp.eval(`document.querySelector('.list-toolbar-title')?.textContent ?? null`)

  await cdp.eval(`[...document.querySelectorAll('.sidebar .category-btn')].find(b => /^News/i.test(b.textContent.trim())).click()`)
  await waitFor('!!document.querySelector(".epg-row-timeline")', 20000, 'guide rows')
  await sleep(600)
  out.title_afterCategory = await cdp.eval(`document.querySelector('.list-toolbar-title')?.textContent ?? null`)
  out.rows = await cdp.eval(`document.querySelectorAll('.epg-row').length`)

  // --- the category panel: geometry + what actually sits under the divider ---
  out.geometry = await cdp.eval(`(() => {
    const sb = document.querySelector('.sidebar')
    const h = document.querySelector('.resize-handle--sidebar')
    const sbR = sb.getBoundingClientRect(), hR = h.getBoundingClientRect()
    const probeX = Math.round(sbR.right - 1), probeY = Math.round(sbR.top + 200)
    const under = document.elementFromPoint(probeX, probeY)
    return { sidebar: { left: Math.round(sbR.left), right: Math.round(sbR.right), width: Math.round(sbR.width) },
             handle: { left: Math.round(hR.left), right: Math.round(hR.right), width: Math.round(hR.width) },
             probe: { x: probeX, y: probeY },
             elementUnderDivider: under ? (under.className || under.tagName) : null,
             isHandle: !!(under && under.classList && under.classList.contains('resize-handle--sidebar')) }
  })()`)

  const before = out.geometry.sidebar.width
  const h = out.geometry.handle
  await cdp.drag(Math.round((h.left + h.right) / 2), 400, Math.round((h.left + h.right) / 2) + 90, 400)
  out.sidebarWidth_afterDrag = await cdp.eval(`Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)`)
  out.sidebarResize = { before, after: out.sidebarWidth_afterDrag, changed: out.sidebarWidth_afterDrag !== before }

  // --- vertical drag on a row: the channel list should move ---
  const scrollBefore = await cdp.eval(`document.querySelector('.epg-grid-body > div')?.scrollTop ?? -1`)
  const rowBox = await cdp.eval(`(() => { const r = document.querySelectorAll('.epg-row-timeline')[5].getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  await cdp.drag(rowBox.x, rowBox.y, rowBox.x, rowBox.y + 160)
  const scrollAfter = await cdp.eval(`document.querySelector('.epg-grid-body > div')?.scrollTop ?? -1`)
  out.verticalDrag = { scrollBefore, scrollAfter, moved: scrollAfter - scrollBefore }

  // --- horizontal drag on the ruler: time should move (the 0.12.0 behaviour, still intact) ---
  const ticksBefore = await cdp.eval(`[...document.querySelectorAll('.epg-time-tick')].map(e => e.textContent).join(',')`)
  const ruler = await cdp.eval(`(() => { const r = document.querySelector('.epg-time-header-track').getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  await cdp.drag(ruler.x, ruler.y, ruler.x - 220, ruler.y)
  const ticksAfter = await cdp.eval(`[...document.querySelectorAll('.epg-time-tick')].map(e => e.textContent).join(',')`)
  out.horizontalDrag = { ticksBefore, ticksAfter, changed: ticksBefore !== ticksAfter }

  out.ok = true
} catch (err) {
  out.ok = false
  out.error = String(err && err.stack || err)
}
console.log(JSON.stringify(out, null, 2))
process.exit(0)
