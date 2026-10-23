// 后端接口冒烟测试：健康检查 → 管理员登录 → 设 Key → 拉模型 → 生成兑换码 → 注册 → 兑换 → 组卷
// 直接复用服务端那套 .env 加载器，保证脚本与运行中的应用读同一份配置
import '../data/env.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8777';
// 密钥一律来自环境变量（可写在 .env，已 gitignore），绝不硬编码在代码里
const KEY = process.env.EXAM_API_KEY;
if (!KEY) {
  console.error('缺少 EXAM_API_KEY 环境变量。请在项目根目录建 .env 并写入 EXAM_API_KEY=sk-xxx');
  process.exit(1);
}
const jar = {};
async function call(path, { method = 'GET', body, auth = 'user' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (jar[auth]) headers.Authorization = 'Bearer ' + jar[auth];
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    j = { raw: text.slice(0, 200) };
  }
  return { status: r.status, j };
}

const log = (t, r) => {
  const ok = r.j.ok !== false && r.status < 400;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${t}  [${r.status}]`);
  if (!ok) console.log('      ', JSON.stringify(r.j).slice(0, 300));
  return r.j;
};

console.log('=== 后端接口冒烟测试 ===\n');

const h = log('GET /api/health', await call('/api/health'));
console.log('       考区:', h.defaultCity, '城市数:', Object.keys(h.cities || {}).length, '模型:', h.model);

// 管理员登录（首次设置密码）
const al = log('POST /api/admin/login (首次设密码)', await call('/api/admin/login', { method: 'POST', body: { password: 'jmkt-admin-2026' }, auth: 'admin' }));
jar.admin = al.token;

log('POST /api/admin/settings (配置 Key/模型)', await call('/api/admin/settings', { method: 'POST', body: { apiKey: KEY, model: 'DeepSeek-V4.1-Flash', apiBase: 'https://api.hcnsec.cn/v1' }, auth: 'admin' }));

const models = log('POST /api/admin/models (拉取模型)', await call('/api/admin/models', { method: 'POST', body: {}, auth: 'admin' }));
if (models.models) {
  console.log('       模型数量:', models.count);
  console.log('       示例:', models.models.slice(0, 8).join(', '));
}

log('POST /api/admin/test (连通性)', await call('/api/admin/test', { method: 'POST', body: {}, auth: 'admin' }));

const codes = log('POST /api/admin/codes (生成兑换码)', await call('/api/admin/codes', { method: 'POST', body: { type: 'credits', value: 5, count: 3, note: '测试' }, auth: 'admin' }));
const codeList = codes.created || [];
codeList.forEach((c) => console.log('       →', c.code, c.type, c.value));

const monthly = log('POST /api/admin/codes (月卡)', await call('/api/admin/codes', { method: 'POST', body: { type: 'monthly', value: 30, count: 1 }, auth: 'admin' }));

// 用户注册
const email = `test${Date.now()}@example.com`;
const reg = log('POST /api/auth/register', await call('/api/auth/register', { method: 'POST', body: { email, password: 'test123456', name: '测试同学' } }));
jar.user = reg.token;
console.log('       用户:', JSON.stringify(reg.user));

log('GET /api/auth/me', await call('/api/auth/me'));

// 未登录访问应被拒
const unauth = await fetch(BASE + '/api/paper', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
console.log(`${unauth.status === 401 ? 'PASS' : 'FAIL'}  未登录访问 /api/paper 被拒 [${unauth.status}]`);

// 兑换次卡
const rd = log('POST /api/redeem (次卡)', await call('/api/redeem', { method: 'POST', body: { code: codeList[0].code } }));
console.log('      ', rd.message, '剩余次数:', rd.user?.credits);

// 重复兑换应失败
const rd2 = await call('/api/redeem', { method: 'POST', body: { code: codeList[0].code } });
console.log(`${rd2.status === 400 ? 'PASS' : 'FAIL'}  重复兑换被拒 [${rd2.status}] ${rd2.j.error || ''}`);

// 兑换月卡
const rd3 = log('POST /api/redeem (月卡)', await call('/api/redeem', { method: 'POST', body: { code: monthly.created[0].code } }));
console.log('      ', rd3.message, '会员到期:', new Date(rd3.user?.proUntil).toLocaleDateString());

// 组卷（用内置卷避免耗时）
const paper = log('POST /api/paper (offline 备用卷)', await call('/api/paper', { method: 'POST', body: { offline: true } }));
console.log('       话题:', paper.paper?.topic, '来源:', paper.paper?.source);
if (paper.paper) {
  const fs = await import('node:fs');
  fs.writeFileSync('scratch/smoke-paper.json', JSON.stringify(paper.paper, null, 2), 'utf8');
}

console.log('\n=== 完成 ===');
