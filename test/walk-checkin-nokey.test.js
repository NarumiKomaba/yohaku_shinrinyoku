'use strict';
// キー無し（GEMINI_API_KEY=''）でも /api/checkin/parse は 200 + keywordCheckin フォールバック
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./_helper');

h.setupEnv({ key: '' });
let srv;
before(async () => { srv = await h.startServer(); });
after(async () => { await srv.close(); });

test('checkinParse_withoutApiKey_fallsBackToKeywords', async () => {
  const s = await h.newSession(srv.base);
  const r = await h.api(srv.base, 'POST', '/api/checkin/parse', { headers: s.headers, body: { transcript: '元気です。自然を感じたい。20分で', lang: 'ja' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.fallback, true);
  assert.equal(r.json.state, 'ok');
  assert.equal(r.json.desire, 'nature');
  assert.equal(r.json.durationMin, 20);
  assert.deepEqual(r.json.missing, []);
});
