// 共通 API: 設定 / 購入（モック） / セッション / 利用ログ / 集計 / データ取得
'use strict';

const crypto = require('crypto');
const { enabled: geminiEnabled } = require('../lib/gemini');
const { MODEL, DEMO_CODES, DEMO_PUBLIC, DEFAULT_DEMO_CODE, PURCHASE_ENABLED, SESSIONS_PER_CODE_DAILY, SESSIONS_PER_IP_DAILY, TRUSTED_PROXY_HOPS, STATS_MAX_DOCS, STATS_CACHE_SEC } = require('../lib/config');
const { readBody, httpError } = require('../lib/http');
const { getSpots, appendEvents, listEvents, listPurchases, createPurchase, getPurchase, markPurchaseUsed } = require('../lib/store');
const { PURCHASE_CODE_RE } = require('../lib/store/common');
const { readStatic } = require('../lib/static-data');
const { buildStats } = require('../lib/stats');
const { createSession, requireSession, requireGuide, guideLogin } = require('../lib/auth');
const { jstDay, clientIp, ipBucket, capSize, createFailureLimiter, createDailyCounter } = require('../lib/limits');

const DATA_FILES = { spots: 'spots.json', scenario: 'scenario.json', knowledge: 'knowledge.json' };
const now = () => new Date().toISOString();
const SMALL_BODY_LIMIT = 16_000;
// 購入で受け付けるプランと言語（それ以外は先頭のもの）
const PLANS = ['ai40'];
const LANGS = ['ja', 'en'];
const pick = (allowed, v) => (allowed.includes(v) ? v : allowed[0]);
const PURCHASE_TRIES = 3; // 購入コードが既存のものと重なったら作り直す回数
const DAY_MS = 24 * 3600 * 1000;
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
  'session_start', 'checkin', 'spot_reached', 'interaction', 'silence_end', 'question_asked', 'stt_used', 'stt_listen', 'speech_stop', 'tts',
  'speech_rate', 'guide_ask', 'guide_ask_reply', 'reflection', 'survey', 'session_complete', 'error',
]);
const MAX_EVENTS_PER_SESSION = 300;
const FINAL_EVENT_TYPES = new Set(['survey', 'session_complete']);
const finalSeen = new Set(); // `${sessionId}:${type}`
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

// 集計する日数（?days=N。既定 7、1〜90）。範囲外は 400
function statsDays(req) {
  const raw = new URL(req.url, 'http://localhost').searchParams.get('days');
  if (raw === null) return 7;
  const days = Number(raw);
  if (!/^\d+$/.test(raw) || days < 1 || days > 90) throw httpError(400, 'invalid days');
  return days;
}

async function computeStats(days) {
  const toDay = jstDay();
  const fromDay = jstDay(Date.now() - (days - 1) * DAY_MS);
  const [ev, pu] = await Promise.all([listEvents({ fromDay, toDay, maxDocs: STATS_MAX_DOCS }), listPurchases()]);
  return { ...buildStats(ev.events, pu.purchases, { model: MODEL, generatedAt: now() }), days, fromDay, toDay, truncated: ev.truncated || pu.truncated };
}

// 集計は重いので STATS_CACHE_SEC のあいだ使い回す（日数ごと）。読んでいる途中に来たリクエストも同じ読み込みを待つ。失敗は残さない
let statsCache = new Map(); // days -> { at, promise, settled }
const setStatsEntry = (days, entry) => { statsCache = new Map(statsCache).set(days, entry); };
function loadStats(days) {
  const hit = statsCache.get(days);
  if (hit && (!hit.settled || Date.now() - hit.at < STATS_CACHE_SEC * 1000)) return hit.promise;
  const promise = computeStats(days);
  setStatsEntry(days, { at: Date.now(), promise, settled: false });
  const settle = (ok) => {
    if (statsCache.get(days)?.promise !== promise) return;
    if (ok) setStatsEntry(days, { at: Date.now(), promise, settled: true });
    else statsCache = new Map([...statsCache].filter(([d]) => d !== days));
  };
  promise.then(() => settle(true), () => settle(false));
  return promise;
}

// 購入コードを作る。同じコードがあれば作り直す
async function issuePurchase(body) {
  for (let i = 0; i < PURCHASE_TRIES; i++) {
    const p = { code: 'KG-' + crypto.randomBytes(3).toString('hex').toUpperCase(), plan: pick(PLANS, body.plan), lang: pick(LANGS, body.lang), priceJpy: 2000, createdAt: now(), usedAt: null };
    try {
      await createPurchase(p);
      return p;
    } catch (e) {
      if (e.code !== 'exists') throw e;
    }
  }
  throw httpError(503, 'purchase_code_busy');
}

function rejectCode(ip) {
  sessionFails.fail(ip);
  console.warn('[auth] invalid code from', ip);
  throw httpError(403, 'invalid_code');
}

// 購入コードを調べる。await の前に失敗として数え（同時に送られても上限を超えない）、見つかったら取り消す
async function findPurchase(ip, c) {
  // 購入を止めているときは、過去に発行した購入コードも受け付けない。形の違うものは調べるまでもない
  if (!PURCHASE_ENABLED || !PURCHASE_CODE_RE.test(c)) rejectCode(ip);
  sessionFails.fail(ip);
  let p;
  try {
    p = await getPurchase(c);
  } catch (e) {
    sessionFails.undo(ip); // 保存先の故障は本人の失敗ではない
    throw e;
  }
  if (!p) {
    console.warn('[auth] invalid code from', ip);
    throw httpError(403, 'invalid_code');
  }
  sessionFails.undo(ip);
  return p;
}

module.exports = {
  // demoCode は公開してよいとき（初期値のデモコードだけのとき）だけ返す
  'GET /api/config': () => ({ llm: geminiEnabled(), tts: geminiEnabled(), model: MODEL, purchaseEnabled: PURCHASE_ENABLED, demoPublic: DEMO_PUBLIC, ...(DEMO_PUBLIC ? { demoCode: DEFAULT_DEMO_CODE } : {}) }),

  'GET /api/data/:name': (req, params) => {
    if (!Object.hasOwn(DATA_FILES, params.name)) throw httpError(404, 'not found');
    return params.name === 'spots' ? getSpots() : readStatic(DATA_FILES[params.name]);
  },

  // モック決済: 実運用では Stripe Checkout 等の Webhook でコードを発行する
  'POST /api/purchase': async (req) => {
    if (!PURCHASE_ENABLED) throw httpError(403, 'purchase_disabled');
    const body = await readBody(req, SMALL_BODY_LIMIT);
    const p = await issuePurchase(body);
    await appendEvents([{ type: 'purchase', ts: now(), plan: p.plan, lang: p.lang }]);
    return { code: p.code };
  },

  'POST /api/session': async (req) => {
    const ip = sourceOf(req);
    const { code } = await readBody(req, SMALL_BODY_LIMIT);
    // body を読み終えてから確かめる（check から fail まで await を挟まないので、同時に送られても上限を超えない）
    sessionFails.check(ip);
    const c = String(code || '').trim().toUpperCase();
    // デモコードは保存先を読まずに進む（保存先が止まっていても体験できる）
    const isDemo = DEMO_CODES.includes(c);
    const purchase = isDemo ? null : await findPurchase(ip, c);
    // 両方の上限を確かめてから数える（IP の上限で断ったときに、共通のデモコードの枠を減らさない）
    if (!sessionsPerIp.peek(ip)) throw httpError(429, 'ip_daily_limit');
    if (isDemo && !sessionsPerCode.peek(c)) throw httpError(429, 'code_daily_limit');
    sessionsPerIp.take(ip);
    if (isDemo) sessionsPerCode.take(c);
    // 使った印は最初の 1 回だけ。書けなくても体験は始められる（保存先のログは rest.js が出す）
    if (purchase && !purchase.usedAt) await markPurchaseUsed(c, now(), { ifVersion: purchase.version }).catch(() => {});
    const { token, sessionId } = createSession(c);
    if (isDemo) await appendEvents([{ type: 'purchase', ts: now(), demoCode: true, sessionId }]);
    return { token, sessionId };
  },

  'POST /api/events': async (req) => {
    const s = requireSession(req);
    const { events } = await readBody(req, EVENTS_BODY_LIMIT);
    const used = eventCounts.get(s.sessionId) || 0;
    const room = Math.max(0, Math.min(200, MAX_EVENTS_PER_SESSION - used));
    const ts = now();
    const cleaned = (Array.isArray(events) ? events : []).slice(0, 200).map(cleanEvent).filter(Boolean);
    // 最後のアンケートと完了は、件数の上限に達していても受け付ける（1 回の体験で各 1 件まで）
    const counted = cleaned.filter((e) => !FINAL_EVENT_TYPES.has(e.type)).slice(0, room);
    const finals = cleaned.filter((e) => FINAL_EVENT_TYPES.has(e.type) && !finalSeen.has(`${s.sessionId}:${e.type}`));
    finals.forEach((e) => { capSize(finalSeen); finalSeen.add(`${s.sessionId}:${e.type}`); });
    const accepted = [...counted, ...finals].map((e) => ({ ...e, sessionId: s.sessionId, ts }));
    if (!eventCounts.has(s.sessionId)) capSize(eventCounts);
    eventCounts.set(s.sessionId, used + counted.length);
    return { ok: true, accepted: await appendEvents(accepted) };
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
    return loadStats(statsDays(req));
  },
};
