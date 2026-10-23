/**
 * 抓取模型加载过程中的全部网络请求，特别是 .wasm / .mjs 的加载结果，
 * 用来定位 onnxruntime-web 后端初始化失败的真实原因。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CHROME = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:8777';
const PORT = 9338;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.resolve('.chrome-profile6')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
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
const reqs = new Map();
const logs = [];

ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    return;
  }
  if (m.method === 'Network.requestWillBeSent') {
    const u = m.params.request.url;
    if (/\.wasm|\.mjs|ort-|onnxruntime/i.test(u)) reqs.set(m.params.requestId, { url: u, status: 'pending' });
  }
  if (m.method === 'Network.responseReceived' && reqs.has(m.params.requestId)) {
    const r = reqs.get(m.params.requestId);
    r.status = m.params.response.status;
    r.type = m.params.response.headers['content-type'];
  }
  if (m.method === 'Network.loadingFailed' && reqs.has(m.params.requestId)) {
    const r = reqs.get(m.params.requestId);
    r.status = 'FAILED: ' + m.params.errorText;
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (/wasm|onnx|backend|ort/i.test(txt)) logs.push(txt);
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
await send('Network.enable');

await send('Page.navigate', { url: BASE });
await sleep(2500);
await send('Runtime.evaluate', {
  expression: `document.querySelector('[data-goto="screen-practice"]').click()`,
});

// 等 Kokoro 下载完（最多 150 秒）
const t0 = Date.now();
while (Date.now() - t0 < 150000) {
  const s = await send('Runtime.evaluate', {
    expression: `document.querySelector('#pm-status')?.textContent || ''`,
    returnByValue: true,
  });
  if (/Whisper|就绪|失败/.test(s.result.value) && Date.now() - t0 > 20000) break;
  await sleep(3000);
}

console.log('=== 与 ORT / wasm 相关的请求 ===');
if (!reqs.size) console.log('(没有捕获到 wasm/mjs 请求)');
for (const r of reqs.values()) {
  console.log(`${String(r.status).padEnd(10)} ${r.url}`);
}

console.log('\n=== 关键控制台日志 ===');
logs.slice(-10).forEach((l) => console.log('  ·', String(l).slice(0, 220)));

ws.close();
chrome.kill();
await sleep(300);
process.exit(0);
