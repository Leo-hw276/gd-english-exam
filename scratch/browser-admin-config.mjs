/** 管理后台 UI 验证：接口配置卡片可编辑、模型可输入、无锁定提示 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CHROME = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:8777';
const PORT = 9345;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (l, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? '  →  ' + e : ''}`); };

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.resolve('.chrome-profile-admin2')}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch {} await sleep(300); }
const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
let msgId = 0; const pending = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m.result); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++msgId; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.value;
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: BASE + '/#admin' });
await sleep(2500);

// 登录（如果出现登录卡）
const needLogin = await ev(`document.querySelector('#admin-login-card')?.style.display !== 'none'`);
if (needLogin) {
  await ev(`const p=document.querySelector('#ad-pass'); if(p)p.value='Leo456le'; document.querySelector('#btn-admin-login')?.click(); 'ok'`);
  await sleep(2000);
}
await sleep(1500);

const baseVal = await ev(`document.querySelector('#ad-base')?.value`);
ok('v1 地址输入框有值', Boolean(baseVal), baseVal);
const keyPh = await ev(`document.querySelector('#ad-key')?.placeholder`);
ok('Key 输入框显示已配置提示', /已配置/.test(keyPh || ''), keyPh);
const modelTag = await ev(`document.querySelector('#ad-model')?.tagName`);
ok('模型控件可输入(非锁定下拉)', modelTag === 'INPUT', modelTag);
const dlCount = await ev(`document.querySelectorAll('#ad-model-list option').length`);
ok('模型 datalist 有候选项', (dlCount || 0) > 0, String(dlCount));
const editable = await ev(`!document.querySelector('#ad-base').disabled && !document.querySelector('#ad-model').disabled`);
ok('配置输入框未被锁定', Boolean(editable));
const noteGone = await ev(`!document.querySelector('#ad-env-note')`);
ok('环境变量锁定提示已移除', Boolean(noteGone));
const src = await ev(`document.querySelector('#ad-env-source')?.textContent`);
ok('来源提示为网站后台', /网站后台/.test(src || ''), (src || '').slice(0, 60));

// 拉取模型列表（用已保存配置）
await ev(`document.querySelector('#btn-admin-models')?.click(); 'ok'`);
await sleep(6000);
const hint = await ev(`document.querySelector('#ad-model-hint')?.textContent`);
ok('拉取模型列表成功', /拉取成功|个可用模型/.test(hint || ''), hint);

await send('Page.captureScreenshot', {}).then((r) => {
  fs.mkdirSync('scratch/shots', { recursive: true });
  fs.writeFileSync('scratch/shots/admin-config.png', Buffer.from(r.data, 'base64'));
});

ws.close(); chrome.kill(); await sleep(300);
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
