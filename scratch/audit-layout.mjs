/** 多分辨率审计后台布局：v1 地址输入框在各宽度下是否真的可见可点 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SITE = process.env.SITE || 'http://127.0.0.1:8777';
const CHROME = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9355;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.resolve('.chrome-profile-audit')}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch {} await sleep(300); }
const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
let msgId = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m.result); } });
const send = (m, p = {}) => new Promise((res) => { const i = ++msgId; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }))?.result?.value;
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Runtime.enable'); await send('Page.enable');

const widths = [[1366, 768], [1440, 900], [1600, 900], [1920, 1080], [2560, 1440], [3840, 2160]];
console.log('宽度    ad-base矩形              视口内  可点击  被谁挡住           卡片可见');
for (const [w, h] of widths) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: SITE + '/#admin' });
  await sleep(2500);
  // 确保已登录
  await ev(`const p=document.querySelector('#ad-pass'); if(p && p.offsetParent){p.value='Leo456le'; document.querySelector('#btn-admin-login')?.click();} 'ok'`);
  for (let i = 0; i < 10; i++) {
    if (await ev(`document.querySelector('#admin-panel')?.style.display !== 'none'`)) break;
    await sleep(1500);
  }
  const r = await ev(`(()=>{
    const el = document.querySelector('#ad-base');
    if (!el) return { err: '元素不存在' };
    el.scrollIntoView({ block: 'center' });
    const b = el.getBoundingClientRect();
    const cx = Math.round(b.left + b.width / 2), cy = Math.round(b.top + b.height / 2);
    const hit = (cx > 0 && cy > 0 && cx < innerWidth && cy < innerHeight) ? document.elementFromPoint(cx, cy) : null;
    const blocker = hit && hit !== el && !el.contains(hit) ? (hit.id || hit.className || hit.tagName) : '';
    // 检查是否有祖先裁剪
    let clip = '';
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.overflow !== 'visible' && (n.scrollHeight > n.clientHeight + 2 || n.scrollWidth > n.clientWidth + 2)) clip = (n.id || n.className || n.tagName);
    }
    return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height),
             inView: b.top >= 0 && b.bottom <= innerHeight, clickable: hit === el || el.contains(hit), blocker, clip,
             disabled: el.disabled, value: el.value.slice(0, 30),
             docW: document.documentElement.scrollWidth, winW: innerWidth };
  })()`);
  if (r.err) { console.log(`${String(w).padEnd(7)} ${r.err}`); continue; }
  console.log(`${String(w).padEnd(7)} ${`${r.w}x${r.h}@${r.x},${r.y}`.padEnd(24)} ${(r.inView ? '✓' : '✗').padEnd(7)} ${(r.clickable ? '✓' : '✗').padEnd(7)} ${(r.blocker || '—').padEnd(18)} ${r.clip ? '被裁剪:' + r.clip : '正常'}`);
}
ws.close(); chrome.kill(); await sleep(300);
process.exit(0);
