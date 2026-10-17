// 共通 API: 設定 / 購入（モック） / セッション / 利用ログ / 集計 / データ取得
'use strict';

const crypto = require('crypto');
const { MODEL, API_KEY, DEMO_CODES, DEMO_PUBLIC, PURCHASE_ENABLED } = require('../lib/config');
const { readBody, httpError } = require('../lib/http');
const { readData, readLog, writeLog, appendEvents, readEvents } = require('../lib/store');
const { createSession, requireSession, requireGuide, guideLogin } = require('../lib/auth');

const DATA_FILES = { spots: 'spots.json', scenario: 'scenario.json', knowledge: 'knowledge.json' };
const now = () => new Date().toISOString();

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
  'GET /api/config': () => ({ llm: Boolean(API_KEY), model: MODEL, purchaseEnabled: PURCHASE_ENABLED, demoPublic: DEMO_PUBLIC }),

  'GET /api/data/:name': (req, params) => {
    if (!Object.hasOwn(DATA_FILES, params.name)) throw httpError(404, 'not found');
    return readData(DATA_FILES[params.name]);
  },

  // モック決済: 実運用では Stripe Checkout 等の Webhook でコードを発行する
  'POST /api/purchase': async (req) => {
    if (!PURCHASE_ENABLED) throw httpError(403, 'purchase_disabled');
    const body = await readBody(req);
    const code = 'KG-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const p = readLog('purchases.json', {});
    p[code] = { code, plan: body.plan || 'ai40', lang: body.lang || 'ja', priceJpy: 2000, createdAt: now(), usedAt: null };
    writeLog('purchases.json', p);
    appendEvents([{ type: 'purchase', ts: now(), plan: p[code].plan, lang: p[code].lang }]);
    return { code };
  },

  'POST /api/session': async (req) => {
    const { code } = await readBody(req);
    const c = String(code || '').trim().toUpperCase();
    const p = readLog('purchases.json', {});
    const isDemo = DEMO_CODES.includes(c);
    if (!isDemo && !p[c]) throw httpError(403, 'invalid_code');
    if (p[c] && !p[c].usedAt) { p[c].usedAt = now(); writeLog('purchases.json', p); }
    const { token, sessionId } = createSession(c);
    if (isDemo) appendEvents([{ type: 'purchase', ts: now(), demoCode: true, sessionId }]);
    return { token, sessionId };
  },

  'POST /api/events': async (req) => {
    const s = requireSession(req);
    const { events = [] } = await readBody(req);
    const ts = now();
    appendEvents(events.slice(0, 200).map((e) => ({ ...e, sessionId: s.sessionId, ts })));
    return { ok: true };
  },

  'POST /api/guide/login': async (req) => {
    const { passcode } = await readBody(req);
    return { token: guideLogin(passcode) };
  },

  'GET /api/stats': (req) => {
    requireGuide(req);
    return buildStats();
  },
};
