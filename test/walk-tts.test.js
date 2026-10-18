'use strict';
// Gemini の音声合成（/api/tts）。fetch は googleapis 宛だけスタブし、実 Gemini は呼ばない
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./_helper');

h.setupEnv({ key: 'test-key-not-real', extraEnv: { TTS_MAX_PER_SESSION: '2' } });
let srv;
before(async () => { srv = await h.startServer(); });
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
  assert.equal(stub.bodies[0].generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
  assert.match(stub.urls[0], /gemini-2\.5-flash-preview-tts/);
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
