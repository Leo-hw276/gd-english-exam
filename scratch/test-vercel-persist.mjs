/** 测试 Vercel 部署站：后端版本 + 写入是否持久化 */
const BASE = process.env.SITE || 'https://gd-english-exam-five.vercel.app';
const PW = process.env.ADMIN_PASSWORD || 'Leo456le';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (p, body, method = 'POST', token, tries = 4) => {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(45000),
      });
      return { status: r.status, json: await r.json().catch(() => null) };
    } catch (e) {
      lastErr = e;
      console.log(`   (第 ${i + 1} 次请求失败，重试…) ${String(e.cause?.code || e.message).slice(0, 40)}`);
      await sleep(2500);
    }
  }
  throw lastErr;
};

const login = async () => (await api('/api/admin/login', { account: 'admin', password: PW })).json?.token;

const tok = await login();
console.log('登录:', tok ? '成功' : '失败');

/* --- 1. 后端版本判定：新版才有「导出用户」动作 --- */
const ex = await api('/api/admin/users', { action: 'export' }, 'POST', tok);
console.log('\n=== 后端版本 ===');
console.log('导出用户接口:', ex.status, ex.json?.ok ? '→ 新版后端 ✅' : '→ 旧版后端 ❌', ex.json?.users ? `(${ex.json.users.length} 个用户)` : '');

/* --- 2. 写入持久化：建一个测试兑换码，看会不会消失 --- */
console.log('\n=== 写入持久化测试（兑换码）===');
const marker = 'PERSIST' + Date.now().toString().slice(-6);
const made = await api('/api/admin/codes', { action: 'create', type: 'credits', value: 1, count: 1, prefix: marker, note: 'persist-test' }, 'POST', tok);
const newCode = (made.json?.codes || []).find((c) => String(c.code || '').startsWith(marker));
console.log('创建兑换码:', made.status, newCode ? newCode.code : JSON.stringify(made.json).slice(0, 100));

await sleep(2000);
const list1 = await api('/api/admin/codes', undefined, 'GET', tok);
const inList1 = (list1.json?.codes || []).some((c) => String(c.code || '').startsWith(marker));
console.log('2 秒后还能查到:', inList1 ? '是 ✅' : '否 ❌');

await sleep(20000);
const tok2 = await login(); // 新会话，可能命中新实例
const list2 = await api('/api/admin/codes', undefined, 'GET', tok2);
const inList2 = (list2.json?.codes || []).some((c) => String(c.code || '').startsWith(marker));
console.log('22 秒后（重新登录）还能查到:', inList2 ? '是 ✅ 写入持久化正常' : '否 ❌ 写入已丢失（Vercel 文件系统不可持久化）');

/* --- 3. 清理 --- */
if (inList2) {
  const del = await api('/api/admin/codes', { action: 'disable', code: newCode?.code }, 'POST', tok2);
  console.log('\n清理测试码:', del.status === 200 ? '已停用' : '未清理(可忽略)');
}
