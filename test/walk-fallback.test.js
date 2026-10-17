'use strict';
// キー無し（LLM 未設定）での /api/narrate /api/ask のフォールバック動作
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./_helper');

const dir = h.setupEnv({ key: '' });
let srv;
let sess;
before(async () => { srv = await h.startServer(); sess = await h.newSession(srv.base); });
after(async () => { await srv.close(); });

const narrate = (over = {}, headers = sess.headers) => h.api(srv.base, 'POST', '/api/narrate', {
  headers,
  body: { lang: 'ja', checkin: { state: 'ok', desire: 'nature' }, trigger: 'arrive', spotId: 't1', motion: { speedMps: 0.5 }, spokenMaterialIds: [], ...over },
});

test('narrate_withoutSession_returns401', async () => {
  assert.equal((await narrate({}, {})).status, 401);
  assert.equal((await narrate({}, { 'X-Session-Token': 'bogus' })).status, 401);
});

test('narrate_withoutLlm_fallsBackToMustFirst', async () => {
  const r = await narrate();
  assert.equal(r.status, 200);
  assert.equal(r.json.fallback, true);
  assert.deepEqual(r.json.usedMaterialIds, ['t1-must']);
  assert.equal(r.json.say, '足元に注意してください。');
  assert.equal(r.json.ask, null);
  assert.equal(r.json.next, 'wait');
});

test('narrate_fallback_followsMustFactSenseOrder', async () => {
  const r2 = await narrate({ spokenMaterialIds: ['t1-must'] });
  assert.deepEqual(r2.json.usedMaterialIds, ['t1-fact']);
  const r3 = await narrate({ spokenMaterialIds: ['t1-must', 't1-fact'] });
  assert.deepEqual(r3.json.usedMaterialIds, ['t1-sense']);
  const r4 = await narrate({ spokenMaterialIds: ['t1-must', 't1-fact', 't1-sense'] });
  assert.equal(r4.json.say, '');
  assert.deepEqual(r4.json.usedMaterialIds, []);
});

test('narrate_fallback_excludesOtherLanguageMaterials', async () => {
  const ja = await narrate({ lang: 'ja' });
  assert.ok(!ja.json.usedMaterialIds.includes('t1-en'));
  const en = await narrate({ lang: 'en' });
  assert.deepEqual(en.json.usedMaterialIds, ['t1-en']);
  assert.equal(en.json.say, 'Watch your step.');
  const enNext = await narrate({ lang: 'en', spokenMaterialIds: ['t1-en'] });
  assert.equal(enNext.json.say, '', 'en には他に素材が無い（ja 素材を出さない）');
});

test('narrate_fallback_limitsSentences_3Normal_2WhenFast', async () => {
  const slow = await narrate({ spokenMaterialIds: ['t1-must'], motion: { speedMps: 1.0 } });
  assert.equal(slow.json.say, '一つ目の事実です。二つ目の事実です。三つ目の事実です。');
  const fast = await narrate({ spokenMaterialIds: ['t1-must'], motion: { speedMps: 2.5 } });
  assert.equal(fast.json.say, '一つ目の事実です。二つ目の事実です。');
});

test('narrate_fallback_replyNext_returnsMoveOn', async () => {
  const r = await narrate({ trigger: 'reply', userReply: { optionId: 'next' } });
  assert.equal(r.json.next, 'move_on');
  assert.equal(r.json.say, '');
});

test('narrate_fallback_betweenOrUnknownSpot_isSilent', async () => {
  const b = await narrate({ trigger: 'between', spotId: null });
  assert.equal(b.json.say, '');
  assert.equal(b.json.fallback, true);
  const u = await narrate({ spotId: 'does-not-exist' });
  assert.equal(u.status, 200);
  assert.equal(u.json.say, '');
});

test('narrate_withGarbageBody_stillReturnsValidShape', async () => {
  const r = await h.api(srv.base, 'POST', '/api/narrate', { headers: sess.headers, body: { lang: 'zz', trigger: 'bogus', spokenMaterialIds: 'x', motion: 5, history: 'no' } });
  assert.equal(r.status, 200);
  for (const k of ['say', 'ask', 'next', 'interaction', 'silenceSec', 'usedMaterialIds', 'fallback']) assert.ok(k in r.json, k);
});

test('narrate_fallback_logsNarrateEventWithFallbackTrue', async () => {
  const s = await h.newSession(srv.base);
  await narrate({}, s.headers);
  const ev = h.readEvents(dir).filter((e) => e.type === 'narrate' && e.sessionId === s.sessionId);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].fallback, true);
  assert.equal(ev[0].spotId, 't1');
  assert.equal(ev[0].trigger, 'arrive');
});

test('ask_withoutSession_returns401', async () => {
  assert.equal((await h.api(srv.base, 'POST', '/api/ask', { body: { question: 'x' } })).status, 401);
});

test('ask_withEmptyQuestion_returns400', async () => {
  const r = await h.api(srv.base, 'POST', '/api/ask', { headers: sess.headers, body: { question: '   ' } });
  assert.equal(r.status, 400);
});

test('ask_withoutLlm_returnsFallbackAnswer', async () => {
  const r = await h.api(srv.base, 'POST', '/api/ask', { headers: sess.headers, body: { question: 'ここはどんな場所ですか', lang: 'ja', spotId: 't1' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.fallback, true);
  assert.equal(typeof r.json.answer, 'string');
  assert.ok(r.json.answer.length > 0);
  assert.ok(Array.isArray(r.json.sources));
});

test('ask_fallbackEnglish_returnsEnglishText', async () => {
  const r = await h.api(srv.base, 'POST', '/api/ask', { headers: sess.headers, body: { question: 'zzzqqq', lang: 'en' } });
  assert.doesNotMatch(r.json.answer, /[぀-ヿ一-鿿]/, '英語で返る（知識が季節で一致する場合も英語）');
});

// ---------- reply で新しい素材が尽きたとき ----------
test('narrate_fallback_replyWithNoMaterialsLeft_saysEndLineAndMovesOn', async () => {
  const all = ['t1-must', 't1-fact', 't1-sense'];
  const ja = await narrate({ trigger: 'reply', userReply: { optionId: 'more' }, spokenMaterialIds: all });
  assert.equal(ja.json.say, 'この場所のお話は、ここまでです。');
  assert.equal(ja.json.next, 'move_on');
  assert.equal(ja.json.fallback, true);
  assert.deepEqual(ja.json.usedMaterialIds, []);
  const en = await narrate({ lang: 'en', trigger: 'reply', userReply: { optionId: 'more' }, spokenMaterialIds: ['t1-en'] });
  assert.equal(en.json.say, 'That is all I have to share about this place.');
  assert.equal(en.json.next, 'move_on');
});

test('narrate_fallback_replyWithMaterialsLeft_stillSpeaksMaterial_notEndLine', async () => {
  const r = await narrate({ trigger: 'reply', userReply: { optionId: 'more' }, spokenMaterialIds: ['t1-must'] });
  assert.equal(r.json.say.startsWith('一つ目の事実'), true);
  assert.equal(r.json.next, 'wait');
});

test('narrate_fallback_lingerWithNoMaterialsLeft_isSilentWithoutEndLine', async () => {
  const r = await narrate({ trigger: 'linger', spokenMaterialIds: ['t1-must', 't1-fact', 't1-sense'] });
  assert.equal(r.json.say, '');
  assert.equal(r.json.next, 'wait');
});
