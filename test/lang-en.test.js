'use strict';
// 英語を選んだとき、narrate / ask / TTS に en が渡り、記録にも残ること。ja と en の文のキーがそろっていること
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./_helper');

const dir = h.setupEnv({ key: 'test-key-not-real', extraEnv: { TTS_MAX_PER_SESSION: '5' } });
let srv;
before(async () => { srv = await h.startServer(); });
beforeEach(() => { require('../routes/walk')._test.clearTtsCache(); });
after(async () => { await srv.close(); globalThis.fetch = h.realFetch; });

const keysOf = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keysOf(v, `${p}${k}.`) : [`${p}${k}`]));

test('i18n_jaAndEn_haveSameKeys', async () => {
  const { STRINGS } = await import('../public/js/i18n.js');
  assert.deepEqual(keysOf(STRINGS.en).sort(), keysOf(STRINGS.ja).sort());
});

test('narrate_langEn_sendsEnglishInstructionAndLogsLang', async () => {
  const sess = await h.newSession(srv.base);
  const stub = h.stubGemini(() => JSON.stringify({ say: 'This tree is big.', next: 'wait', usedMaterialIds: [] }));
  const r = await h.api(srv.base, 'POST', '/api/narrate', { headers: sess.headers, body: { lang: 'en', checkin: { state: 'ok', desire: 'nature' }, trigger: 'arrive', spotId: 't1', spokenMaterialIds: [] } });
  assert.equal(r.json.say, 'This tree is big.');
  assert.match(stub.bodies[0].systemInstruction.parts[0].text, /English/);
  assert.equal(JSON.parse(stub.bodies[0].contents[0].parts[0].text).lang, 'en');
  const ev = h.readEvents(dir).filter((e) => e.sessionId === sess.sessionId && (e.type === 'narrate' || e.purpose === 'narrate'));
  assert.ok(ev.length >= 2);
  assert.ok(ev.every((e) => e.lang === 'en'));
});

test('ask_langEn_sendsEnglishInstructionAndLogsLang', async () => {
  const sess = await h.newSession(srv.base);
  const stub = h.stubGemini(() => 'This is a pine plaza.');
  await h.api(srv.base, 'POST', '/api/ask', { headers: sess.headers, body: { question: 'Where am I?', lang: 'en', spotId: 't1' } });
  assert.match(stub.bodies[0].systemInstruction.parts[0].text, /English/);
  const ev = h.readEvents(dir).filter((e) => e.sessionId === sess.sessionId && e.purpose === 'ask');
  assert.equal(ev[0].lang, 'en');
});

test('tts_sameTextDifferentLang_isCachedPerLang', async () => {
  const sess = await h.newSession(srv.base);
  let calls = 0;
  const pcm = Buffer.alloc(480, 1).toString('base64');
  globalThis.fetch = async (url, opts) => {
    if (!/googleapis\.com/.test(String(url))) return h.realFetch(url, opts);
    calls++;
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm } }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 50 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const post = (lang) => h.api(srv.base, 'POST', '/api/tts', { headers: sess.headers, body: { text: 'OK.', lang } });
  await post('en');
  await post('en');
  assert.equal(calls, 1, '同じ言語は使い回す');
  await post('ja');
  assert.equal(calls, 2, '言語が違えば別のキャッシュ');
  const ev = h.readEvents(dir).filter((e) => e.sessionId === sess.sessionId && e.purpose === 'tts');
  assert.deepEqual(ev.map((e) => e.lang), ['en', 'ja']);
});
