/** 测试截断 JSON 的修复能力 */
import fs from 'node:fs';
const src = fs.readFileSync('server.mjs', 'utf8');

// 把 extractJson 与 repairTruncatedJson 抠出来单独测试
const start = src.indexOf('function closeBrackets');
const end = src.indexOf('/* --------------------------- 组卷校验');
const code = src.slice(start, end);

class LlmError extends Error {}
const mod = `${code}\nexport { extractJson };`;
fs.writeFileSync('scratch/_json-test-tmp.mjs', `const LlmError = class extends Error {};\n${code}\nexport { extractJson };`, 'utf8');

const { extractJson } = await import('./_json-test-tmp.mjs');

const cases = [
  ['完整 JSON', '{"a":1,"b":[1,2]}'],
  ['带 Markdown 围栏', '```json\n{"a":1}\n```'],
  ['前面有解释文字', '好的，这是结果：{"a":1,"b":"x"} 完毕'],
  ['截断：缺右括号', '{"a":1,"b":{"c":2}'],
  ['截断：字符串中间', '{"a":1,"overall":"这位考生朗读'],
  ['截断：数组中间', '{"items":[{"score":1.5},{"score":2.0},"items2":'],
  ['截断：深层嵌套', '{"readAloud":{"score":4.2,"dimensions":{"pronunciation":{"score":2.0}'],
  ['尾逗号', '{"a":1,"b":[1,2,],}'],
];

let pass = 0, fail = 0;
for (const [name, input] of cases) {
  try {
    const out = extractJson(input);
    console.log(`PASS  ${name}  →  ${JSON.stringify(out).slice(0, 80)}`);
    pass++;
  } catch (e) {
    console.log(`FAIL  ${name}  →  ${e.message}`);
    fail++;
  }
}
fs.unlinkSync('scratch/_json-test-tmp.mjs');
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
