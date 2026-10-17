/**
 * 验证「配置全部来自环境变量 / .env」这条链路：
 *  1. 服务端确实从 env 读到了 Key（db.json 里没有）
 *  2. 管理后台能识别并锁定被 env 指定的项
 *  3. 强行提交被锁定的字段会被拒绝且给出明确提示
 *  4. 未锁定的字段（定价、考区）仍可正常保存
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8777';
const PW = process.env.ADMIN_PASSWORD || 'jmkt-admin-2026';

const j = async (p, body, method = 'POST', headers = {}) => {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, j: await r.json().catch(() => null) };
};

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  →  ' + extra : ''}`);
};

console.log('=== 配置来源验证 ===\n');

const h = await j('/api/health', undefined, 'GET');
check('服务端已读到 API Key', h.j.hasKey === true, h.j.model);
check('接口地址来自配置', Boolean(h.j.apiBase), h.j.apiBase);

const al = await j('/api/admin/login', { password: PW });
check('管理员登录', al.j.ok === true);
const adminH = { Authorization: 'Bearer ' + al.j.token };

const ov = await j('/api/admin/overview', undefined, 'GET', adminH);
const s = ov.j.settings;
console.log('\n  来源明细:', JSON.stringify(s.sources));
console.log('  锁定状态:', JSON.stringify(s.locked));

check('sources.apiKey = env', s.sources?.apiKey === 'env');
check('locked.apiKey = true', s.locked?.apiKey === true);
check('locked.apiBase = true', s.locked?.apiBase === true);
check('locked.model = true', s.locked?.model === true);
check('API Key 只回显掩码', typeof s.apiKeyHint === 'string' && !String(s.apiKeyHint).includes(process.env.EXAM_API_KEY || '@@'));

console.log('\n--- 尝试通过后台篡改被锁定的 Key（应被拒绝）---');
const bad = await j('/api/admin/settings', { apiKey: 'sk-hacked-by-admin', apiBase: 'https://evil.example.com/v1' }, 'POST', adminH);
check('接口返回成功但列出被拒字段', bad.j.ok === true && Array.isArray(bad.j.refused), JSON.stringify(bad.j.refused));
check('EXAM_API_KEY 在拒绝列表里', (bad.j.refused || []).includes('EXAM_API_KEY'));
check('EXAM_API_BASE 在拒绝列表里', (bad.j.refused || []).includes('EXAM_API_BASE'));
check('提示文案说明了原因', String(bad.j.message || '').includes('环境变量'));

const ov2 = await j('/api/admin/overview', undefined, 'GET', adminH);
check('Key 未被篡改（仍是 env 来源）', ov2.j.settings.sources?.apiKey === 'env');

console.log('\n--- 未锁定的字段应能正常保存 ---');
const good = await j('/api/admin/settings', { pricing: { ...ov2.j.settings.pricing, freeTrials: 3 } }, 'POST', adminH);
check('定价修改成功', good.j.ok === true && good.j.settings.pricing.freeTrials === 3, '免费次数 = ' + good.j.settings.pricing.freeTrials);
// 还原
await j('/api/admin/settings', { pricing: { ...ov2.j.settings.pricing, freeTrials: 2 } }, 'POST', adminH);

console.log('\n--- 管理员密码被 env 指定时应拒绝后台修改 ---');
const pwTry = await j('/api/admin/settings', { newPassword: 'somethingelse123' }, 'POST', adminH);
check(
  '后台改密码被拒绝并提示 env',
  pwTry.status === 400 && String(pwTry.j.error || '').includes('ADMIN_PASSWORD'),
  pwTry.j.error
);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
