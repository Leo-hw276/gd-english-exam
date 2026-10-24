/** 追踪部署站上「点登录」时浏览器发出的每个请求与响应，定位失败点 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SITE = process.env.SITE || 'https://gd-english-exam-five.vercel.app';
const CHROME = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9351;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.resolve('.chrome-profile-trace')}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch {} await sleep(300); }
const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
let msgId = 0; const pending = new Map();
const reqs = new Map(); const events = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m.result); return; }
  if (m.method === 'Network.requestWillBeSent' && m.params.request.url.includes('/api/')) {
    reqs.set(m.params.requestId, { url: m.params.request.url.replace(SITE, ''), method: m.params.request.method, hdrs: m.params.request.headers });
    events.push('→ ' + m.params.request.method + ' ' + m.params.request.url.replace(SITE, ''));
  }
  if (m.method === 'Network.responseReceived' && reqs.has(m.params.requestId)) {
    const r = reqs.get(m.params.requestId);
    r.status = m.params.response.status;
    events.push('← ' + r.status + ' ' + r.url);
  }
  if (m.method === 'Network.loadingFailed' && reqs.has(m.params.requestId)) {
    const r = reqs.get(m.params.requestId);
    events.push('✗ 失败 ' + r.url + ' : ' + m.params.errorText);
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (txt) events.push('[console] ' + txt.slice(0, 200));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    events.push('[异常] ' + (m.params.exceptionDetails?.exception?.description || '').slice(0, 300));
  }
});
const send = (m, p = {}) => new Promise((res) => { const i = ++msgId; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }))?.result?.value;
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable'); await send('Log.enable');

await send('Page.navigate', { url: SITE + '/#admin' });
await sleep(4000);
events.length = 0; // 只关心点击登录之后的流量

console.log('--- 点击「确认」登录 ---');
await ev(`const p=document.querySelector('#ad-pass'); if(p){p.value='Leo456le';} document.querySelector('#btn-admin-login')?.click(); 'ok'`);
await sleep(6000);

for (const e of events) console.log('  ' + e);

console.log('\n面板显示:', await ev(`document.querySelector('#admin-panel')?.style.display !== 'none'`));
console.log('登录卡显示:', await ev(`document.querySelector('#admin-login-card')?.style.display !== 'none'`));
console.log('页面上的提示条:', await ev(`document.querySelector('#toast')?.textContent || '(无)'`));
console.log('localStorage 里的 token:', await ev(`Object.keys(localStorage).join(',') || '(空)'`));

ws.close(); chrome.kill(); await sleep(300);
process.exit(0);
