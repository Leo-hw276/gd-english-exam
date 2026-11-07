 
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

 
export const envFromFile = [];
 
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

 
export function configSources(settings) {
  const s = settings || {};
  const from = (v) => (v ? 'db' : 'none');
  return {
    apiKey: from(s.apiKey),
    apiBase: from(s.apiBase),
    model: from(s.model),
    adminPassword: s.adminPasswordHash ? 'db' : 'none',
    dbFile: process.env.EXAM_DB_FILE ? 'env' : 'default',
  };
}

 
export function envLocked() {
  return { apiKey: false, apiBase: false, model: false };
}
