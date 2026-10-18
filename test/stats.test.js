'use strict';
// lib/stats.js（集計は純粋関数: イベントと購入の配列だけから作る）と lib/static-data.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./_helper');

h.setupEnv();
const { buildStats } = require('../lib/stats');
const { readStatic } = require('../lib/static-data');

const ev = (type, extra = {}) => ({ type, ts: '2026-10-17T01:00:00.000Z', ...extra });

test('buildStats_withNoData_returnsZeroFunnel', () => {
  const s = buildStats([], [], { model: 'm', generatedAt: 'x' });
  assert.deepEqual(s.funnel, { purchases: 0, started: 0, completed: 0 });
  assert.equal(s.avgDurationMin, null);
  assert.equal(s.model, 'm');
  assert.equal(s.generatedAt, 'x');
});

test('buildStats_countsFunnelCostAndSurvey', () => {
  const events = [
    ev('purchase', { demoCode: true }), ev('purchase', { plan: 'ai40' }),
    ev('session_start', { sessionId: 'a', lang: 'ja', mode: 'ai' }), ev('session_start', { sessionId: 'a', lang: 'ja', mode: 'ai' }),
    ev('session_start', { sessionId: 'b', lang: 'en', mode: 'ai' }),
    ev('session_complete', { sessionId: 'a', durationSec: 600 }),
    ev('llm_usage', { sessionId: 'a', purpose: 'narrate', inputTokens: 10, outputTokens: 5, costJpy: 2 }),
    ev('llm_usage', { purpose: 'guide_extract', costJpy: 1 }),
    ev('survey', { satisfaction: 4, recommend: 8, next: ['x', 'y'] }),
  ];
  const s = buildStats(events, [{ code: 'KG-000001' }], { model: 'm' });
  assert.deepEqual(s.funnel, { purchases: 2, started: 2, completed: 1 }, '購入コード 1 件 + デモコード 1 件');
  assert.equal(s.avgDurationMin, 10);
  assert.deepEqual(s.language, { ja: 2, en: 1 });
  assert.equal(s.usage.llmCalls, 2);
  assert.equal(s.usage.totalCostJpy, 3);
  assert.equal(s.usage.geminiTtsCalls, 0);
  assert.equal(s.usage.costPerSessionJpy, 2, '体験 1 回あたりは体験中の呼び出しだけ');
  assert.equal(s.survey.n, 1);
  assert.deepEqual(s.survey.next, { x: 1, y: 1 });
});

test('buildStats_doesNotMutateInput', () => {
  const events = Object.freeze([Object.freeze(ev('checkin', { note: 'a', state: 'ok' })), Object.freeze(ev('reflection', { noticed: 'b' }))]);
  const s = buildStats(events, Object.freeze([]), { model: 'm' });
  assert.equal(s.checkinNotes.length, 1);
  assert.equal(s.reflections.length, 1);
});

test('readStatic_readsKnowledgeAndScenario_butNotOtherFiles', () => {
  assert.ok(Array.isArray(readStatic('knowledge.json').chunks));
  assert.equal(typeof readStatic('scenario.json'), 'object');
  assert.throws(() => readStatic('spots.json'), /not static/);
  assert.throws(() => readStatic('../package.json'), /not static/);
});

test('readStatic_readsOnce_andReturnsFrozenData', () => {
  const a = readStatic('knowledge.json');
  assert.equal(readStatic('knowledge.json'), a, '同じものを使い回す');
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.chunks) && Object.isFrozen(a.chunks[0]));
});

test('buildStats_withTtsUsage_separatesTtsFromConversation', () => {
  const events = [
    ev('llm_usage', { sessionId: 'a', purpose: 'narrate', costJpy: 2 }),
    ev('llm_usage', { sessionId: 'a', purpose: 'tts', costJpy: 0.5 }),
    ev('llm_usage', { sessionId: 'a', purpose: 'tts', costJpy: 0.5 }),
  ];
  const u = buildStats(events, [], { model: 'm' }).usage;
  assert.equal(u.llmCalls, 1);
  assert.equal(u.llmCostJpy, 2);
  assert.equal(u.geminiTtsCalls, 2);
  assert.equal(u.geminiTtsCostJpy, 1);
  assert.equal(u.totalCostJpy, 3);
});
