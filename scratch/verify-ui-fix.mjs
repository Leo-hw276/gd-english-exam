/** 验证：后台 v1 输入框可见（cfg- 新 id）+ 倍速控件存在 + 验证码大小写输入框 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SITE = process.env.SITE || 'http://127.0.0.1:8777';
const CHROME = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9371;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (l, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? '  →  ' + e : ''}`); };

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.resolve('.chrome-profile-check')}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch {} await sleep(300); }
const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
let msgId = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m.result); } });
const send = (m, p = {}) => new Promise((res) => { const i = ++msgId; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }))?.result?.value;
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Runtime.enable'); await send('Page.enable');

/* --- 移动端 393 下的后台 --- */
await send('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: SITE + '/#admin' });
await sleep(2600);
await ev(`const p=document.querySelector('#cfg-pass'); if(p)p.value='Leo456le'; document.querySelector('#btn-admin-login')?.click(); 'ok'`);
for (let i = 0; i < 12; i++) {
  if (await ev(`document.querySelector('#admin-panel')?.style.display !== 'none'`)) break;
  await sleep(1200);
}
await sleep(800);

const info = await ev(`(()=>{
  const g=(sel)=>{const el=document.querySelector(sel); if(!el) return {sel,missing:true};
    const cs=getComputedStyle(el); const r=el.getBoundingClientRect();
    return {sel, w:Math.round(r.width), h:Math.round(r.height), disp:cs.display, vis:cs.visibility, op:cs.opacity,
            bg:cs.backgroundColor, border:cs.borderTopWidth+' '+cs.borderTopColor, value:String(el.value||'').slice(0,30)};};
  return { base:g('#cfg-base'), key:g('#cfg-key'), model:g('#cfg-model'), pass:g('#cfg-pass') };
})()`);

for (const [n, v] of Object.entries(info)) {
  if (v.missing) { ok(`${n} 存在`, false, '元素缺失'); continue; }
  const visible = v.w > 0 && v.h > 0 && v.disp !== 'none' && v.vis === 'visible' && v.op === '1';
  ok(`${n} 可见(${v.w}x${v.h})`, visible, `disp=${v.disp} bg=${v.bg} value="${v.value}"`);
}
ok('v1 地址已有值', Boolean(info.base?.value), info.base?.value);

/* --- 首页自检里的倍速控件 & 验证码输入框 --- */
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: SITE + '/' });
await sleep(3000);
const speed = await ev(`(()=>{const s=document.querySelector('#inp-speed'); return s?{exists:true,value:s.value,opts:s.options.length}:{exists:false};})()`);
ok('答题倍速控件存在', Boolean(speed?.exists), JSON.stringify(speed));

await ev(`document.querySelector('#btn-auth-open')?.click(); 'ok'`);
await sleep(1500);
const cap = await ev(`(()=>{
  const img=document.querySelector('#li-captcha-img');
  const inp=document.querySelector('#li-captcha');
  const id=document.querySelector('#li-captcha-id');
  const svgHasCase = img && /[a-z]/.test(img.textContent||'') && /[A-Z]/.test(img.textContent||'');
  return { imgSvg:(img?.innerHTML||'').includes('<svg'), input:Boolean(inp), id:Boolean(id?.value), upperStyle:inp?getComputedStyle(inp).textTransform:'', svgHasCase };
})()`);
ok('登录页验证码图片已加载', Boolean(cap?.imgSvg));
ok('登录页验证码输入框存在', Boolean(cap?.input));
ok('验证码 id 已下发', Boolean(cap?.id));
ok('输入框不再强制转大写', cap?.upperStyle !== 'uppercase', cap?.upperStyle);

ws.close(); chrome.kill(); await sleep(300);
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
