const PORT = 9222
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
class CDP {
  constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();ws.onmessage=(e)=>{const m=JSON.parse(e.data);const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);m.error?p.rej(new Error(m.error.message)):p.res(m.result)}}
  static async connect(u){const ws=new WebSocket(u);await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=()=>rej(new Error('ws'))});return new CDP(ws)}
  send(m,p={}){const id=++this.id;this.ws.send(JSON.stringify({id,method:m,params:p}));return new Promise((res,rej)=>this.pending.set(id,{res,rej}))}
  async eval(x){const r=await this.send('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result.value}
  async mouse(type,x,y,buttons){await this.send('Input.dispatchMouseEvent',{type,x,y,button:'left',buttons:buttons??1,clickCount:type==='mouseReleased'?1:0})}
  async drag(x0,y0,x1,y1,steps=14){await this.mouse('mouseMoved',x0,y0,0);await this.mouse('mousePressed',x0,y0,1)
    for(let i=1;i<=steps;i++){await this.mouse('mouseMoved',x0+((x1-x0)*i)/steps,y0+((y1-y0)*i)/steps,1);await sleep(18)}
    await this.mouse('mouseReleased',x1,y1,0);await sleep(250)}
  async key(k){const code=k==='Enter'?'Enter':k;await this.send('Input.dispatchKeyEvent',{type:'keyDown',key:k,code,windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});await this.send('Input.dispatchKeyEvent',{type:'keyUp',key:k,code,windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});await sleep(600)}
}
const t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === 'page')
const cdp = await CDP.connect(t.webSocketDebuggerUrl); await cdp.send('Runtime.enable')
await cdp.eval(`(async () => { await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'uitest', password: 'uitestpass123' }) }); return 1 })()`)
await cdp.send('Page.reload'); await sleep(3000)
for (let i = 0; i < 40 && !(await cdp.eval(`!!document.querySelector('.tab')`)); i += 1) await sleep(250)
await cdp.eval(`[...document.querySelectorAll('.tab')].find(b => /live tv/i.test(b.textContent)).click()`); await sleep(1200)
await cdp.eval(`[...document.querySelectorAll('.sidebar .category-btn')].find(b => b.textContent.trim() === 'All').click()`); await sleep(1200)
const sc = `document.querySelector('.epg-grid-body > div')`
const pt = JSON.parse(await cdp.eval(`(() => { const r = document.querySelectorAll('.epg-row-timeline')[6].getBoundingClientRect()
  return JSON.stringify({x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)}) })()`))
const before = await cdp.eval(`${sc}.scrollTop`)
await cdp.drag(pt.x, pt.y, pt.x, pt.y - 260)
const after = await cdp.eval(`${sc}.scrollTop`)
console.log(`  vertical drag (real mouse): scrollTop ${before} -> ${after}`)
console.log('  keyboard Enter on a focused channel after that drag:')
await cdp.eval(`document.querySelectorAll('.epg-row-channel')[2].focus()`)
await cdp.key('Enter')
console.log('    now playing:', await cdp.eval(`(document.querySelector('.now-playing-bar')||{}).textContent || null`))
const g = await cdp.eval(`(() => { const sb = document.querySelector('.sidebar').getBoundingClientRect()
  const h = document.querySelector('.resize-handle--sidebar').getBoundingClientRect()
  const under = document.elementFromPoint(Math.round(sb.right - 1), Math.round(sb.top + 220))
  return JSON.stringify({ sidebarWidth: Math.round(sb.width), handleWidth: Math.round(h.width),
    startsAt: Math.round(h.left), dividerAt: Math.round(sb.right), underDivider: under ? under.className : null }) })()`)
console.log('  sidebar:', g)
const sx = Math.round(JSON.parse(g).startsAt + JSON.parse(g).handleWidth / 2)
await cdp.drag(sx, 500, sx - 70, 500)
console.log('  after dragging the divider left 70px, sidebar width:',
  await cdp.eval(`Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)`))
process.exit(0)
