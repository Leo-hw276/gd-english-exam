/** 删除单句精练后的回归验证：导航顺序、页面可用、API 正常、无残留请求 404 */
const BASE = 'http://127.0.0.1:8777';
let pass = 0, fail = 0;
const ok = (l, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? '  →  ' + e : ''}`); };
const j = async (p, b, m = 'POST', h = {}) => {
  const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', ...h }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};

const html = await (await fetch(BASE + '/')).text();

ok('导航第一位是模拟考试', /<nav class="topnav">\s*<a href="#" data-goto="screen-intro">模拟考试<\/a>/.test(html));
ok('页面无「单句精练」', !html.includes('单句精练'));
ok('无 practice.js 脚本引用', !html.includes('practice.js'));
ok('practice 页面区块已删除', !html.includes('screen-practice'));

const practiceJs = await fetch(BASE + '/js/practice.js');
ok('practice.js 文件已不存在(404)', practiceJs.status === 404, String(practiceJs.status));

const score404 = await j('/api/practice/score', { sentence: 'hello world test', transcript: 'hello world test' });
ok('/api/practice/score 已下线', score404.status === 404, String(score404.status));

const health = await j('/api/health', null, 'GET');
ok('健康检查正常', health.status === 200 && health.json?.ok === true);

const al = await j('/api/admin/login', { account: 'admin', password: process.env.ADMIN_PASSWORD || 'Leo456le' });
ok('管理员登录正常', al.status === 200, String(al.status));
const AH = { Authorization: 'Bearer ' + al.json?.token };
const ov = await j('/api/admin/overview', null, 'GET', AH);
ok('管理后台概览正常', ov.status === 200 && Boolean(ov.json?.stats));

const settings = await j('/api/admin/settings', null, 'GET', AH).catch(() => ({ status: 0, json: null }));
ok('定价设置接口正常', settings.status === 200 || settings.status === 405, String(settings.status));

const css = await (await fetch(BASE + '/styles.css')).text();
ok('CSS 无 pg-/pm- 残留类', !/\.pg-|\.pm-/.test(css));
ok('CSS 保留 transcript-box / btn.primary', css.includes('.transcript-box') && css.includes('.btn.primary'));

const appjs = await (await fetch(BASE + '/js/app.js')).text();
ok('app.js 无 jmkt:screen 残留', !appjs.includes('jmkt:screen'));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
