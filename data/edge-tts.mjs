 

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';

 
const EPOCH_OFFSET = 116444736000000000n;
const FIVE_MIN_NS = 3000000000n; 

function secMsGec() {
  const nowNs = BigInt(Date.now()) * 10000n + EPOCH_OFFSET;
  const rounded = nowNs - (nowNs % FIVE_MIN_NS);
  const raw = rounded.toString() + TRUSTED_TOKEN;
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex').toUpperCase();
}

const WS_BASE =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';

function wsUrl() {
  const gec = secMsGec();
  return (
    `${WS_BASE}?TrustedClientToken=${TRUSTED_TOKEN}` +
    `&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=1-130.0.2849.68`
  );
}

 
export const VOICES = {
  'en-US-AriaNeural': { name: 'Aria', gender: 'Female', locale: 'en-US' },
  'en-US-JennyNeural': { name: 'Jenny', gender: 'Female', locale: 'en-US' },
  'en-US-GuyNeural': { name: 'Guy', gender: 'Male', locale: 'en-US' },
  'en-GB-SoniaNeural': { name: 'Sonia', gender: 'Female', locale: 'en-GB' },
  'en-GB-RyanNeural': { name: 'Ryan', gender: 'Male', locale: 'en-GB' },
  'zh-CN-XiaoxiaoNeural': { name: '晓晓', gender: 'Female', locale: 'zh-CN' },
  'zh-CN-YunxiNeural': { name: '云希', gender: 'Male', locale: 'zh-CN' },
};

const DEFAULT_VOICE = 'en-US-AriaNeural';

 

let CACHE_DIR = '';

export function setCacheDir(dir) {
  CACHE_DIR = dir;
  fs.mkdirSync(dir, { recursive: true });
}

function cacheKey(text, voice, rate) {
  return crypto
    .createHash('sha256')
    .update(`${voice}|${rate}|${text}`, 'utf8')
    .digest('hex');
}

function cachePath(key) {
  return CACHE_DIR ? path.join(CACHE_DIR, key.slice(0, 2), `${key}.mp3`) : '';
}

function cacheGet(key) {
  const p = cachePath(key);
  if (!p) return null;
  try {
    if (fs.existsSync(p)) return fs.readFileSync(p);
  } catch {}
  return null;
}

function cachePut(key, buf) {
  const p = cachePath(key);
  if (!p || !buf?.length) return;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
  } catch {}
}

 

const REQ_ID = () => crypto.randomBytes(16).toString('hex');

 
export async function synthesize(text, {
  voice = DEFAULT_VOICE,
  rate = '+0%',
  pitch = '+0Hz',
  volume = '+0%',
  timeoutMs = 30000,
} = {}) {
  if (!text || !text.trim()) throw new Error('文本不能为空');

  
  const ck = cacheKey(text, voice, rate);
  const cached = cacheGet(ck);
  if (cached) return cached;

  const reqId = REQ_ID();
  const url = wsUrl();

  return new Promise((resolve, reject) => {
    let ws;
    let settled = false;
    const chunks = [];
    let timer = null;

    const done = (err, buf) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch {}
      if (err) reject(err);
      else resolve(buf);
    };

    timer = setTimeout(() => done(new Error('edge-tts 合成超时')), timeoutMs);

    try {
      ws = new WebSocket(url);
    } catch (e) {
      return done(new Error('WebSocket 创建失败：' + e.message));
    }

    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      
      const configMsg =
        `X-Timestamp:${new Date().toISOString()}\r\n` +
        'Content-Type:application/json; charset=utf-8\r\n' +
        `Path:speech.config\r\n\r\n` +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
                outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
              },
            },
          },
        });
      ws.send(configMsg);

      
      const escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
        `<voice name='${voice}'>` +
        `<prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>` +
        escaped +
        `</prosody></voice></speak>`;

      const ssmlMsg =
        `X-RequestId:${reqId}\r\n` +
        `Content-Type:application/ssml+xml\r\n` +
        `X-Timestamp:${new Date().toISOString()}\r\n` +
        `Path:ssml\r\n\r\n` + ssml;
      ws.send(ssmlMsg);
    });

    ws.addEventListener('message', (ev) => {
      const data = ev.data;
      if (typeof data === 'string') {
        
        if (data.includes('Path:turn.end')) {
          const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
          if (buf.length > 0) {
            cachePut(ck, buf);
            done(null, buf);
          } else {
            done(new Error('edge-tts 返回了空音频'));
          }
        }
      } else if (data instanceof ArrayBuffer) {
        
        const view = new DataView(data);
        const headerLen = view.getUint16(0);
        if (data.byteLength > headerLen + 2) {
          chunks.push(data.slice(headerLen + 2));
        }
      }
    });

    ws.addEventListener('error', (e) => {
      done(new Error('edge-tts WebSocket 错误：' + (e.message || '连接失败')));
    });

    ws.addEventListener('close', () => {
      if (!settled) {
        const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
        if (buf.length > 0) {
          cachePut(ck, buf);
          done(null, buf);
        } else {
          done(new Error('edge-tts 连接意外关闭'));
        }
      }
    });
  });
}

 
export function rateStr(speed) {
  const n = Number(speed) || 1;
  const pct = Math.round((n - 1) * 100);
  return pct >= 0 ? `+${pct}%` : `${pct}%`;
}
