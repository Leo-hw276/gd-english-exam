/**
 * 新功能验证：管理员固定密码、单句精练评分、定价配图上传、连通性测试
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8777';
let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  ok ? pass++ : fail++;
  console.log(`${String(ok ? 'PASS' : 'FAIL').padEnd(5)} ${label}${extra ? '  →  ' + extra : ''}`);
};

const j = async (p, body, method = 'POST', headers = {}) => {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json, text };
};

console.log('=== 1. 管理员登录（固定账号/密码）===');
const badAcct = await j('/api/admin/login', { account: 'nobody', password: 'Leo456le' });
check('错误账号被拒', badAcct.status === 401);
const badPw = await j('/api/admin/login', { account: 'admin', password: 'wrongpass' });
check('错误密码被拒', badPw.status === 401);
const ok = await j('/api/admin/login', { account: 'admin', password: 'Leo456le' });
check('admin / Leo456le 登录成功', ok.status === 200 && ok.json?.ok === true);
const AH = { Authorization: 'Bearer ' + (ok.json?.token || '') };

console.log('\n=== 2. 页面不得出现密码明文 ===');
const html = (await fetch(BASE + '/')).text();
const page = await html;
check('首页不含 Leo456le', !page.includes('Leo456le'));
check('首页不含 jmkt-admin', !page.includes('jmkt-admin'));
const appjs = await (await fetch(BASE + '/js/app.js')).text();
const adminjs = await (await fetch(BASE + '/js/admin.js')).text();
check('app.js 不含密码', !appjs.includes('Leo456le'));
check('admin.js 不含密码', !adminjs.includes('Leo456le'));

console.log('\n=== 3. 连通性测试（带当前输入框参数）===');
const ct = await j('/api/admin/test', { apiBase: 'https://api.hcnsec.cn/v1', apiKey: process.env.EXAM_API_KEY }, 'POST', AH);
check('测试返回结构化步骤', ct.status === 200 && Array.isArray(ct.json?.steps), JSON.stringify(ct.json?.steps?.map((s) => `${s.step}:${s.ok}`)));
if (ct.json?.ok) {
  check('models + chat 两步都通过', ct.json.steps.every((s) => s.ok), `${ct.json.ms}ms · ${ct.json.modelCount} 个模型`);
} else {
  check('失败时给出定位与建议', Boolean(ct.json?.stage && ct.json?.hint), `${ct.json?.stage} · ${ct.json?.hint?.slice(0, 40)}`);
}

console.log('\n=== 4. 定价说明配图上传 ===');
// 1x1 红色 PNG
const pngB64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const up = await j('/api/admin/upload', { dataUrl: 'data:image/png;base64,' + pngB64 }, 'POST', AH);
check('上传成功并返回 URL', up.status === 200 && String(up.json?.url || '').startsWith('/uploads/'), up.json?.url);
if (up.json?.url) {
  const img = await fetch(BASE + up.json.url);
  check('图片可正常访问', img.status === 200 && (img.headers.get('content-type') || '').includes('png'));
  const badType = await j('/api/admin/upload', { dataUrl: 'data:text/plain;base64,aGk=' }, 'POST', AH);
  check('非图片类型被拒', badType.status === 400);
  // 保存到定价
  const saved = await j('/api/admin/settings', { pricing: { ...(await j('/api/admin/overview', undefined, 'GET', AH)).json.settings.pricing, sourceImage: up.json.url } }, 'POST', AH);
  check('配图写入定价设置', saved.status === 200);
  const health = await j('/api/health', undefined, 'GET');
  check('前台 health 能读到配图', health.json?.pricing?.sourceImage === up.json.url, health.json?.pricing?.sourceImage);
}

console.log('\n=== 5. 单句精练评分 ===');
const email = `pg${Date.now()}@test.com`;
const reg = await j('/api/auth/register', { email, password: 'pg123456', name: '精练用户' });
check('注册成功', reg.status === 200 && Boolean(reg.json?.token));
const UH = { Authorization: 'Bearer ' + (reg.json?.token || '') };

const noAuth = await fetch(BASE + '/api/practice/score', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sentence: 'Hello world', transcript: 'Hello world' }),
});
check('未登录被拒（401）', noAuth.status === 401);

const pr = await j(
  '/api/practice/score',
  {
    sentence: 'Could you please tell me how to get to the nearest supermarket?',
    transcript: 'Could you please tell me how to get to the near supermarket',
    topic: '问路指路',
  },
  'POST',
  UH
);
check('评分返回 200', pr.status === 200);
check('返回 success 字段', typeof pr.json?.success === 'boolean', `success=${pr.json?.success}`);
if (pr.json?.success) {
  check('分数在 0-10 之间', pr.json.score >= 0 && pr.json.score <= 10, pr.json.score);
  check('有错误标记数组', Array.isArray(pr.json.errors), `${pr.json.errors?.length} 个`);
  check('有评语', Boolean(pr.json.feedback), String(pr.json.feedback || '').slice(0, 40));
  check('回显原文与识别文本', Boolean(pr.json.reference && pr.json.transcript));
} else {
  check('失败时带 error 说明', Boolean(pr.json?.error), String(pr.json?.error || '').slice(0, 60));
}

console.log('\n=== 6. 单句精练不消耗考试额度 ===');
const me1 = await j('/api/auth/me', undefined, 'GET', UH);
check('额度未被扣减', me1.json?.user?.freeLeft === 2, `免费剩 ${me1.json?.user?.freeLeft}`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
