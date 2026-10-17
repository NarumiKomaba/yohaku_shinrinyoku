'use strict';
// 公開で負荷と費用を抑える上限: 同時に送られた総当たり、接続元ごとの体験数、体験中の API の回数、質問の Gemini 回数、ログの量
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./_helper');

const dir = h.setupEnv({
  key: 'test-key-not-real',
  extraEnv: { DEMO_CODES: 'YK-LOADLIM1', WALK_CALLS_PER_MIN: '4', ASK_MAX_PER_SESSION: '1', EVENTS_DAILY_BYTES: '3000' },
});
let srv;
before(async () => { srv = await h.startServer(); });
after(async () => { await srv.close(); });

const { createSession } = require('../lib/auth');
const sessionHeaders = () => ({ 'X-Session-Token': createSession('YK-LOADLIM1').token });
const ask = (headers) => h.api(srv.base, 'POST', '/api/ask', { headers, body: { question: 'ここはどこ？', lang: 'ja', spotId: 't1' } });

test('session_parallelWrongCodes_cannotExceedTenFailures', async () => {
  const results = await Promise.all(Array.from({ length: 30 }, () => h.api(srv.base, 'POST', '/api/session', { body: { code: 'WRONG-CODE' } })));
  const rejected = results.filter((r) => r.status === 403).length;
  assert.ok(rejected <= 10, `同時に送っても、確かめられるのは 10 回まで（${rejected} 回）`);
  assert.equal(results.filter((r) => r.status === 429).length, 30 - rejected);
});

test('askMaxPerSession_afterLimit_fallsBackWithoutGemini', async () => {
  const stub = h.stubGemini(() => 'ここは黒松の広場です。');
  const headers = sessionHeaders();
  assert.equal((await ask(headers)).json.fallback, undefined);
  const second = await ask(headers);
  assert.equal(second.status, 200);
  assert.equal(second.json.fallback, true);
  assert.equal(stub.calls, 1, '上限を超えたら Gemini を呼ばない');
});

test('walkApis_overPerMinuteLimit_return429', async () => {
  h.stubGemini(() => 'はい。');
  const headers = sessionHeaders();
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await ask(headers)).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 429, 429]);
});

test('eventsDailyBytes_overLimit_dropsInsteadOfWriting', async () => {
  const headers = sessionHeaders();
  const batch = Array.from({ length: 10 }, () => ({ type: 'tts', note: 'x'.repeat(150) }));
  const results = [];
  for (let i = 0; i < 5; i++) results.push((await h.api(srv.base, 'POST', '/api/events', { headers, body: { events: batch } })).json.accepted);
  assert.ok(results.includes(0), `1 日の量を超えたら捨てる: ${results}`);
  const size = require('fs').statSync(require('path').join(dir, 'logs', 'events.jsonl')).size;
  assert.ok(size <= 3000, `書き込みは上限まで（${size} バイト）`);
});
