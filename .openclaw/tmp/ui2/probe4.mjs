const PORT = 9222
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
class CDP {
  constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();ws.onmessage=(e)=>{const m=JSON.parse(e.data);const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);m.error?p.rej(new Error(m.error.message)):p.res(m.result)}}
  static async connect(u){const ws=new WebSocket(u);await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=()=>rej(new Error('ws'))});return new CDP(ws)}
  send(m,p={}){const id=++this.id;this.ws.send(JSON.stringify({id,method:m,params:p}));return new Promise((res,rej)=>this.pending.set(id,{res,rej}))}
  async eval(x){const r=await this.send('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description||''));return r.result.value}
  async mouse(type,x,y,buttons){await this.send('Input.dispatchMouseEvent',{type,x,y,button:'left',buttons:buttons??1,clickCount:type==='mouseReleased'?1:0})}
  async drag(x0,y0,x1,y1,steps=12){await this.mouse('mouseMoved',x0,y0,0);await this.mouse('mousePressed',x0,y0,1)
    for(let i=1;i<=steps;i++){await this.mouse('mouseMoved',x0+((x1-x0)*i)/steps,y0+((y1-y0)*i)/steps,1);await sleep(18)}
    await this.mouse('mouseReleased',x1,y1,0);await sleep(200)}
  async enter(){
    await this.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13})
    await this.send('Input.dispatchKeyEvent',{type:'char',key:'Enter',text:'\r',windowsVirtualKeyCode:13})
    await this.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13})
    await sleep(700)
  }
}
const t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === 'page')
const cdp = await CDP.connect(t.webSocketDebuggerUrl); await cdp.send('Runtime.enable')
await cdp.eval(`(async () => { await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'uitest', password: 'uitestpass123' }) }); return 1 })()`)
await cdp.send('Page.reload'); await sleep(3000)
for (let i = 0; i < 40 && !(await cdp.eval(`!!document.querySelector('.tab')`)); i += 1) await sleep(250)
await cdp.eval(`[...document.querySelectorAll('.tab')].find(b => /live tv/i.test(b.textContent)).click()`); await sleep(1200)
await cdp.eval(`[...document.querySelectorAll('.sidebar .category-btn')].find(b => b.textContent.trim() === 'All').click()`); await sleep(1200)
console.log('  A) Enter on a focused channel WITHOUT any drag first:')
await cdp.eval(`document.querySelectorAll('.epg-row-channel')[2].focus()`)
await cdp.enter()
console.log('     now playing:', await cdp.eval(`(document.querySelector('.now-playing-bar')||{}).textContent || null`))
console.log('  B) the same, but after a drag (the case the setTimeout fix targets):')
const sc = `document.querySelector('.epg-grid-body > div')`
await cdp.eval(`${sc}.scrollTop = 200`)
const pt = JSON.parse(await cdp.eval(`(() => { const r = document.querySelectorAll('.epg-row-timeline')[6].getBoundingClientRect()
  return JSON.stringify({x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)}) })()`))
await cdp.drag(pt.x, pt.y, pt.x, pt.y - 80)
await cdp.eval(`document.querySelectorAll('.epg-row-channel')[4].focus()`)
await cdp.enter()
console.log('     now playing:', await cdp.eval(`(document.querySelector('.now-playing-bar')||{}).textContent || null`))
process.exit(0)
