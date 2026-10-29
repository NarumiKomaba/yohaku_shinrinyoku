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

test('speak_withFetchAudio_failure_fallsBackToSpeechSynthesis', async () => {
  spokenByUtterance.length = 0;
  const v = new Voice();
  v.fetchAudio = async () => { throw new Error('503'); };
  const ok = await v.speak('こんにちは。');
  assert.equal(ok, true);
  assert.deepEqual(spokenByUtterance, ['こんにちは。']);
  // 失敗した直後は Gemini の音声を試さない
  let called = 0;
  v.fetchAudio = async () => { called++; return null; };
  await v.speak('もう一度。');
  assert.equal(called, 0);
});
