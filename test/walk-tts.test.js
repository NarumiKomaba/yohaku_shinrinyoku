'use strict';
// Gemini の音声合成（/api/tts）。fetch は googleapis 宛のみスタブ。実 Gemini は呼ばない
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./_helper');

const dir = h.setupEnv({ key: 'test-key-not-real', extraEnv: { TTS_MAX_PER_SESSION: '2' } });
let srv;
before(async () => { srv = await h.startServer(); });
after(async () => { globalThis.fetch = h.realFetch; await srv.close(); });

const PCM = Buffer.alloc(480, 1);
function stubTts(mode = 'ok') {
  const state = { calls: 0, bodies: [], urls: [] };
  globalThis.fetch = async (url, opts) => {
    if (!/googleapis\.com/.test(String(url))) return h.realFetch(url, opts);
    state.calls++;
    state.urls.push(String(url));
    state.bodies.push(JSON.parse(opts.body));
    if (mode === 'error') return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 });
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: PCM.toString('base64') } }] } }],
      usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 100 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return state;
}
const post = (sess, text) => h.api(srv.base, 'POST', '/api/tts', { headers: sess.headers, body: { text, lang: 'ja' } });

test('config_withKeyAndTtsLimit_reportsTtsTrue', async () => {
  const r = await h.api(srv.base, 'GET', '/api/config');
  assert.equal(r.json.tts, true);
});

test('tts_withText_returnsWavAndLogsUsage', async () => {
  const sess = await h.newSession(srv.base);
  const stub = stubTts();
  const r = await post(sess, 'こんにちは。');
  assert.equal(r.status, 200);
  assert.equal(r.json.mime, 'audio/wav');
  const wav = Buffer.from(r.json.audio, 'base64');
  assert.equal(wav.length, 44 + PCM.length);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.deepEqual(stub.bodies[0].generationConfig.responseModalities, ['AUDIO']);
  assert.equal(stub.bodies[0].generationConfig.thinkingConfig, undefined);
  assert.match(stub.urls[0], /tts/);
  const ev = (await h.readEvents(dir)).find((e) => e.type === 'llm_usage' && e.purpose === 'tts');
  assert.ok(ev && ev.costJpy > 0);
});

test('tts_withEmptyText_returns400', async () => {
  const sess = await h.newSession(srv.base);
  const r = await post(sess, '   ');
  assert.equal(r.status, 400);
});

test('tts_overSessionLimit_returnsFallbackWithoutCallingGemini', async () => {
  const sess = await h.newSession(srv.base);
  const stub = stubTts();
  await post(sess, 'ひとつめ。');
  await post(sess, 'ふたつめ。');
  const r = await post(sess, 'みっつめ。');
  assert.equal(r.status, 200);
  assert.equal(r.json.fallback, true);
  assert.equal(stub.calls, 2);
});

test('tts_whenGeminiFails_returnsFallbackAndLogsError', async () => {
  const sess = await h.newSession(srv.base);
  stubTts('error');
  const r = await post(sess, 'だめでした。');
  assert.equal(r.json.fallback, true);
  assert.ok((await h.readEvents(dir)).some((e) => e.type === 'error' && e.where === 'llm-tts'));
});

test('tts_withoutSession_isRejected', async () => {
  const r = await h.api(srv.base, 'POST', '/api/tts', { body: { text: 'a' } });
  assert.ok([401, 403].includes(r.status));
});
