const PORT = 9222, APP = 'http://127.0.0.1:8090'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
class CDP {
  constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();ws.onmessage=(e)=>{const m=JSON.parse(e.data);const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);m.error?p.rej(new Error(m.error.message)):p.res(m.result)}}
  static async connect(u){const ws=new WebSocket(u);await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=()=>rej(new Error('ws'))});return new CDP(ws)}
  send(m,p={}){const id=++this.id;this.ws.send(JSON.stringify({id,method:m,params:p}));return new Promise((res,rej)=>this.pending.set(id,{res,rej}))}
  async eval(x){const r=await this.send('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result.value}
  async mouse(type,x,y,buttons){await this.send('Input.dispatchMouseEvent',{type,x,y,button:'left',buttons:buttons??1,clickCount:type==='mouseReleased'?1:0})}
  async drag(x0,y0,x1,y1,steps=12){await this.mouse('mouseMoved',x0,y0,0);await this.mouse('mousePressed',x0,y0,1)
    for(let i=1;i<=steps;i++){await this.mouse('mouseMoved',x0+((x1-x0)*i)/steps,y0+((y1-y0)*i)/steps,1);await sleep(20)}
    await this.mouse('mouseReleased',x1,y1,0);await sleep(200)}
}
const t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === 'page')
const cdp = await CDP.connect(t.webSocketDebuggerUrl)
await cdp.send('Runtime.enable')
console.log('  scrollable elements inside .epg-grid-body:')
console.log(await cdp.eval(`JSON.stringify([...document.querySelectorAll('.epg-grid-body, .epg-grid-body *')]
  .map(el => ({ tag: el.tagName, cls: String(el.className).slice(0, 40), sh: el.scrollHeight, ch: el.clientHeight,
                st: el.scrollTop, oy: getComputedStyle(el).overflowY }))
  .filter(x => x.sh > x.ch + 4))`))
console.log('  listRef element (react-window outer):')
console.log(await cdp.eval(`(() => { const b = document.querySelector('.epg-grid-body');
  const first = b.firstElementChild; return JSON.stringify({ tag: first.tagName, cls: String(first.className).slice(0,40),
    sh: first.scrollHeight, ch: first.clientHeight, oy: getComputedStyle(first).overflowY,
    childCount: first.children.length, childTag: first.firstElementChild?.tagName,
    childCls: String(first.firstElementChild?.className).slice(0,40), childSh: first.firstElementChild?.scrollHeight }) })()`))
const box = await cdp.eval(`(() => { const r = document.querySelectorAll('.epg-row-timeline')[6].getBoundingClientRect()
  return JSON.stringify({x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)}) })()`)
const { x, y } = JSON.parse(box)
console.log('  dragging vertically from', x, y, '(row 6)')
await cdp.drag(x, y, x, y + 180)
console.log('  after drag, scrollTops > 0:')
console.log(await cdp.eval(`JSON.stringify([...document.querySelectorAll('*')].map(el => ({ t: el.tagName, c: String(el.className).slice(0,30), st: el.scrollTop })).filter(x => x.st > 0).slice(0, 5))`))
process.exit(0)
