/** 推送后验证：远程 README / index.html / store.mjs 内容正确 */
const fs = require('node:fs');
(async () => {
  const h = {
    Authorization: 'Bearer ' + process.env.GH_TOKEN,
    Accept: 'application/vnd.github.raw+json',
  };
  const base = 'https://api.github.com/repos/Leo-hw276/gd-english-exam/contents';

  const rd = await (await fetch(base + '/README.md?ref=main', { headers: h })).text();
  console.log('README:', rd.length, '字符 | 你的排版保留:', rd.includes('<div align="center">'));

  const html = await (await fetch(base + '/public/index.html?ref=main', { headers: h })).text();
  console.log('index.html 无单句精练/无practice.js:', !html.includes('单句精练') && !html.includes('practice.js'));
  const nav = (html.match(/<nav class=.topnav.>([\s\S]*?)<\/nav>/) || [])[1] || '';
  const items = [...nav.matchAll(/data-goto="([a-z-]+)">([^<]+)</g)].map((m) => m[2]);
  console.log('导航顺序:', items.join(' | '));

  const store = await (await fetch(base + '/data/store.mjs?ref=main', { headers: h })).text();
  console.log('store.mjs 含导出/导入/清空:', ['exportUsers', 'importUsers', 'clearData'].every((f) => store.includes(f)));

  const vendor = await (await fetch(base + '/contents/public/vendor?ref=main', { headers: h })).json().catch(() => null);
  console.log('vendor 目录残留:', Array.isArray(vendor) ? vendor.map((v) => v.name).join(', ') || '(空目录无文件)' : '(目录不存在,已清理)');

  fs.writeFileSync('scratch/README.remote-check.md', rd.slice(0, 200));
})().catch((e) => {
  console.error('验证失败:', e.message);
  process.exit(1);
});
