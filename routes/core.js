// 共通 API: 設定 / 購入（モック） / セッション / 利用ログ / 集計 / データ取得
'use strict';

const crypto = require('crypto');
const { MODEL, API_KEY, DEMO_CODES, DEMO_PUBLIC, DEFAULT_DEMO_CODE, PURCHASE_ENABLED, SESSIONS_PER_CODE_DAILY, SESSIONS_PER_IP_DAILY, TRUSTED_PROXY_HOPS } = require('../lib/config');
const { readBody, httpError } = require('../lib/http');
const { readData, readLog, writeLog, appendEvents, readEvents } = require('../lib/store');
const { createSession, requireSession, requireGuide, guideLogin } = require('../lib/auth');
const { clientIp, ipBucket, capSize, createFailureLimiter, createDailyCounter } = require('../lib/limits');

const DATA_FILES = { spots: 'spots.json', scenario: 'scenario.json', knowledge: 'knowledge.json' };
const now = () => new Date().toISOString();
const SMALL_BODY_LIMIT = 16_000;
const EVENTS_BODY_LIMIT = 64_000;

// コードと合言葉の総当たり対策（接続元ごとに 10 分で 10 回、全体で 200 回失敗したら 429）。入力された値はログに出さない
const sessionFails = createFailureLimiter();
const guideFails = createFailureLimiter();
const sessionsPerCode = createDailyCounter({ max: SESSIONS_PER_CODE_DAILY });
const sessionsPerIp = createDailyCounter({ max: SESSIONS_PER_IP_DAILY });
// 接続元（IPv4 はアドレス、IPv6 は /64）
const sourceOf = (req) => ipBucket(clientIp(req, TRUSTED_PROXY_HOPS));

// /api/events で受け付ける種類（体験アプリが送るものだけ）。llm_usage・purchase などはサーバーだけが書く
const CLIENT_EVENT_TYPES = new Set([
  'session_start', 'checkin', 'spot_reached', 'interaction', 'silence_end', 'question_asked', 'stt_used', 'tts',
  'speech_rate', 'guide_ask', 'guide_ask_reply', 'reflection', 'survey', 'session_complete', 'error',
]);
const MAX_EVENTS_PER_SESSION = 300;
const MAX_EVENT_KEYS = 30;
const eventCounts = new Map(); // sessionId -> 受け付けた件数

// 値は文字列（200 字まで）・数値・真偽値・null と、その配列（20 件まで）だけ残す
function cleanValue(v) {
  if (typeof v === 'string') return v.slice(0, 200);
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean' || v === null) return v;
  if (Array.isArray(v)) return v.slice(0, 20).map(cleanValue).filter((x) => x !== undefined && !Array.isArray(x));
  return undefined;
}
function cleanEvent(e) {
  if (!e || typeof e !== 'object' || !CLIENT_EVENT_TYPES.has(e.type)) return null;
  const entries = Object.entries(e).slice(0, MAX_EVENT_KEYS).map(([k, v]) => [k.slice(0, 40), cleanValue(v)]).filter(([, v]) => v !== undefined);
  return Object.fromEntries(entries);
}

function buildStats() {
  const events = readEvents();
  const purchases = Object.values(readLog('purchases.json', {}));
  const by = (type) => events.filter((e) => e.type === type);
  const uniq = (arr) => new Set(arr).size;
  const countBy = (arr, keyFn) => arr.reduce((m, x) => { const k = keyFn(x); m[k] = (m[k] || 0) + 1; return m; }, {});
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

  const starts = by('session_start');
  const completes = by('session_complete');
  const llm = by('llm_usage');
  const surveys = by('survey');
  const totalCost = llm.reduce((a, e) => a + (e.costJpy || 0), 0);
  const walkLlm = llm.filter((e) => e.sessionId);
  const sessionsWithCost = uniq(walkLlm.map((e) => e.sessionId));
  const walkCost = walkLlm.reduce((a, e) => a + (e.costJpy || 0), 0);

  return {
    generatedAt: now(),
    model: MODEL,
    funnel: {
      purchases: purchases.length + by('purchase').filter((e) => e.demoCode).length,
      started: uniq(starts.map((e) => e.sessionId)),
      completed: uniq(completes.map((e) => e.sessionId)),
    },
    avgDurationMin: avg(completes.map((e) => e.durationSec / 60).filter(Number.isFinite)),
    language: countBy(starts, (e) => e.lang || '?'),
    mode: countBy(starts, (e) => e.mode || '?'),
    checkinState: countBy(by('checkin'), (e) => e.state || '?'),
    checkinDesire: countBy(by('checkin'), (e) => e.desire || '?'),
    checkinNotes: by('checkin').filter((e) => e.note).slice(-20).reverse().map((e) => ({ ts: e.ts, note: e.note })),
    spotReach: countBy([...new Map(by('spot_reached').map((e) => [`${e.sessionId}:${e.spotId}`, e])).values()], (e) => e.spotId),
    interactions: countBy(by('interaction'), (e) => e.kind || '?'),
    silenceAvgSec: avg(by('silence_end').map((e) => e.actualSec).filter(Number.isFinite)),
    questions: { total: by('question_asked').length, byInput: countBy(by('question_asked'), (e) => e.input || '?') },
    guideAsks: { total: by('guide_ask').length, answered: countBy(by('guide_ask_reply'), (e) => e.via || '?') },
    usage: {
      llmCalls: llm.length,
      byPurpose: countBy(llm, (e) => e.purpose || '?'),
      inputTokens: llm.reduce((a, e) => a + (e.inputTokens || 0), 0),
      outputTokens: llm.reduce((a, e) => a + (e.outputTokens || 0), 0),
      sttCount: by('stt_used').length,
      ttsChars: by('tts').reduce((a, e) => a + (e.chars || 0), 0),
      totalCostJpy: totalCost,
      costPerSessionJpy: sessionsWithCost ? walkCost / sessionsWithCost : 0,
    },
    errors: countBy(by('error'), (e) => `${e.where || '?'}: ${String(e.message || '?').slice(0, 70)}`),
    survey: {
      n: surveys.length,
      satisfactionAvg: avg(surveys.map((e) => Number(e.satisfaction)).filter((n) => n > 0)),
      recommendAvg: avg(surveys.map((e) => e.recommend).filter((n) => typeof n === 'number')),
      price: countBy(surveys, (e) => e.price || '未回答'),
      screen: countBy(surveys, (e) => e.screen || '未回答'),
      next: countBy(surveys.flatMap((e) => e.next || []), (x) => x),
    },
    reflections: by('reflection').slice(-20).reverse().map((e) => ({ ts: e.ts, lang: e.lang, noticed: e.noticed, changed: e.changed, nextWish: e.nextWish })),
  };
}

module.exports = {
  // demoCode は公開してよいとき（初期値のデモコードだけのとき）だけ返す
  'GET /api/config': () => ({ llm: Boolean(API_KEY), model: MODEL, purchaseEnabled: PURCHASE_ENABLED, demoPublic: DEMO_PUBLIC, ...(DEMO_PUBLIC ? { demoCode: DEFAULT_DEMO_CODE } : {}) }),

  'GET /api/data/:name': (req, params) => {
    if (!Object.hasOwn(DATA_FILES, params.name)) throw httpError(404, 'not found');
    return readData(DATA_FILES[params.name]);
  },

  // モック決済: 実運用では Stripe Checkout 等の Webhook でコードを発行する
  'POST /api/purchase': async (req) => {
    if (!PURCHASE_ENABLED) throw httpError(403, 'purchase_disabled');
    const body = await readBody(req, SMALL_BODY_LIMIT);
    const code = 'KG-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const p = readLog('purchases.json', {});
    p[code] = { code, plan: body.plan || 'ai40', lang: body.lang || 'ja', priceJpy: 2000, createdAt: now(), usedAt: null };
    writeLog('purchases.json', p);
    appendEvents([{ type: 'purchase', ts: now(), plan: p[code].plan, lang: p[code].lang }]);
    return { code };
  },

  'POST /api/session': async (req) => {
    const ip = sourceOf(req);
    const { code } = await readBody(req, SMALL_BODY_LIMIT);
    // body を読み終えてから確かめる（check から fail まで await を挟まないので、同時に送られても上限を超えない）
    sessionFails.check(ip);
    const c = String(code || '').trim().toUpperCase();
    // 購入を止めているときは、過去に発行した購入コードも受け付けない
    const p = PURCHASE_ENABLED ? readLog('purchases.json', {}) : {};
    const isDemo = DEMO_CODES.includes(c);
    if (!isDemo && !Object.hasOwn(p, c)) {
      sessionFails.fail(ip);
      console.warn('[auth] invalid code from', ip);
      throw httpError(403, 'invalid_code');
    }
    if (isDemo && !sessionsPerCode.take(c)) throw httpError(429, 'code_daily_limit');
    if (!sessionsPerIp.take(ip)) throw httpError(429, 'ip_daily_limit');
    if (p[c] && !p[c].usedAt) { p[c].usedAt = now(); writeLog('purchases.json', p); }
    const { token, sessionId } = createSession(c);
    if (isDemo) appendEvents([{ type: 'purchase', ts: now(), demoCode: true, sessionId }]);
    return { token, sessionId };
  },

  'POST /api/events': async (req) => {
    const s = requireSession(req);
    const { events } = await readBody(req, EVENTS_BODY_LIMIT);
    const used = eventCounts.get(s.sessionId) || 0;
    const room = Math.max(0, Math.min(200, MAX_EVENTS_PER_SESSION - used));
    const ts = now();
    const accepted = (Array.isArray(events) ? events : []).slice(0, room).map(cleanEvent).filter(Boolean)
      .map((e) => ({ ...e, sessionId: s.sessionId, ts }));
    if (!eventCounts.has(s.sessionId)) capSize(eventCounts);
    eventCounts.set(s.sessionId, used + accepted.length);
    return { ok: true, accepted: appendEvents(accepted) };
  },

  'POST /api/guide/login': async (req) => {
    const ip = sourceOf(req);
    const { passcode } = await readBody(req, SMALL_BODY_LIMIT);
    guideFails.check(ip); // body の後（上と同じ理由）
    try {
      return { token: guideLogin(passcode) };
    } catch (e) {
      guideFails.fail(ip);
      console.warn('[auth] invalid guide passcode from', ip);
      throw e;
    }
  },

  'GET /api/stats': (req) => {
    requireGuide(req);
    return buildStats();
  },
};
