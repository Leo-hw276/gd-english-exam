/** 核对 GitHub 远程代码：v1 地址输入框是否存在、是否会被锁定 */
(async () => {
  const h = { Authorization: 'Bearer ' + process.env.GH_TOKEN, Accept: 'application/vnd.github.raw+json' };
  const base = 'https://api.github.com/repos/Leo-hw276/gd-english-exam/contents';

  const html = await (await fetch(base + '/public/index.html?ref=main', { headers: h })).text();
  const adminJs = await (await fetch(base + '/public/js/admin.js?ref=main', { headers: h })).text();
  const server = await (await fetch(base + '/server.mjs?ref=main', { headers: h })).text();

  const grab = (re) => (html.match(re) || [])[1] || '(未找到)';

  console.log('=== GitHub main 分支上的后台表单 ===');
  console.log('1. v1 地址输入框 :', /id="ad-base"/.test(html) ? '存在 ✅' : '缺失 ❌');
  console.log('   实际代码      :', grab(/<input type="text" id="ad-base"[^>]*>/));
  console.log('2. 地址标签      :', grab(/<label class="muted">(v1[^<]*)<\/label>/));
  console.log('3. API Key 输入框:', /id="ad-key"/.test(html) ? '存在 ✅' : '缺失 ❌');
  console.log('4. 模型输入框    :', /id="ad-model"/.test(html) ? '存在 ✅（可输入+datalist）' : '缺失 ❌');
  console.log('5. 登录页提示    :', /AI 接口配置/.test(html.slice(html.indexOf('admin-login-card'), html.indexOf('admin-login-card') + 900)) ? '有 ✅' : '无 ❌');

  console.log('\n=== 会不会被锁成灰色（旧版的坑）===');
  console.log('admin.js 里 disabled 锁定逻辑:', /el\.disabled = true/.test(adminJs) ? '仍存在 ❌（会被锁）' : '已移除 ✅（永远可编辑）');
  console.log('admin.js 里 locked 变量      :', /const locked = /.test(adminJs) ? '仍存在' : '已移除 ✅');
  console.log('server.mjs 里 env 覆盖 DB    :', /EXAM_API_KEY\) db\.settings\.apiKey/.test(server) ? '仍存在 ❌' : '已移除 ✅');
  console.log('server.mjs 里自动补 /v1      :', /\/v\\d\+\$\/\.test/.test(server) || /apiBase \+= '\/v1'/.test(server) ? '有 ✅' : '无');

  const c = await (await fetch('https://api.github.com/repos/Leo-hw276/gd-english-exam/commits?per_page=1', { headers: h })).json();
  console.log('\nGitHub main 最新提交:', c[0]?.sha?.slice(0, 8), '|', c[0]?.commit?.message?.split('\n')[0]?.slice(0, 46));
  console.log('提交时间:', c[0]?.commit?.committer?.date);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
