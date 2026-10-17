const BASE = 'http://127.0.0.1:8777';

const health = await (await fetch(`${BASE}/api/health`)).json();
console.log('HEALTH:', JSON.stringify(health));

console.log('\n--- generating paper (this calls DeepSeek-V4-Flash) ---');
const t0 = Date.now();
const res = await fetch(`${BASE}/api/paper`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ topic: '', difficulty: '标准' }),
});
const data = await res.json();
console.log('elapsed', ((Date.now() - t0) / 1000).toFixed(1) + 's');
if (!data.ok) {
  console.log('FAILED', JSON.stringify(data).slice(0, 600));
  process.exit(1);
}
const p = data.paper;
console.log('warning:', data.warning || '(none)');
console.log('topic:', p.topic, '| source:', p.source);
console.log('readAloud words:', p.readAloud.passage.trim().split(/\s+/).length);
console.log('readAloud:', p.readAloud.passage);
console.log('chooseInfo segments:', p.chooseInfo.length);
p.chooseInfo.forEach((s, i) => {
  console.log(`  seg${i + 1}: lines=${s.script.length} questions=${s.questions.length}`);
  s.questions.forEach((q) =>
    console.log(`     ${q.q} | ${q.options.join(' / ')} | ans=${q.options[q.answerIndex]}`)
  );
});
console.log('answerQuestions q:', p.answerQuestions.questions.length, 'script words:', p.answerQuestions.script.split(/\s+/).length);
p.answerQuestions.questions.forEach((q) => console.log('   ', q.q, '=>', q.answer));
console.log('retell outline points:', p.retell.outline.length, '| script words:', p.retell.script.split(/\s+/).length);
console.log('askQuestions:', p.askQuestions.length);
p.askQuestions.forEach((a) => console.log('   ', a.cn, '=>', a.reference));

// 总分核算
const total = 6 + p.chooseInfo.reduce((n, s) => n + s.questions.length, 0) * 1.5 +
  p.answerQuestions.questions.length * 1.5 + 6 + p.askQuestions.length * 1.5;
console.log('\nSCORE TOTAL CHECK:', total, total === 30 ? 'OK' : 'MISMATCH');

import fs from 'node:fs';
fs.writeFileSync('D:/DeepSeek Harness/gd-english/scratch/last-paper.json', JSON.stringify(p, null, 2));
console.log('saved to scratch/last-paper.json');
