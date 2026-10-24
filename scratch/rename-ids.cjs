/** 把后台字段 id 从 ad- 前缀改为 cfg-（规避广告拦截插件的元素隐藏规则） */
const fs = require('fs');

function rename(file, pairs) {
  let s = fs.readFileSync(file, 'utf8');
  let total = 0;
  for (const [a, b] of pairs) {
    const n = s.split(a).length - 1;
    total += n;
    s = s.split(a).join(b);
  }
  fs.writeFileSync(file, s, 'utf8');
  console.log(`${file}: 替换 ${total} 处`);
  return total;
}

rename('public/index.html', [
  ['id="ad-', 'id="cfg-'],
  ['class="ad-img-preview"', 'class="cfg-img-preview"'],
]);
rename('public/js/admin.js', [['#ad-', '#cfg-']]);
rename('public/styles.css', [['.ad-img-preview', '.cfg-img-preview']]);

// 校验
const h = fs.readFileSync('public/index.html', 'utf8');
const j = fs.readFileSync('public/js/admin.js', 'utf8');
console.log('\n--- 校验 ---');
console.log('中文完好（管理后台）:', h.includes('管理后台'));
console.log('无乱码:', !h.includes('绠') && !h.includes('\uFFFD'));
console.log('index 残留 id="ad-:', h.split('id="ad-').length - 1);
console.log('admin.js 残留 #ad-:', j.split('#ad-').length - 1);
console.log('admin.js 中出现 #cfg-base:', j.includes('#cfg-base'));
console.log('index 中出现 id="cfg-base":', h.includes('id="cfg-base"'));
