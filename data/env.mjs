/**
 * 极简 .env 加载器（零依赖）
 *
 * 为什么需要它：
 *   Node 原生的 `--env-file` 要 Node 20.6+，而且需要改启动命令。
 *   这里自己实现一份，`node server.mjs` 就能直接读到项目根目录的 .env，
 *   部署到 Railway / Render 等平台时则使用平台注入的真实环境变量。
 *
 * 优先级：真实环境变量 > .env.local > .env
 *   —— 平台注入的变量永远不会被仓库里的文件覆盖。
 *
 * 安全约定：.env 已在 .gitignore 中，绝不会被提交。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['.env.local', '.env'];

function parse(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val.replace(/\\n/g, '\n');
  }
  return out;
}

/** 本次真正从文件里读进来的变量名 */
export const envFromFile = [];
/** 实际读取到的 .env 文件 */
export const envFilesUsed = [];

for (const f of FILES) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  try {
    const vars = parse(fs.readFileSync(p, 'utf8'));
    let used = false;
    for (const [k, v] of Object.entries(vars)) {
      if (process.env[k] === undefined) {
        process.env[k] = v;
        envFromFile.push(k);
        used = true;
      }
    }
    envFilesUsed.push(f + (used ? '' : '（未覆盖任何变量）'));
  } catch (e) {
    console.error(`[env] 读取 ${f} 失败：${e.message}`);
  }
}

/**
 * 判断某项配置来自哪里：'env'（环境变量） / 'db'（后台设置） / 'none'
 * 用于在管理后台明确告诉管理员「当前 Key 是环境变量锁定的，后台改不了」。
 */
export function configSources(settings) {
  const s = settings || {};
  return {
    apiKey: process.env.EXAM_API_KEY ? 'env' : s.apiKey ? 'db' : 'none',
    apiBase: process.env.EXAM_API_BASE ? 'env' : s.apiBase ? 'db' : 'none',
    model: process.env.EXAM_MODEL ? 'env' : s.model ? 'db' : 'none',
    adminPassword: process.env.ADMIN_PASSWORD
      ? 'env'
      : s.adminPasswordHash
      ? 'db'
      : 'none',
    dbFile: process.env.EXAM_DB_FILE ? 'env' : 'default',
  };
}

/** 哪些配置被环境变量锁定（后台不可改） */
export function envLocked(settings) {
  const src = configSources(settings);
  return {
    apiKey: src.apiKey === 'env',
    apiBase: src.apiBase === 'env',
    model: src.model === 'env',
  };
}
