/**
 * 在页面上下文里直接探测：模型站与 wasm 站能否 fetch（含 CORS）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CHROME =
  fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:8777';
const PORT = 9337;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.resolve('.chrome-profile5')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
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
const netFails = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    return;
  }
  if (m.method === 'Network.loadingFailed') netFails.push(`${m.params.type} ${m.params.errorText} ${m.params.blockedReason || ''}`);
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

const probe = async (url, label) => {
  const expr = `(async () => {
    const t0 = Date.now();
    try {
      const r = await fetch(${JSON.stringify(url)}, { mode: 'cors', signal: AbortSignal.timeout(25000) });
      const len = (await r.text()).length;
      return JSON.stringify({ ok: r.ok, status: r.status, len, ms: Date.now() - t0 });
    } catch (e) {
      return JSON.stringify({ ok: false, err: e.message, ms: Date.now() - t0 });
    }
  })()`;
  const out = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  console.log(String(label).padEnd(26), out.result.value);
};

console.log('=== 页面内 fetch 探测 ===');
await probe('https://hf-mirror.com/onnx-community/whisper-tiny.en/resolve/main/config.json', 'hf-mirror config.json');
await probe(
  'https://huggingface.co/onnx-community/whisper-tiny.en/resolve/main/config.json',
  'huggingface config.json'
);
await probe(
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.2/dist/ort-wasm-simd-threaded.jsep.wasm',
  'wasm (jsep, 22MB HEAD-ish)'
);
await probe('/vendor/transformers.min.js', '本地 vendor');

console.log('\n=== 网络失败事件 ===');
if (!netFails.length) console.log('(无)');
netFails.slice(0, 15).forEach((f) => console.log('  ·', f));

ws.close();
chrome.kill();
await sleep(300);
process.exit(0);
