// 集計（/api/stats）。イベントと購入の配列だけから作る純粋関数（読み込みは routes/core.js）
'use strict';

/** events: 利用ログ、purchases: 購入コードの一覧。model・generatedAt は画面に出すだけ */
function buildStats(events, purchases, { model, generatedAt = new Date().toISOString() } = {}) {
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
    generatedAt,
    model,
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
      geminiTtsCalls: llm.filter((e) => e.purpose === 'tts').length,
      geminiTtsCostJpy: llm.filter((e) => e.purpose === 'tts').reduce((a, e) => a + (e.costJpy || 0), 0),
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

module.exports = { buildStats };
