// Gemini 呼び出し（generativelanguage / Vertex AI Express の両対応）
'use strict';

const { API_KEY, MODEL, PRICE_IN, PRICE_OUT, USD_JPY } = require('./config');

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
 * @returns {Promise<{text: string, usage: {inputTokens: number, outputTokens: number}}>}
 */
async function callGemini({ system, contents, maxTokens = 400, temperature = 0.6, json = false, timeoutMs = 20000 }) {
  if (!API_KEY) throw new Error('GEMINI_API_KEY が設定されていません');
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
