'use strict';
// 体験中の API に大きなデータを入れて、LLM に渡すトークンを増やされないこと
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./_helper');

h.setupEnv({ key: 'test-key-not-real' });
let srv;
before(async () => { srv = await h.startServer(); });
after(async () => { await srv.close(); });

const BIG = 'あ'.repeat(5000);

test('ask_withHugeCheckinAndOddHistory_clipsWhatIsSentToLlm', async () => {
  const stub = h.stubGemini(() => 'ここは黒松の広場です。');
  const s = await h.newSession(srv.base);
  const r = await h.api(srv.base, 'POST', '/api/ask', { headers: s.headers, body: {
    question: 'ここはどこ？', lang: 'fr', spotId: 't1',
    checkin: { state: BIG, desire: BIG, note: BIG, extra: BIG },
    history: 'not-an-array',
  } });
  assert.equal(r.status, 200);
  const sent = JSON.stringify(stub.bodies[0]);
  assert.ok(!sent.includes('あ'.repeat(201)), 'チェックインの文字列は切り詰める');
  assert.match(stub.bodies[0].systemInstruction.parts[0].text, /Answer in Japanese/, '知らない言語は日本語にする');
  assert.equal(stub.bodies[0].contents.length, 1, '配列でない history は無視する');
});

test('checkinParse_withHugeCurrent_sendsOnlyKnownClippedFields', async () => {
  const stub = h.stubGemini(() => JSON.stringify({ state: 'ok', desire: 'nature', durationMin: 40, note: null, confirmText: 'よろしいですか？' }));
  const s = await h.newSession(srv.base);
  const r = await h.api(srv.base, 'POST', '/api/checkin/parse', { headers: s.headers, body: {
    lang: 'ja', transcript: '元気です。木を見たい。40分',
    current: { state: BIG, note: BIG, junk: BIG },
  } });
  assert.equal(r.status, 200);
  const payload = JSON.parse(stub.bodies[0].contents[0].parts[0].text);
  assert.deepEqual(Object.keys(payload.current).sort(), ['desire', 'note', 'state']);
  assert.ok(payload.current.note.length <= 200);
});

test('narrate_withBodyOver64KB_isRejected', async () => {
  h.stubGemini(() => '{}');
  const s = await h.newSession(srv.base);
  const r = await h.api(srv.base, 'POST', '/api/narrate', { headers: s.headers, body: { trigger: 'arrive', spotId: 't1', pad: 'x'.repeat(70_000) } })
    .catch(() => ({ status: 'reset' }));
  assert.ok(r.status === 413 || r.status === 'reset', String(r.status));
});
