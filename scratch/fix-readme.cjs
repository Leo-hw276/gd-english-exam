/** 修正远程 README 中已过时的「环境变量优先 / 锁定输入框」说明（仅替换该段，保留其余排版） */
(async () => {
  const h = {
    Authorization: 'Bearer ' + process.env.GH_TOKEN,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };
  const api = 'https://api.github.com/repos/Leo-hw276/gd-english-exam/contents/README.md';

  const cur = await (await fetch(api + '?ref=main', { headers: h })).json();
  let md = Buffer.from(cur.content, 'base64').toString('utf8');
  const before = md.length;

  /* --- 1. 配置优先级 --- */
  const oldPriority = `配置优先级（从高到低）：

\`\`\`
真实环境变量（部署平台注入）  >  .env.local  >  .env  >  管理后台设置  >  内置默认值
\`\`\``;
  const newPriority = `配置优先级：

\`\`\`
网站管理后台（数据库，权威来源）  >  内置默认值
\`\`\`

> ✅ **v1 接口地址、API Key、模型选择全部在网站后台的「AI 接口配置」卡片里填写并保存**，
> 保存后立即生效。**不依赖部署平台的环境变量**，换网关/换密钥/换模型都不需要重新部署。
> 环境变量（\`EXAM_API_KEY\` 等）只在新库首次初始化时提供一次默认值，之后不会覆盖后台设置。`;
  if (md.includes(oldPriority)) md = md.replace(oldPriority, newPriority);
  else console.log('⚠️ 未匹配到「配置优先级」旧段（可能已改）');

  /* --- 2. 锁定机制说明 --- */
  const startLock = md.indexOf('### 环境变量锁定机制');
  if (startLock >= 0) {
    const endLock = md.indexOf('---', startLock);
    const newLock = `### 后台可随时修改

管理后台的 v1 地址、API Key、模型输入框**始终可编辑**，保存即写入数据库并立即生效。
若地址漏填 \`/v1\`，保存时会自动补全。

> 💡 部署到 Railway / Render 等平台时**无需**配置 \`EXAM_API_KEY\`、\`EXAM_API_BASE\`、\`EXAM_MODEL\`，
> 首次打开 \`你的域名/#admin\` 登录后填写即可。

`;
    md = md.slice(0, startLock) + newLock + md.slice(endLock);
  } else {
    console.log('⚠️ 未匹配到「环境变量锁定机制」段（可能已改）');
  }

  /* --- 3. ADMIN_PASSWORD 行说明 --- */
  md = md.replace(
    '| `ADMIN_PASSWORD` | | — | 管理员密码；设置后后台不可再修改 |',
    '| `ADMIN_PASSWORD` | | — | 管理员密码；只用于首次初始化，之后可在后台修改 |'
  );

  if (md.length === before) {
    console.log('内容无变化，未提交');
    return;
  }

  const put = await fetch(api, {
    method: 'PUT',
    headers: h,
    body: JSON.stringify({
      message: 'docs: 配置改为网站后台唯一入口（v1地址/密钥/模型不再依赖平台环境变量）',
      content: Buffer.from(md, 'utf8').toString('base64'),
      sha: cur.sha,
      branch: 'main',
    }),
  });
  const j = await put.json();
  console.log('README 更新:', put.status, j.commit?.sha?.slice(0, 8) || JSON.stringify(j).slice(0, 140));
  console.log('字符数:', before, '→', md.length);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
