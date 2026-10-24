/** 在真实部署站上复现：登录后台 → v1 地址输入框是否存在/可见/可编辑 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SITE = process.env.SITE || 'https://gd-english-exam-five.vercel.app';
const CHROME = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9349;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.resolve('.chrome-profile-vercel')}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch {} await sleep(300); }
const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
let msgId = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m.result); } });
const send = (m, p = {}) => new Promise((res) => { const i = ++msgId; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }))?.result?.value;
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });

console.log('访问:', SITE + '/#admin');
await send('Page.navigate', { url: SITE + '/#admin' });
await sleep(4000);

const loginShown = await ev(`document.querySelector('#admin-login-card')?.style.display !== 'none'`);
console.log('登录卡显示:', loginShown);

await ev(`const p=document.querySelector('#ad-pass'); if(p){p.value='Leo456le';} document.querySelector('#btn-admin-login')?.click(); 'ok'`);
await sleep(4000);

const panelShown = await ev(`document.querySelector('#admin-panel')?.style.display !== 'none'`);
console.log('登录后面板显示:', panelShown);

const info = await ev(`(()=>{
  const el = document.querySelector('#ad-base');
  if (!el) return { exists:false };
  const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
  return { exists:true, disabled:el.disabled, value:el.value, w:Math.round(r.width), h:Math.round(r.height),
           display:cs.display, visibility:cs.visibility, opacity:cs.opacity, bg:cs.backgroundColor };
})()`);
console.log('v1 地址输入框:', JSON.stringify(info));

const labelText = await ev(`(()=>{const l=document.querySelector('#ad-base')?.previousElementSibling; return l?l.textContent.trim():'(无标签)';})()`);
console.log('它的标签文字:', labelText);
const modelBox = await ev(`(()=>{const el=document.querySelector('#ad-model'); return el?{tag:el.tagName,value:el.value,options:document.querySelectorAll('#ad-model-list option').length}:'缺失';})()`);
console.log('模型框:', JSON.stringify(modelBox));
const keyBox = await ev(`(()=>{const el=document.querySelector('#ad-key'); return el?{tag:el.tagName,placeholder:el.placeholder,disabled:el.disabled}:'缺失';})()`);
console.log('Key 框:', JSON.stringify(keyBox));

await ev(`document.querySelector('#ad-base')?.scrollIntoView({block:'center'}); 'ok'`);
await sleep(600);
const shot = await send('Page.captureScreenshot', {});
fs.mkdirSync('scratch/shots', { recursive: true });
fs.writeFileSync('scratch/shots/vercel-admin.png', Buffer.from(shot.data, 'base64'));
console.log('截图已存: scratch/shots/vercel-admin.png');

ws.close(); chrome.kill(); await sleep(300);
process.exit(0);
