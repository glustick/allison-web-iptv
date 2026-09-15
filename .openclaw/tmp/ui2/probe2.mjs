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
}
const t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === 'page')
const cdp = await CDP.connect(t.webSocketDebuggerUrl); await cdp.send('Runtime.enable')
const scroller = `document.querySelector('.epg-grid-body > div')`
// All channels (40 rows) so there is real distance to travel
await cdp.eval(`[...document.querySelectorAll('.sidebar .category-btn')].find(b => b.textContent.trim() === 'All').click()`)
await sleep(900)
console.log('  rows now:', await cdp.eval(`document.querySelectorAll('.epg-row').length`),
            '| scrollable:', await cdp.eval(`(${scroller}.scrollHeight - ${scroller}.clientHeight)`))
const rowMid = JSON.parse(await cdp.eval(`(() => { const r = document.querySelectorAll('.epg-row-timeline')[6].getBoundingClientRect()
  return JSON.stringify({x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)}) })()`))
const before = await cdp.eval(`${scroller}.scrollTop`)
console.log('  dragging UP 300px on a row timeline…')
await cdp.drag(rowMid.x, rowMid.y, rowMid.x, rowMid.y - 300)
const afterUp = await cdp.eval(`${scroller}.scrollTop`)
console.log(`  scrollTop: ${before} -> ${afterUp}   (moved ${afterUp - before}px)`)
console.log('  dragging DOWN 120px again…')
await cdp.drag(rowMid.x, rowMid.y - 60, rowMid.x, rowMid.y + 60)
const afterDown = await cdp.eval(`${scroller}.scrollTop`)
console.log(`  scrollTop: ${afterUp} -> ${afterDown}   (moved ${afterDown - afterUp}px)`)
console.log('  a plain click still selects a channel (no drag):')
await cdp.eval(`document.querySelectorAll('.epg-row-channel')[2].click()`)
await sleep(800)
console.log('  now playing bar:', await cdp.eval(`(document.querySelector('.now-playing-bar')||{}).textContent || null`))
process.exit(0)
