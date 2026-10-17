'use strict';
// サーバー全体の 1 日の LLM 上限（LLM_DAILY_MAX）。超えたら Gemini を呼ばずに代わりの案内を返す
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./_helper');

const dir = h.setupEnv({ key: 'test-key-not-real', extraEnv: { LLM_DAILY_MAX: '2' } });
let srv;
before(async () => { srv = await h.startServer(); });
after(async () => { await srv.close(); });

const ask = (sess) => h.api(srv.base, 'POST', '/api/ask', { headers: sess.headers, body: { question: 'ここはどこ？', lang: 'ja', spotId: 't1' } });

test('llmDailyMax_afterLimit_stopsCallingGeminiAcrossSessionsAndFallsBack', async () => {
  const stub = h.stubGemini(() => 'ここは黒松の広場です。');
  const a = await h.newSession(srv.base);
  const b = await h.newSession(srv.base);
  assert.equal((await ask(a)).json.fallback, undefined);
  assert.equal((await ask(b)).json.fallback, undefined);
  const third = await ask(a);
  assert.equal(third.status, 200);
  assert.equal(third.json.fallback, true);
  assert.ok(third.json.answer, '代わりの案内が返る');
  assert.equal(stub.calls, 2, '上限を超えたら Gemini を呼ばない');

  const narrate = await h.api(srv.base, 'POST', '/api/narrate', {
    headers: b.headers,
    body: { lang: 'ja', checkin: { state: 'ok', desire: 'nature' }, trigger: 'arrive', spotId: 't1', motion: { speedMps: 0.5 }, spokenMaterialIds: [] },
  });
  assert.equal(narrate.status, 200);
  assert.equal(narrate.json.fallback, true);
  assert.equal(stub.calls, 2, 'narrate も同じ上限に数えられる');

  const errors = h.readEvents(dir).filter((e) => e.type === 'error' && /上限/.test(e.message));
  assert.ok(errors.length >= 2, '上限に達したことがログに残る');
});

test('config_withLimit_doesNotExposeLimitOrKey', async () => {
  const r = await h.api(srv.base, 'GET', '/api/config');
  assert.deepEqual(Object.keys(r.json).sort(), ['demoPublic', 'llm', 'model', 'purchaseEnabled']);
});
