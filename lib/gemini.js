// Gemini 呼び出し（generativelanguage / Vertex AI Express の両対応）
'use strict';

const { API_KEY, SERVICE_ACCOUNT_JSON, VERTEX_PROJECT, VERTEX_LOCATION, MODEL, PRICE_IN, PRICE_OUT, TTS_PRICE_IN, TTS_PRICE_OUT, USD_JPY, LLM_DAILY_MAX, TTS_DAILY_MAX } = require('./config');
const { jstDay } = require('./limits');
const { parseServiceAccount, createServiceAccountTokens } = require('./service-account');

// サービスアカウントの鍵があれば、Vertex AI をその鍵のトークンで呼ぶ（API キーより優先）
const account = parseServiceAccount(SERVICE_ACCOUNT_JSON);
const vertexProject = VERTEX_PROJECT || (account && account.projectId);
const tokens = account && vertexProject ? createServiceAccountTokens({ account }) : null;

// サーバー全体の 1 日の呼び出し回数（メモリ上。日本時間の日付が変わったら数え直す）。
// callGemini を呼んだ回数で数える（1 回の中でエンドポイントを切り替えて 2 回送っても 1 回、失敗しても 1 回）。
// 会話（LLM_DAILY_MAX）と音声（TTS_DAILY_MAX）は別々に数える
let daily = { day: '', count: 0 };
let ttsDaily = { day: '', count: 0 };
function nextCount(counter, max, nowMs) {
  const day = jstDay(nowMs);
  const count = counter.day === day ? counter.count : 0;
  return max && count >= max ? null : { day, count: count + 1 };
}
function takeDailyQuota(nowMs = Date.now()) {
  const next = nextCount(daily, LLM_DAILY_MAX, nowMs);
  if (next) daily = next;
  return Boolean(next);
}
function takeTtsQuota(nowMs = Date.now()) {
  const next = nextCount(ttsDaily, TTS_DAILY_MAX, nowMs);
  if (next) ttsDaily = next;
  return Boolean(next);
}

// 鍵（サービスアカウント）があれば Vertex の 1 つだけ。API キーのときは "AQ." で始まるなら Vertex Express を先に試し、成功したエンドポイントを以後優先
let preferredEndpoint = null;
function endpoints(model = MODEL) {
  if (tokens) {
    const host = VERTEX_LOCATION === 'global' ? 'aiplatform.googleapis.com' : `${VERTEX_LOCATION}-aiplatform.googleapis.com`;
    const url = `https://${host}/v1/projects/${encodeURIComponent(vertexProject)}/locations/${encodeURIComponent(VERTEX_LOCATION)}/publishers/google/models/${model}:generateContent`;
    return [{ name: 'vertex-service-account', url, headers: {}, auth: true }];
  }
  const gl = { name: 'generativelanguage', url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, headers: { 'x-goog-api-key': API_KEY } };
  const vx = { name: 'vertex-express', url: `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent?key=${encodeURIComponent(API_KEY)}`, headers: {} };
  const eps = API_KEY.startsWith('AQ.') ? [vx, gl] : [gl, vx];
  if (preferredEndpoint) eps.sort((a, b) => (b.name === preferredEndpoint) - (a.name === preferredEndpoint));
  return eps;
}

const enabled = () => Boolean(tokens || API_KEY);

/**
 * @param {object} p
 * @param {string} p.system      system instruction
 * @param {Array}  p.contents    Gemini contents（parts に inlineData で音声も渡せる）
 * @param {boolean} [p.json]     JSON で返させる（responseMimeType）
 * @param {{model: string, voice: string}} [p.speech] 音声で返させる（TTS モデル。system は送らず、audio を返す）
 * @param {boolean} [p.metered]  1 日の上限（LLM_DAILY_MAX）に数えるか。体験者向けは true、ガイドさんの作業は false
 * @returns {Promise<{text: string, audio: ?{data: string, mimeType: string}, usage: {inputTokens: number, outputTokens: number}}>}
 */
async function callGemini({ system, contents, maxTokens = 400, temperature = 0.6, json = false, timeoutMs = 20000, metered = true, speech = null }) {
  if (!enabled()) throw new Error('GEMINI_API_KEY（または GEMINI_SA_JSON）が設定されていません');
  // 体験者向けの呼び出しは、上限を超えたら呼ばない。呼び出し側（/api/ask・/api/narrate・/api/checkin/parse）は
  // 失敗時と同じく、素材と Knowledge だけの案内に切り替える。ガイドさんの録音や抽出は数えない（録音は後から取り直せないため）
  if (speech) {
    if (!takeTtsQuota()) throw Object.assign(new Error('音声の 1 日の上限に達しました'), { code: 'tts_daily_limit' });
  } else if (metered && !takeDailyQuota()) throw Object.assign(new Error('LLM の 1 日の上限に達しました'), { code: 'llm_daily_limit' });
  // 音声（TTS）モデルは temperature・maxOutputTokens を入れると 400 になるため、音声のときは入れない
  const generationConfig = speech ? {} : { temperature, maxOutputTokens: maxTokens };
  // 考える時間のある Flash（2.5 / 3.x / *-latest）は 0 にして応答速度を優先する（2.0 以前は thinkingConfig を受け付けない。3.8-flash で効くことを確認済み）
  if (!speech && /(2\.5|[3-9]\.\d+)-flash|flash(-lite)?-latest/i.test(MODEL)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  if (speech) {
    generationConfig.responseModalities = ['AUDIO'];
    // 3.x の TTS は voiceConfig.voice、2.5 の TTS は prebuiltVoiceConfig.voiceName（公式ドキュメントの形）
    generationConfig.speechConfig = { voiceConfig: /2\.5/.test(speech.model) ? { prebuiltVoiceConfig: { voiceName: speech.voice } } : { voice: speech.voice } };
  }
  if (json) generationConfig.responseMimeType = 'application/json';
  const body = JSON.stringify({ ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), contents, generationConfig });

  // 最初のエンドポイントのエラーを残す（あとのエンドポイントの「使えない」で本当の原因が隠れないように）
  let firstErr;
  for (const ep of endpoints(speech ? speech.model : MODEL)) {
    try {
      const headers = ep.auth ? { Authorization: `Bearer ${await tokens.get()}` } : ep.headers;
      const res = await fetch(ep.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (ep.auth && res.status === 401) tokens.invalidate();
        firstErr = firstErr || new Error(`${ep.name} ${res.status}: ${(data.error && data.error.message) || ''}`.slice(0, 300));
        continue;
      }
      preferredEndpoint = ep.name;
      const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
      const u = data.usageMetadata || {};
      const audioPart = parts.find((p) => p.inlineData && p.inlineData.data);
      return {
        audio: audioPart ? audioPart.inlineData : null,
        text: parts.map((p) => p.text || '').join('').trim(),
        usage: { inputTokens: u.promptTokenCount || 0, outputTokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) },
      };
    } catch (e) {
      firstErr = firstErr || e;
    }
  }
  throw firstErr;
}

// JSON モードの応答をパースする（```json フェンス付きで返ることがあるため除去）
function parseJson(text) {
  return JSON.parse(String(text).replace(/^```(?:json)?\s*|\s*```$/g, ''));
}

// 音声の単価（USD / 1M トークン）。環境変数がなければ公式の料金: 2026-12-31 まで 0.5 / 9、2027-01-01 から 1.0 / 18
function ttsRates(nowMs = Date.now()) {
  const x = jstDay(nowMs) >= '2027-01-01' ? 2 : 1;
  return { in: TTS_PRICE_IN || 0.5 * x, out: TTS_PRICE_OUT || 9 * x };
}

/** purpose が 'tts' のときは音声の単価、それ以外は会話の単価で数える */
function costJpy({ inputTokens, outputTokens }, purpose = '', nowMs = Date.now()) {
  const r = purpose === 'tts' ? ttsRates(nowMs) : { in: PRICE_IN, out: PRICE_OUT };
  return ((inputTokens * r.in + outputTokens * r.out) / 1e6) * USD_JPY;
}

module.exports = { callGemini, parseJson, costJpy, enabled };
// テスト用（日付の切り替えを時刻を指定して確かめる）
Object.defineProperty(module.exports, '_test', { value: { takeDailyQuota, takeTtsQuota, resetDaily: () => { daily = { day: '', count: 0 }; ttsDaily = { day: '', count: 0 }; } }, enumerable: false });
