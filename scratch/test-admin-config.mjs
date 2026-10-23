/** 验证：v1地址/密钥/模型 全部以网站后台(数据库)为准，环境变量只作初始值不锁定 */
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:8777';
let pass = 0, fail = 0;
const ok = (l, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? '  →  ' + e : ''}`); };
const j = async (p, b, m = 'POST', h = {}) => {
  const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', ...h }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};

const al = await j('/api/admin/login', { account: 'admin', password: process.env.ADMIN_PASSWORD || 'Leo456le' });
ok('管理员登录', al.status === 200);
const AH = { Authorization: 'Bearer ' + al.json.token };

const before = await j('/api/admin/overview', null, 'GET', AH);
const s0 = before.json.settings;
ok('读到当前配置', Boolean(s0?.apiBase), s0?.apiBase);
console.log('        当前来源:', JSON.stringify(s0?.sources));

/* ---- 1. 保存不带 /v1 的地址 → 自动补全 ---- */
const saved = await j('/api/admin/settings', {
  apiBase: 'https://api.hcnsec.cn',      // 故意漏 /v1
  model: 'DeepSeek-V4.1-Flash',
}, 'POST', AH);
ok('保存成功（后台为唯一入口）', saved.status === 200 && saved.json.ok, saved.json?.message);
ok('漏 /v1 自动补全', saved.json?.settings?.apiBase === 'https://api.hcnsec.cn/v1', saved.json?.settings?.apiBase);

/* ---- 2. 来源全部变为 db ---- */
const src = saved.json?.settings?.sources || {};
ok('来源=网站后台保存', src.apiBase === 'db' && src.model === 'db', JSON.stringify(src));

/* ---- 3. 环境变量不再锁定 ---- */
const locked = saved.json?.settings?.locked || {};
ok('环境变量不锁定任何配置项', !locked.apiKey && !locked.apiBase && !locked.model, JSON.stringify(locked));

/* ---- 4. 改一个"离谱"地址保存 → 能读回来（证明 env EXAM_API_BASE 不会覆盖后台值） ---- */
const weird = await j('/api/admin/settings', { apiBase: 'https://backend-from-admin.example.com/v1' }, 'POST', AH);
ok('后台值写入成功', weird.json?.settings?.apiBase === 'https://backend-from-admin.example.com/v1', weird.json?.settings?.apiBase);
const reread = await j('/api/admin/overview', null, 'GET', AH);
ok('重新读取仍是后台值（env 未覆盖）', reread.json.settings.apiBase === 'https://backend-from-admin.example.com/v1', reread.json.settings.apiBase);

/* ---- 5. 数据库里确实落盘（写盘有 120ms 防抖，等一下再读） ---- */
await new Promise((r) => setTimeout(r, 600));
const dbRaw = JSON.parse(fs.readFileSync('data/db.json', 'utf8'));
ok('已持久化到 data/db.json', dbRaw.settings.apiBase === 'https://backend-from-admin.example.com/v1');

/* ---- 6. 恢复真实配置并做连通性测试（表单临时值，未保存也能测） ---- */
const real = await j('/api/admin/settings', { apiBase: 'https://api.hcnsec.cn/v1' }, 'POST', AH);
ok('恢复真实 v1 地址', real.json?.settings?.apiBase === 'https://api.hcnsec.cn/v1');

const key = process.env.EXAM_API_KEY || dbRaw.settings.apiKey;
const t = await j('/api/admin/test', { apiBase: 'https://api.hcnsec.cn/v1', apiKey: key, model: 'DeepSeek-V4.1-Flash' }, 'POST', AH);
const steps = t.json?.steps || [];
for (const st of steps) {
  ok(`连通步骤 ${st.step}`, st.ok === true, `${st.ms}ms` + (st.count ? ` · ${st.count} 个模型` : '') + (st.error ? ' · ' + st.error.slice(0, 60) : ''));
}
ok('连通测试整体通过', t.status === 200 && t.json?.ok === true, `${t.json?.ms}ms · ${t.json?.model}`);

/* ---- 7. 错误 key 的分步报错 ---- */
const bad = await j('/api/admin/test', { apiBase: 'https://api.hcnsec.cn/v1', apiKey: 'sk-invalid-key-000', model: 'DeepSeek-V4.1-Flash' }, 'POST', AH);
const modelsStep = (bad.json?.steps || []).find((x) => x.step === 'models');
ok('错误密钥被识别并给出提示', bad.json?.ok === false && Boolean(modelsStep?.error), (bad.json?.hint || '').slice(0, 50));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
