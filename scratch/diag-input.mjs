/** 诊断：#ad-base 可见但不可见（与 #ad-key 对比计算样式），移动端宽度 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SITE = process.env.SITE || 'http://127.0.0.1:8777';
const CHROME = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9361;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.resolve('.chrome-profile-diag')}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch {} await sleep(300); }
const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
let msgId = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m.result); } });
const send = (m, p = {}) => new Promise((res) => { const i = ++msgId; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }))?.result?.value;
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Runtime.enable'); await send('Page.enable');

for (const [w, h, label] of [[393, 852, '移动端 iPhone 393'], [1116, 572, '桌面窄窗 1116']]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 500 });
  await send('Page.navigate', { url: SITE + '/#admin' });
  await sleep(2600);
  await ev(`const p=document.querySelector('#ad-pass'); if(p){p.value='Leo456le';} document.querySelector('#btn-admin-login')?.click(); 'ok'`);
  for (let i = 0; i < 12; i++) {
    if (await ev(`document.querySelector('#admin-panel')?.style.display !== 'none'`)) break;
    await sleep(1200);
  }
  await sleep(1200);

  const dump = await ev(`(()=>{
    const grab = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { sel, missing: true };
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const pr = el.parentElement.getBoundingClientRect();
      return {
        sel,
        rect: [Math.round(r.width), Math.round(r.height), Math.round(r.left), Math.round(r.top)],
        parentRect: [Math.round(pr.width), Math.round(pr.height)],
        display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
        color: cs.color, background: cs.backgroundColor, border: cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor,
        webkitTextFill: cs.webkitTextFillColor,
        height: cs.height, minHeight: cs.minHeight, maxHeight: cs.maxHeight,
        overflow: cs.overflow, position: cs.position, transform: cs.transform,
        zIndex: cs.zIndex, marginTop: cs.marginTop, padding: cs.padding,
        clipPath: cs.clipPath, clip: cs.clip,
        appearance: cs.appearance,
        value: String(el.value||'').slice(0,25),
        fontSize: cs.fontSize, lineHeight: cs.lineHeight,
      };
    };
    return { base: grab('#ad-base'), key: grab('#ad-key'), model: grab('#ad-model') };
  })()`);

  console.log(`\n================ 视口 ${label} (${w}x${h}) ================`);
  for (const [n, v] of Object.entries(dump)) {
    if (v.missing) { console.log(`${n}: 元素不存在`); continue; }
    console.log(`\n[${n}] ${v.sel}`);
    console.log(`  尺寸 ${v.rect[0]}x${v.rect[1]} @(${v.rect[2]},${v.rect[3]})  父容器 ${v.parentRect[0]}x${v.parentRect[1]}`);
    console.log(`  display=${v.display} visibility=${v.visibility} opacity=${v.opacity} appearance=${v.appearance}`);
    console.log(`  color=${v.color}  background=${v.background}`);
    console.log(`  border=${v.border}`);
    console.log(`  webkitTextFillColor=${v.webkitTextFill}  fontSize=${v.fontSize} lineHeight=${v.lineHeight}`);
    console.log(`  height=${v.height} minH=${v.minHeight} maxH=${v.maxHeight} overflow=${v.overflow}`);
    console.log(`  position=${v.position} transform=${v.transform} zIndex=${v.zIndex} clipPath=${v.clipPath} clip=${v.clip}`);
    console.log(`  value="${v.value}"`);
  }
}
ws.close(); chrome.kill(); await sleep(300);
process.exit(0);
