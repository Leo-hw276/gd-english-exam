/** 登录部署站后，列出后台面板里所有输入框的实际可见情况 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SITE = process.env.SITE || 'https://gd-english-exam-five.vercel.app';
const CHROME = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9353;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.resolve('.chrome-profile-dump')}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
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
await send('Page.navigate', { url: SITE + '/#admin' });
await sleep(4000);
await ev(`const p=document.querySelector('#ad-pass'); if(p){p.value='Leo456le';} document.querySelector('#btn-admin-login')?.click(); 'ok'`);

// 等面板出现，最多 30 秒
let shown = false;
for (let i = 0; i < 15; i++) {
  shown = await ev(`document.querySelector('#admin-panel')?.style.display !== 'none'`);
  if (shown) break;
  await sleep(2000);
}
console.log('面板已显示:', shown);

const dump = await ev(`(()=>{
  const out = [];
  document.querySelectorAll('#admin-panel input, #admin-panel select').forEach(el => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    // 向上找最近的隐藏祖先
    let hidden = false, node = el;
    while (node && node !== document.body) { if (getComputedStyle(node).display === 'none') { hidden = true; break; } node = node.parentElement; }
    out.push({ id: el.id || '(无id)', tag: el.tagName, type: el.type||'', 宽: Math.round(r.width), 高: Math.round(r.height),
               可见: !hidden && cs.visibility !== 'hidden' && r.width > 0, 禁用: el.disabled, 值: String(el.value||'').slice(0,28) });
  });
  return out;
})()`);
console.log('\n后台面板里的所有输入控件：');
console.log('  ' + 'ID'.padEnd(18) + '类型'.padEnd(10) + '宽x高'.padEnd(12) + '可见  禁用  当前值');
for (const d of dump || []) {
  console.log('  ' + String(d.id).padEnd(18) + String(d.tag + '/' + d.type).padEnd(10) + `${d.宽}x${d.高}`.padEnd(12) + `${d.可见 ? '✓' : '✗'}`.padEnd(6) + `${d.禁用 ? '✓' : '✗'}`.padEnd(6) + d.值);
}

const cards = await ev(`[...document.querySelectorAll('#admin-panel .card h2')].map(h=>h.textContent.trim()).join(' | ')`);
console.log('\n后台卡片顺序:', cards);

const shot = await send('Page.captureScreenshot', {});
fs.mkdirSync('scratch/shots', { recursive: true });
fs.writeFileSync('scratch/shots/vercel-admin-full.png', Buffer.from(shot.data, 'base64'));
console.log('整页截图: scratch/shots/vercel-admin-full.png');

ws.close(); chrome.kill(); await sleep(300);
process.exit(0);
