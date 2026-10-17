// Gemini 呼び出し（generativelanguage / Vertex AI Express の両対応）
'use strict';

const { API_KEY, MODEL, PRICE_IN, PRICE_OUT, USD_JPY, LLM_DAILY_MAX } = require('./config');
const { jstDay } = require('./limits');

// サーバー全体の 1 日の呼び出し回数（メモリ上。日本時間の日付が変わったら数え直す）。
// callGemini を呼んだ回数で数える（1 回の中でエンドポイントを切り替えて 2 回送っても 1 回、失敗しても 1 回）
let daily = { day: '', count: 0 };
function takeDailyQuota(nowMs = Date.now()) {
  const day = jstDay(nowMs);
  const count = daily.day === day ? daily.count : 0;
  if (LLM_DAILY_MAX && count >= LLM_DAILY_MAX) return false;
  daily = { day, count: count + 1 };
  return true;
}

// "AQ." で始まるキーは Vertex AI Express のキーとみなし、Vertex を先に試す。成功したエンドポイントを以後優先。
let preferredEndpoint = null;
function endpoints() {
  const gl = { name: 'generativelanguage', url: `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, headers: { 'x-goog-api-key': API_KEY } };
  const vx = { name: 'vertex-express', url: `https://aiplatform.googleapis.com/v1/publishers/google/models/${MODEL}:generateContent?key=${encodeURIComponent(API_KEY)}`, headers: {} };
  const eps = API_KEY.startsWith('AQ.') ? [vx, gl] : [gl, vx];
  if (preferredEndpoint) eps.sort((a, b) => (b.name === preferredEndpoint) - (a.name === preferredEndpoint));
  return eps;
}

const enabled = () => Boolean(API_KEY);

/**
 * @param {object} p
 * @param {string} p.system      system instruction
 * @param {Array}  p.contents    Gemini contents（parts に inlineData で音声も渡せる）
 * @param {boolean} [p.json]     JSON で返させる（responseMimeType）
 * @param {boolean} [p.metered]  1 日の上限（LLM_DAILY_MAX）に数えるか。体験者向けは true、ガイドさんの作業は false
 * @returns {Promise<{text: string, usage: {inputTokens: number, outputTokens: number}}>}
 */
async function callGemini({ system, contents, maxTokens = 400, temperature = 0.6, json = false, timeoutMs = 20000, metered = true }) {
  if (!API_KEY) throw new Error('GEMINI_API_KEY が設定されていません');
  // 体験者向けの呼び出しは、上限を超えたら呼ばない。呼び出し側（/api/ask・/api/narrate・/api/checkin/parse）は
  // 失敗時と同じく、素材と Knowledge だけの案内に切り替える。ガイドさんの録音や抽出は数えない（録音は後から取り直せないため）
  if (metered && !takeDailyQuota()) throw Object.assign(new Error('LLM の 1 日の上限に達しました'), { code: 'llm_daily_limit' });
  const generationConfig = { temperature, maxOutputTokens: maxTokens };
  if (/2\.5-flash/.test(MODEL)) generationConfig.thinkingConfig = { thinkingBudget: 0 }; // 応答速度優先
  if (json) generationConfig.responseMimeType = 'application/json';
  const body = JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig });

  let lastErr;
  for (const ep of endpoints()) {
    try {
      const res = await fetch(ep.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ep.headers },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        lastErr = new Error(`${ep.name} ${res.status}: ${(data.error && data.error.message) || ''}`.slice(0, 300));
        continue;
      }
      preferredEndpoint = ep.name;
      const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
      const u = data.usageMetadata || {};
      return {
        text: parts.map((p) => p.text || '').join('').trim(),
        usage: { inputTokens: u.promptTokenCount || 0, outputTokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) },
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// JSON モードの応答をパースする（```json フェンス付きで返ることがあるため除去）
function parseJson(text) {
  return JSON.parse(String(text).replace(/^```(?:json)?\s*|\s*```$/g, ''));
}

function costJpy({ inputTokens, outputTokens }) {
  return ((inputTokens * PRICE_IN + outputTokens * PRICE_OUT) / 1e6) * USD_JPY;
}

module.exports = { callGemini, parseJson, costJpy, enabled };
// テスト用（日付の切り替えを時刻を指定して確かめる）
Object.defineProperty(module.exports, '_test', { value: { takeDailyQuota, resetDaily: () => { daily = { day: '', count: 0 }; } }, enumerable: false });
