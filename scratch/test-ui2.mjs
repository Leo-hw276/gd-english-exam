/** 验证：管理页模式、返回首页、已登录点新人福利不跳登录页、倍速控件 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SITE = process.env.SITE || 'http://127.0.0.1:8777';
const CHROME = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9381;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (l, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? '  →  ' + e : ''}`); };

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.resolve('.chrome-profile-t2')}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch {} await sleep(300); }
const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
let msgId = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m.result); } });
const send = (m, p = {}) => new Promise((res) => { const i = ++msgId; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) console.log('  JS异常:', r.exceptionDetails.text);
  return r?.result?.value;
};
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Runtime.enable'); await send('Page.enable');
const errs = [];
await send('Log.enable').catch(() => {});
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push(String(m.params.args?.[0]?.value || '').slice(0, 120));
});

await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: SITE + '/' });
await sleep(3500);

/* 1. 倍速控件 */
const sp = await ev(`(()=>{const s=document.querySelector('#inp-speed');return s?{v:s.value,n:s.options.length}:null})()`);
ok('答题倍速控件存在', Boolean(sp?.n >= 4), JSON.stringify(sp));

/* 2. 朗读页不再显示词数/语速提示 */
const noHint = await ev(`!document.body.innerHTML.includes('建议语速')`);
ok('已移除「建议语速」小字', noHint);

/* 3. 注册并登录 */
const cap = await ev(`(async()=>{
  document.querySelector('#btn-auth-open')?.click();
  await new Promise(r=>setTimeout(r,1500));
  document.querySelector('#auth-tabs .tab[data-tab="register"]')?.click();
  await new Promise(r=>setTimeout(r,1500));
  const img=document.querySelector('#rg-captcha-img');
  const html=String(img?.innerHTML||'');
  const glyphs=[...html.matchAll(/<text[^>]*>([^<]+)<\\/text>/g)].map(m=>m[1]);
  return { glyphs: glyphs.join(''), hasImg: html.includes('svg') };
})()`);
ok('注册页验证码已加载', Boolean(cap?.hasImg), `字符=${cap?.glyphs}`);

const email = `ui_test_${Date.now()}@example.com`;
const reg = await ev(`(async()=>{
  const email=${JSON.stringify(email)};
  document.querySelector('#rg-email').value=email;
  document.querySelector('#rg-pass').value='test123456';
  document.querySelector('#rg-captcha').value=${JSON.stringify(cap?.glyphs || '')};
  document.querySelector('#btn-register')?.click();
  await new Promise(r=>setTimeout(r,2500));
  return { userChip: !document.querySelector('#user-chip')?.classList.contains('hidden'),
           authOpenHidden: document.querySelector('#btn-auth-open')?.classList.contains('hidden'),
           screen: [...document.querySelectorAll('.screen')].filter(s=>s.classList.contains('active')).map(s=>s.id)[0] };
})()`);
ok('注册成功并进入登录态', Boolean(reg?.userChip), JSON.stringify(reg));

/* 4. 已登录时点「新人福利」按钮不应跳到登录页 */
const gift = await ev(`(async()=>{
  window.scrollTo(0,0);
  document.querySelector('[data-goto="screen-intro"]')?.click();
  await new Promise(r=>setTimeout(r,300));
  document.querySelector('[data-goto="screen-pricing"]')?.click();
  await new Promise(r=>setTimeout(r,800));
  const btn=[...document.querySelectorAll('#price-grid button')].find(b=>/进入我的账户|注册领取/.test(b.textContent));
  const label=btn?.textContent?.trim();
  btn?.click();
  await new Promise(r=>setTimeout(r,800));
  const active=[...document.querySelectorAll('.screen')].filter(s=>s.classList.contains('active')).map(s=>s.id)[0];
  return { label, active };
})()`);
ok('已登录时福利卡按钮改为「进入我的账户」', gift?.label === '进入我的账户', String(gift?.label));
ok('点击后不跳登录页', gift?.active !== 'screen-auth', `当前=${gift?.active}`);

/* 5. 管理页：隐藏考生导航、显示返回首页 */
const adm = await ev(`(async()=>{
  location.hash='#admin';
  await new Promise(r=>setTimeout(r,1500));
  const back=document.querySelector('#btn-admin-back');
  const nav=document.querySelector('.topnav');
  const login=document.querySelector('#btn-auth-open');
  const cs=(el)=>el?getComputedStyle(el).display:'none';
  return { active:[...document.querySelectorAll('.screen')].filter(s=>s.classList.contains('active')).map(s=>s.id)[0],
           adminMode:document.body.classList.contains('admin-mode'),
           backDisplay:cs(back), navDisplay:cs(nav), loginDisplay:cs(login),
           headText: document.querySelector('.admin-head')?.textContent?.trim() || '' };
})()`);
ok('进入管理页', adm?.active === 'screen-admin', adm?.active);
ok('body 进入 admin-mode', Boolean(adm?.adminMode));
ok('管理页显示「返回首页」', adm?.backDisplay !== 'none', adm?.backDisplay);
ok('管理页隐藏考生导航', adm?.navDisplay === 'none', adm?.navDisplay);
ok('管理页隐藏「登录/注册」按钮', adm?.loginDisplay === 'none', adm?.loginDisplay);

const back = await ev(`(async()=>{
  document.querySelector('#btn-admin-back')?.click();
  await new Promise(r=>setTimeout(r,600));
  return [...document.querySelectorAll('.screen')].filter(s=>s.classList.contains('active')).map(s=>s.id)[0];
})()`);
ok('「返回首页」回到用户端首页', back === 'screen-intro', back);
ok('回到首页后恢复考生导航', (await ev(`getComputedStyle(document.querySelector('.topnav')).display`)) !== 'none');

console.log('\n控制台错误数:', errs.length, errs.slice(0, 3).join(' | '));
ws.close(); chrome.kill(); await sleep(300);
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
