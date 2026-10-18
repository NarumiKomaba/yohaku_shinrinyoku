'use strict';
// voice.js の speak（文間の間）と cancel。speechSynthesis は偽物。
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const spokenByUtterance = [];
const fakeSynth = {
  getVoices: () => [],
  cancel() {},
  speak(u) { spokenByUtterance.push(u.text); setImmediate(() => u.onend && u.onend()); },
};
globalThis.window = { speechSynthesis: fakeSynth };
globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };

let Voice;
before(async () => {
  ({ Voice } = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'voice.js')).href));
});

const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };

test('speak_betweenSentences_waits700msBeforeNext', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  spokenByUtterance.length = 0;
  const v = new Voice();
  assert.equal(v.sentencePauseMs, 700);
  let result;
  const p = v.speak('一文目です。二文目です。三文目です。').then((r) => { result = r; });
  await flush();
  assert.deepEqual(spokenByUtterance, ['一文目です。']);
  t.mock.timers.tick(699);
  await flush();
  assert.deepEqual(spokenByUtterance, ['一文目です。'], '700ms 経つまで次を読まない');
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(spokenByUtterance, ['一文目です。', '二文目です。']);
  t.mock.timers.tick(700);
  await flush();
  assert.deepEqual(spokenByUtterance, ['一文目です。', '二文目です。', '三文目です。']);
  await p;
  assert.equal(result, true, '最後の文のあとには間を置かず完了');
});

test('speak_singleSentence_completesWithoutTimers', async () => {
  spokenByUtterance.length = 0;
  const v = new Voice();
  assert.equal(await v.speak('一文だけです。'), true);
});

test('speak_withCustomSentencePauseMs_isUsed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  spokenByUtterance.length = 0;
  const v = new Voice();
  v.sentencePauseMs = 100;
  v.speak('一。二。');
  await flush();
  t.mock.timers.tick(100);
  await flush();
  assert.equal(spokenByUtterance.length, 2);
});

test('cancel_duringSentencePause_resolvesSpeakFalseAndStopsFurtherSentences', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  spokenByUtterance.length = 0;
  const v = new Voice();
  const p = v.speak('一文目です。二文目です。');
  await flush();
  assert.equal(spokenByUtterance.length, 1);
  v.cancel();
  assert.equal(await p, false);
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(spokenByUtterance.length, 1, '二文目は読まれない');
});

test('pause_resolvesTrueAfterDelay_andFalseOnCancel', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const v = new Voice();
  let a;
  v.pause(1200).then((r) => { a = r; });
  t.mock.timers.tick(1199);
  await flush();
  assert.equal(a, undefined);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(a, true);
  let b;
  v.pause(1200).then((r) => { b = r; });
  v.cancel();
  await flush();
  assert.equal(b, false);
});

test('speak_emptyText_resolvesTrueImmediately', async () => {
  const v = new Voice();
  assert.equal(await v.speak(''), true);
});

test('speak_whenRemoteFetchFails_fallsBackToBrowserVoice', async () => {
  spokenByUtterance.length = 0;
  const v = new Voice();
  v.remote = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ fallback: true }), { status: 200 });
  try {
    const ok = await v.speak('こんにちは。');
    assert.equal(ok, true);
    assert.deepEqual(spokenByUtterance, ['こんにちは。']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('speak_afterThreeRemoteFailures_stopsUsingRemote', async () => {
  const v = new Voice();
  v.remote = true;
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ fallback: true }), { status: 200 }); };
  try {
    for (let i = 0; i < 4; i++) await v.speak('あ。');
    assert.equal(v.remote, false);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
});
