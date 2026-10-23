/** 截图：后台登录前 + 登录后的实际渲染 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CHROME = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:8777';
const PORT = 9346;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.resolve('.chrome-profile-shot')}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch {} await sleep(300); }
const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
let msgId = 0; const pending = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m.result); } });
const send = (m, p = {}) => new Promise((res) => { const i = ++msgId; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value;
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', {});
  fs.mkdirSync('scratch/shots', { recursive: true });
  fs.writeFileSync(`scratch/shots/${name}.png`, Buffer.from(r.data, 'base64'));
  console.log('截图:', name);
};
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

await send('Page.navigate', { url: BASE + '/#admin' });
await sleep(2500);
console.log('登录前 - 登录卡显示:', await ev(`document.querySelector('#admin-login-card')?.style.display !== 'none'`));
await shot('admin-before-login');

// 登录
await ev(`const p=document.querySelector('#ad-pass'); if(p)p.value='Leo456le'; document.querySelector('#btn-admin-login')?.click(); 'ok'`);
await sleep(2500);
console.log('登录后 - 面板显示:', await ev(`document.querySelector('#admin-panel')?.style.display !== 'none'`));
console.log('ad-base 可见:', await ev(`(()=>{const el=document.querySelector('#ad-base'); if(!el) return '元素不存在'; const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return JSON.stringify({display:s.display,visible:r.width>0&&r.height>0,value:el.value.slice(0,30)});})()`));
// 滚动到接口配置卡片再截一张
await ev(`document.querySelector('#ad-base')?.scrollIntoView({block:'center'}); 'ok'`);
await sleep(500);
await shot('admin-after-login');

ws.close(); chrome.kill(); await sleep(300);
process.exit(0);
