/** 删除单句精练后的浏览器冒烟：首页加载、导航顺序、无 JS 错误、核心屏可用 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CHROME = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:8777';
const PORT = 9343;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (l, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? '  →  ' + e : ''}`); };

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.resolve('.chrome-profile-smoke3')}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch {} await sleep(300); }
const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
let msgId = 0; const pending = new Map(); const errors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m.result); }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || 'error');
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
  if (m.method === 'Network.responseReceived' && m.params.response.status === 404) errors.push('404: ' + m.params.response.url);
});
const send = (method, params = {}) => new Promise((res) => { const i = ++msgId; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.value;
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable'); await send('Network.enable');
await send('Page.navigate', { url: BASE });
await sleep(3000);

const nav = await ev(`[...document.querySelectorAll('.topnav a')].map(a=>a.textContent.trim()).join('|')`);
ok('导航顺序: 模拟考试|收费标准|我的账户', nav === '模拟考试|收费标准|我的账户', nav);
ok('无 JS 错误 / 404', errors.length === 0, errors.slice(0, 3).join(' ; '));

await ev(`document.querySelector('[data-goto="screen-intro"]')?.click(); 'ok'`);
await sleep(800);
const introActive = await ev(`document.querySelector('#screen-intro')?.classList.contains('active')`);
ok('模拟考试屏可打开', Boolean(introActive));

await ev(`document.querySelector('[data-goto="screen-pricing"]')?.click(); 'ok'`);
await sleep(800);
const pricingOk = await ev(`Boolean(document.querySelector('#screen-pricing.active'))`);
ok('收费标准屏可打开', Boolean(pricingOk));

await send('Page.captureScreenshot', {}).then((r) => {
  fs.mkdirSync('scratch/shots', { recursive: true });
  fs.writeFileSync('scratch/shots/after-removal.png', Buffer.from(r.data, 'base64'));
});

ws.close(); chrome.kill(); await sleep(300);
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
