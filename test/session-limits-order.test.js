'use strict';
// 体験の受け付け: IP の上限で断ったときに共通のデモコードの枠を減らさない／最後のアンケートと完了は件数の上限を超えても残す
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./_helper');

const dir = h.setupEnv({ extraEnv: { DEMO_CODES: 'YK-ORDER01', SESSIONS_PER_CODE_DAILY: '3', SESSIONS_PER_IP_DAILY: '1', TRUSTED_PROXY_HOPS: '1' } });
let srv;
before(async () => { srv = await h.startServer(); });
after(async () => { await srv.close(); });

const start = (ip) => h.api(srv.base, 'POST', '/api/session', { headers: { 'X-Forwarded-For': ip }, body: { code: 'YK-ORDER01' } });

test('session_ipDailyLimit_doesNotConsumeSharedCodeQuota', async () => {
  assert.equal((await start('1.1.1.1')).status, 200);
  for (let i = 0; i < 5; i++) {
    const r = await start('1.1.1.1');
    assert.equal(r.status, 429);
    assert.equal(r.json.error, 'ip_daily_limit');
  }
  // 同じ接続元で 5 回断られても、コードの枠（3 回）は 1 回分しか減っていない
  assert.equal((await start('2.2.2.2')).status, 200);
  assert.equal((await start('3.3.3.3')).status, 200);
  const over = await start('4.4.4.4');
  assert.equal(over.status, 429);
  assert.equal(over.json.error, 'code_daily_limit');
});

test('events_finalSurveyAndComplete_acceptedEvenAfterCap', async () => {
  const { createSession } = require('../lib/auth');
  const headers = { 'X-Session-Token': createSession('YK-ORDER01').token };
  const post = (events) => h.api(srv.base, 'POST', '/api/events', { headers, body: { events } });
  for (let i = 0; i < 2; i++) await post(Array.from({ length: 200 }, () => ({ type: 'tts' })));
  assert.equal((await post([{ type: 'tts' }])).json.accepted, 0, '300 件を超えたら普通のイベントは捨てる');
  assert.equal((await post([{ type: 'survey', q: 'a' }, { type: 'session_complete' }])).json.accepted, 2);
  assert.equal((await post([{ type: 'survey', q: 'b' }])).json.accepted, 0, '最後のイベントは 1 回の体験で各 1 件まで');
  assert.ok(require('fs').existsSync(require('path').join(dir, 'logs', 'events.jsonl')));
});
