/**
 * 专项验证：transformers.js 能否从本地 vendor 加载，
 * 以及 Kokoro / Whisper 模型是否能真正下载并初始化。
 * 模型较大，这里给足等待时间（默认 240 秒）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CHROME =
  process.env.CHROME_PATH ||
  (fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');

const BASE = process.env.BASE || 'http://127.0.0.1:8777';
const PORT = 9336;
const WAIT = Number(process.env.WAIT_MS || 240000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.resolve('.chrome-profile4')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1440,1000',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break;
  } catch {}
  await sleep(300);
}
const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
const logs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (/practice|transformers|Kokoro|Whisper|onnx|wasm/i.test(txt)) logs.push(txt);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  }
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++msgId;
    pending.set(i, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Runtime.enable');
await send('Page.enable');

const js = async (e) =>
  (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;

console.log('打开首页…');
await send('Page.navigate', { url: BASE });
await sleep(3000);

console.log('进入单句精练，开始加载模型…');
await js(`document.querySelector('[data-goto="screen-practice"]').click()`);

const t0 = Date.now();
let last = '';
while (Date.now() - t0 < WAIT) {
  const status = await js(`document.querySelector('#pm-status')?.textContent || ''`);
  const prog = await js(`document.querySelector('#pm-text')?.textContent || ''`);
  const line = `${status} || ${prog}`;
  if (line !== last) {
    console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s] ${line}`);
    last = line;
  }
  if (/就绪|失败|无法/.test(status)) break;
  await sleep(2000);
}

const src = await js(`window.__tfSource || '(未加载)'`);
const ready = await js(`document.querySelector('#pm-status')?.textContent || ''`);

console.log('\n=== 结论 ===');
console.log('运行时来源 :', src);
console.log('最终状态   :', ready);

if (logs.length) {
  console.log('\n关键日志：');
  logs.slice(-12).forEach((l) => console.log('  ·', String(l).slice(0, 180)));
}

ws.close();
chrome.kill();
await sleep(300);
process.exit(0);
