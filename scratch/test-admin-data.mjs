/**
 * 验证：管理员数据导出 / 导入 / 一键清空
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8777';
let pass = 0;
let fail = 0;
const check = (l, ok, extra = '') => {
  ok ? pass++ : fail++;
  console.log(`${String(ok ? 'PASS' : 'FAIL').padEnd(5)} ${l}${extra ? '  →  ' + extra : ''}`);
};
const j = async (p, body, method = 'POST', headers = {}) => {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

const al = await j('/api/admin/login', { account: 'admin', password: 'Leo456le' });
check('管理员登录', al.status === 200);
const AH = { Authorization: 'Bearer ' + al.json.token };

// 造几个用户
const made = [];
for (let i = 0; i < 3; i++) {
  const email = `dump${Date.now()}${i}@test.com`;
  const r = await j('/api/auth/register', { email, password: 'pp123456', name: '备份用户' + i });
  if (r.json?.token) made.push({ email, token: r.json.token });
}
check('创建 3 个测试用户', made.length === 3);

console.log('\n=== 导出 ===');
const ex = await j('/api/admin/users', { action: 'export' }, 'POST', AH);
check('导出成功', ex.status === 200 && Array.isArray(ex.json?.users));
check('导出内容含邮箱与哈希', Boolean(ex.json?.users?.[0]?.email && ex.json?.users?.[0]?.passHash));
console.log('        导出用户数:', ex.json?.users?.length);

const exported = ex.json;

console.log('\n=== 一键清空 ===');
const noConfirm = await j('/api/admin/users', { action: 'clear' }, 'POST', AH);
check('缺少确认词被拒', noConfirm.status === 400);
const cleared = await j('/api/admin/users', { action: 'clear', confirm: 'CLEAR' }, 'POST', AH);
check('清空成功', cleared.status === 200, cleared.json?.message);
const listAfter = await j('/api/admin/users', undefined, 'GET', AH);
check('用户列表已空', (listAfter.json?.users || []).length === 0);

// 原用户的会话也应该失效
const ghost = await fetch(BASE + '/api/auth/me', { headers: { Authorization: 'Bearer ' + made[0].token } });
const ghostJson = await ghost.json();
check('清空后旧会话失效', ghostJson.user === null);

console.log('\n=== 导入还原 ===');
const imp = await j('/api/admin/users', { action: 'import', mode: 'merge', data: exported }, 'POST', AH);
check('导入成功', imp.status === 200, imp.json?.message);
check('用户数恢复', (imp.json?.users || []).length >= 3, `${imp.json?.users?.length} 个`);

// 用导出的哈希验证密码仍可用
const loginBack = await j('/api/auth/login', { email: made[0].email, password: 'pp123456' });
check('还原后原密码可登录', loginBack.status === 200 && Boolean(loginBack.json?.token));

console.log('\n=== 合并模式（同邮箱不重复）===');
const again = await j('/api/admin/users', { action: 'import', mode: 'merge', data: exported }, 'POST', AH);
check('重复导入不会产生重复用户', again.status === 200 && again.json.updated > 0 && again.json.added === 0, JSON.stringify({ added: again.json?.added, updated: again.json?.updated }));

console.log('\n=== 顶栏已移除管理后台入口 ===');
const html = await (await fetch(BASE + '/')).text();
check('顶栏不再有「管理后台」链接', !/data-goto="screen-admin"/.test(html.split('</nav>')[0]));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
