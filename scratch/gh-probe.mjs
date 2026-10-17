// 探测 fine-grained 令牌到底有哪些权限，以及目标仓库是否已存在
const T = (process.env.GH_TOKEN || '').trim();
if (!T) {
  console.error('缺少 GH_TOKEN');
  process.exit(1);
}

const call = async (p, init = {}) => {
  const r = await fetch('https://api.github.com' + p, {
    ...init,
    headers: {
      Authorization: `Bearer ${T}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'probe',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  let body = null;
  const txt = await r.text();
  try {
    body = JSON.parse(txt);
  } catch {}
  return { status: r.status, body, txt, headers: r.headers };
};

console.log('=== 1. 身份 ===');
const me = await call('/user');
console.log(me.status, me.body?.login, '|', me.body?.name, '| plan:', me.body?.plan?.name);

console.log('\n=== 2. 令牌类型与权限（GitHub 回传的响应头）===');
const rl = await call('/rate_limit');
console.log('x-oauth-scopes       :', rl.headers.get('x-oauth-scopes') || '(空 = fine-grained 令牌)');
console.log('x-accepted-oauth-scopes:', rl.headers.get('x-accepted-oauth-scopes'));
console.log('x-ratelimit-limit    :', rl.headers.get('x-ratelimit-limit'));
console.log('x-github-authentication:', rl.headers.get('x-github-authentication'));

console.log('\n=== 3. 目标仓库是否已存在 ===');
for (const name of ['gd-english-exam', 'gd-english', 'gd-english-listening']) {
  const r = await call(`/repos/${me.body.login}/${name}`);
  console.log(`  ${name.padEnd(22)} -> ${r.status} ${r.status === 200 ? '已存在 ' + r.body.html_url + ' (private=' + r.body.private + ')' : r.body?.message || ''}`);
}

console.log('\n=== 4. 尝试创建仓库，并打印 GitHub 要求的权限 ===');
const c = await call('/user/repos', {
  method: 'POST',
  body: JSON.stringify({ name: 'gd-english-exam', description: 'test', private: false, auto_init: false }),
});
console.log('  HTTP', c.status, c.body?.message || '');
console.log('  x-accepted-github-permissions :', c.headers.get('x-accepted-github-permissions'));
console.log('  x-oauth-scopes                :', c.headers.get('x-oauth-scopes') || '(fine-grained)');
if (c.status === 422) console.log('  (422 表示仓库已存在，可直接推送)');

console.log('\n=== 5. 能否读取已有仓库的内容（验证 Contents 权限）===');
const list = await call('/user/repos?per_page=5&sort=updated');
if (list.status === 200) {
  console.log('  可见仓库数（前5）:', list.body.length);
  list.body.forEach((r) => console.log('   ·', r.full_name, r.private ? '(private)' : '(public)'));
  const first = list.body[0];
  if (first) {
    const p = await call(`/repos/${first.full_name}/contents/`);
    console.log(`  读取 ${first.full_name} 根目录 -> ${p.status} ${p.status === 200 ? '可读（Contents: read 通过）' : p.body?.message}`);
  }
} else {
  console.log('  列出仓库失败:', list.status, list.body?.message);
}
