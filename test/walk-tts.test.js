'use strict';
// Gemini の音声合成（/api/tts）。fetch は googleapis 宛だけスタブし、実 Gemini は呼ばない
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./_helper');

h.setupEnv({ key: 'test-key-not-real', extraEnv: { TTS_MAX_PER_SESSION: '2' } });
let srv;
before(async () => { srv = await h.startServer(); });
beforeEach(() => { require('../routes/walk')._test.clearTtsCache(); });
after(async () => { await srv.close(); globalThis.fetch = h.realFetch; });

const PCM = Buffer.alloc(480, 1);
function stubAudio(respond) {
  const state = { bodies: [], urls: [] };
  globalThis.fetch = async (url, opts) => {
    if (!/googleapis\.com/.test(String(url))) return h.realFetch(url, opts);
    state.bodies.push(JSON.parse(opts.body));
    state.urls.push(String(url));
    return respond();
  };
  return state;
}
const okAudio = () => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: PCM.toString('base64') } }] } }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 50 },
}), { status: 200, headers: { 'Content-Type': 'application/json' } });
const post = (sess, body) => h.api(srv.base, 'POST', '/api/tts', { headers: sess.headers, body });

test('tts_withText_returnsWavFromGeminiAudio', async () => {
  const sess = await h.newSession(srv.base);
  const stub = stubAudio(okAudio);
  const r = await post(sess, { text: 'こんにちは。' });
  assert.equal(r.status, 200);
  assert.equal(r.json.mimeType, 'audio/wav');
  const wav = Buffer.from(r.json.data, 'base64');
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.length, 44 + PCM.length);
  assert.deepEqual(stub.bodies[0].generationConfig.responseModalities, ['AUDIO']);
  assert.equal(stub.bodies[0].generationConfig.speechConfig.voiceConfig.voice, 'Kore');
  assert.match(stub.urls[0], /gemini-3\.8-flash-tts/);
  const part = stub.bodies[0].contents[0].parts[0];
  assert.equal(part.text, 'こんにちは。');
  assert.match(part.speech_metadata.style, /calm/);
});

test('tts_generationConfig_hasOnlyModalitiesAndSpeechConfig', async () => {
  const sess = await h.newSession(srv.base);
  const stub = stubAudio(okAudio);
  await post(sess, { text: 'こんにちは。' });
  assert.deepEqual(Object.keys(stub.bodies[0].generationConfig).sort(), ['responseModalities', 'speechConfig']);
});

test('tts_whenGeminiReturnsWav_passesItThrough', async () => {
  const sess = await h.newSession(srv.base);
  const wavIn = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(40, 2)]);
  stubAudio(() => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: wavIn.toString('base64') } }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 50 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const r = await post(sess, { text: 'こんにちは。' });
  assert.deepEqual(Buffer.from(r.json.data, 'base64'), wavIn);
});

test('tts_usage_isCountedAtTtsPriceAsTtsPurpose', async () => {
  const { costJpy } = require('../lib/gemini');
  const usage = { inputTokens: 1000, outputTokens: 25000 };
  const tts = costJpy(usage, 'tts', Date.parse('2026-11-01T00:00:00Z'));
  assert.ok(Math.abs(tts - ((1000 * 0.5 + 25000 * 9) / 1e6) * 150) < 1e-9);
  assert.ok(costJpy(usage, 'tts', Date.parse('2027-01-02T00:00:00Z')) > tts * 1.9);
  assert.ok(costJpy(usage, 'narrate') < tts);
});

test('tts_whenGeminiFails_returns503', async () => {
  const sess = await h.newSession(srv.base);
  stubAudio(() => new Response('{}', { status: 500 }));
  const r = await post(sess, { text: 'こんにちは。' });
  assert.equal(r.status, 503);
});

test('tts_withoutSessionOrText_isRejected', async () => {
  const sess = await h.newSession(srv.base);
  assert.equal((await post(sess, { text: '  ' })).status, 400);
  assert.equal((await h.api(srv.base, 'POST', '/api/tts', { body: { text: 'a' } })).status, 401);
});

test('tts_overSessionLimit_returns429', async () => {
  const sess = await h.newSession(srv.base);
  stubAudio(okAudio);
  assert.equal((await post(sess, { text: 'a。' })).status, 200);
  assert.equal((await post(sess, { text: 'b。' })).status, 200);
  assert.equal((await post(sess, { text: 'c。' })).status, 429);
});

test('tts_dailyQuota_isSeparateFromConversationQuota', () => {
  const g = require('../lib/gemini');
  g._test.resetDaily();
  // 音声の上限（TTS_DAILY_MAX）を使い切っても、会話の枠は減らない
  for (let i = 0; i < 3000; i++) assert.equal(g._test.takeTtsQuota(), true);
  assert.equal(g._test.takeTtsQuota(), false);
  assert.equal(g._test.takeDailyQuota(), true);
  g._test.resetDaily();
});

test('tts_sameTextTwice_reusesAudioWithoutCallingGeminiOrCounting', async () => {
  const sess = await h.newSession(srv.base);
  const stub = stubAudio(okAudio);
  const a = await post(sess, { text: 'おはようございます。' });
  const b = await post(sess, { text: 'おはようございます。' });
  const c = await post(sess, { text: 'おはようございます。' });
  assert.equal(stub.bodies.length, 1);
  assert.deepEqual(b.json, a.json);
  assert.deepEqual(c.json, a.json);
  // 使い回しは 1 人あたりの回数（上限 2）に入らない：違う文があと 1 回作れる
  assert.equal((await post(sess, { text: 'ちがう文。' })).status, 200);
  assert.equal(stub.bodies.length, 2);
  assert.equal((await post(sess, { text: 'さらに別の文。' })).status, 429);
  assert.equal((await post(sess, { text: 'おはようございます。' })).status, 200);
});

test('tts_reusedAudio_doesNotWriteUsageOrTakeDailyQuota', async () => {
  const g = require('../lib/gemini');
  g._test.resetDaily();
  const sess = await h.newSession(srv.base);
  stubAudio(okAudio);
  await post(sess, { text: '使い回しの文。' });
  for (let i = 0; i < 2999; i++) g._test.takeTtsQuota(); // 1 日の枠を残り 0 に
  assert.equal(g._test.takeTtsQuota(), false);
  assert.equal((await post(sess, { text: '使い回しの文。' })).status, 200); // 当たれば枠がなくても返る
  assert.equal((await post(sess, { text: '新しい文。' })).status, 503); // 作り直しは枠が要る
  g._test.resetDaily();
});

test('tts_cacheKey_differsByText', async () => {
  const sess = await h.newSession(srv.base);
  const stub = stubAudio(okAudio);
  await post(sess, { text: 'あ。' });
  await post(sess, { text: 'い。' });
  assert.equal(stub.bodies.length, 2);
});

test('tts_failedAudio_isNotCached', async () => {
  const sess = await h.newSession(srv.base);
  stubAudio(() => new Response('{}', { status: 500 }));
  assert.equal((await post(sess, { text: '失敗する文。' })).status, 503);
  assert.equal(require('../routes/walk')._test.ttsCacheStats().entries, 0);
});

test('tts_cacheOverEntryLimit_evictsOldestFirst', async () => {
  const t = require('../routes/walk')._test;
  const big = { entries: 200, bytes: 32 * 1024 * 1024 };
  t.setTtsCacheLimits({ entries: 2 });
  try {
    const sess = await h.newSession(srv.base);
    const stub = stubAudio(okAudio);
    for (const x of ['A。', 'B。', 'C。']) await h.api(srv.base, 'POST', '/api/tts', { headers: (await h.newSession(srv.base)).headers, body: { text: x } });
    assert.equal(stub.bodies.length, 3);
    assert.equal(t.ttsCacheStats().entries, 2);
    await post(sess, { text: 'C。' }); // 残っている
    assert.equal(stub.bodies.length, 3);
    await post(sess, { text: 'A。' }); // いちばん古いので消えている
    assert.equal(stub.bodies.length, 4);
  } finally { t.setTtsCacheLimits(big); }
});

test('tts_cacheOverByteLimit_evictsOldestUntilUnderLimit', async () => {
  const t = require('../routes/walk')._test;
  const big = { entries: 200, bytes: 32 * 1024 * 1024 };
  const wavB64 = Math.ceil((44 + PCM.length) / 3) * 4;
  t.setTtsCacheLimits({ bytes: wavB64 * 2 + 1 }); // 2 件ぶんまで
  try {
    stubAudio(okAudio);
    for (const x of ['A。', 'B。', 'C。']) await h.api(srv.base, 'POST', '/api/tts', { headers: (await h.newSession(srv.base)).headers, body: { text: x } });
    const st = t.ttsCacheStats();
    assert.equal(st.entries, 2);
    assert.ok(st.bytes <= wavB64 * 2 + 1);
  } finally { t.setTtsCacheLimits(big); }
});
