/** 验证评分：转写为空但确实完整朗读时，不应给 0-1 分 */
const BASE = process.env.SITE || 'http://127.0.0.1:8777';
const j = async (u, opt) => {
  const r = await fetch(BASE + u, opt);
  const t = await r.text();
  let d = null;
  try { d = JSON.parse(t); } catch { d = { raw: t.slice(0, 300) }; }
  return { status: r.status, d };
};

async function captcha() {
  const { d } = await j('/api/captcha');
  const glyphs = [...String(d.svg || '').matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map((m) => m[1]);
  return { id: d.id, code: glyphs.join('') };
}

const email = `score_test_${Date.now()}@example.com`;
const c1 = await captcha();
const reg = await j('/api/auth/register', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: 'test123456', captchaId: c1.id, captchaCode: c1.code }),
});
if (reg.status !== 200) { console.log('注册失败', reg.status, JSON.stringify(reg.d).slice(0, 300)); process.exit(1); }
const token = reg.d.token;
console.log('注册成功:', email);

const paper = await j('/api/paper', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ topic: '', difficulty: '标准', offline: true }),
});
if (paper.status !== 200) { console.log('组卷失败', paper.status, JSON.stringify(paper.d).slice(0, 300)); process.exit(1); }
const P = paper.d.paper;
const words = String(P.readAloud.passage || '').trim().split(/\s+/).filter(Boolean).length;
const expectSec = Math.round((words / 130) * 60);
console.log(`试卷来源=${P.source} 朗读短文 ${words} 词，正常读完约 ${expectSec} 秒`);

const metrics = {
  durationMs: 58000,
  speechMs: 52000,
  voicedRatio: 0.9,
  pauseCount: 4,
  longestPauseMs: 900,
  meanPauseMs: 450,
  meanRms: 0.05,
  peakRms: 0.18,
};
const answers = {
  readAloud: { transcript: '', metrics },
  chooseInfo: P.chooseInfo.map((s) => s.questions.map(() => ({ transcript: '', metrics }))),
  answerQuestions: P.answerQuestions.questions.map(() => ({ transcript: '', metrics })),
  retell: { transcript: '', metrics },
  askQuestions: P.askQuestions.map(() => ({ transcript: '', metrics })),
};

const sc = await j('/api/score', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ paper: P, answers }),
});
console.log('\n评分 HTTP', sc.status);
if (sc.status !== 200) { console.log(JSON.stringify(sc.d).slice(0, 800)); process.exit(1); }

const r = sc.d;
console.log('返回字段:', Object.keys(r).join(', '));
console.log('总分:', r.total, '/', r.maxTotal, ' 评分模式:', r.scoringMode);
console.log('breakdown:', JSON.stringify(r.breakdown));
console.log('warnings:', JSON.stringify(r.warnings || []).slice(0, 300));
const ra = r.detail?.readAloud || r.detail?.['模仿朗读'] || null;
if (ra) {
  console.log('朗读得分:', ra.score, '/', ra.max, '  档位:', ra.band);
  console.log('朗读评语:', String(ra.overall || '').slice(0, 160));
} else {
  console.log('detail keys:', Object.keys(r.detail || {}).join(', '));
  console.log('detail 预览:', JSON.stringify(r.detail).slice(0, 500));
}
const raScore = ra?.score ?? r.breakdown?.readAloud ?? 0;
const ok = raScore >= 3;
console.log(ok ? '\n通过：完整朗读（即使无转写）拿到了合理分数' : '\n未通过：分数仍然偏低');
process.exit(ok ? 0 : 1);
