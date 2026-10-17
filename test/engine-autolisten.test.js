'use strict';
// WalkEngine の自動聞き取り（区切りで数秒だけマイクを開く）と、app.js の rateCommand（純関数を抽出して検証）
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const scenario = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'scenario.json'), 'utf8'));
const M_PER_DEG = 111195;

let WalkEngine;
before(async () => {
  globalThis.window = globalThis.window || {};
  ({ WalkEngine } = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'engine.js')).href));
});

const A = { id: 'A', order: 1, enabled: true, name: { ja: 'A', en: 'A' }, lat: 35.68, lng: 139.756, radius: 40, materials: [{ id: 'A-fact', type: 'fact', lang: 'ja', text: 'A の事実です。' }] };
const B = { id: 'B', order: 2, enabled: true, name: { ja: 'B', en: 'B' }, lat: 35.68 + 300 / M_PER_DEG, lng: 139.756, radius: 40, materials: [{ id: 'B-fact', type: 'fact', lang: 'ja', text: 'B の事実です。' }] };
const at = (s) => [s.lat, s.lng, 5];

// listen() は保留され、test が heard() で解決するか、stopListening() で '' になる（実 voice と同じ）
class FakeVoice {
  constructor({ canListen = true } = {}) {
    this.spoken = []; this.canListen = canListen; this.listens = 0; this.stops = 0; this._l = null; this.failListen = false; this.pauses = [];
  }
  speak(t) { this.spoken.push(t); return Promise.resolve(true); }
  cancel() {}
  listen() {
    this.listens++;
    if (this.failListen) return Promise.reject(new Error(this.failListen === true ? 'stt_not-allowed' : this.failListen));
    return new Promise((res) => { this._l = res; });
  }
  pause(ms) { this.pauses.push(ms); return Promise.resolve(true); }
  stopListening() { this.stops++; this.heard(''); }
  heard(text) { const r = this._l; this._l = null; if (r) r(text); }
}

const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };
const say = (text, extra = {}) => ({ say: text, ask: null, next: 'wait', interaction: null, silenceSec: null, usedMaterialIds: [], ...extra });
const ASK = { text: '先へ？', options: [{ id: 'more', label: 'a' }, { id: 'next', label: 'b' }], defaultId: 'next' };

function setup(t, { handler, settings, canListen = true } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let clock = 9_000_000;
  const voice = new FakeVoice({ canListen });
  const logs = [];
  const events = [];
  const engine = new WalkEngine({
    voice, scenario, spots: [A, B], lang: 'ja', checkin: { state: 'ok', desire: 'nature' }, settings,
    narrate: async (p) => (handler ? handler(p) : say('一言です。')), now: () => clock, log: (type, d) => logs.push({ type, ...d }),
  });
  for (const ev of ['listen', 'heard']) engine.addEventListener(ev, (e) => events.push({ type: ev, ...e.detail }));
  const advance = async (ms) => { clock += ms; t.mock.timers.tick(ms); await flush(); };
  t.after(() => engine.abort());
  const listenOn = () => events.filter((e) => e.type === 'listen' && e.on).length;
  const heard = () => events.filter((e) => e.type === 'heard');
  return { engine, voice, logs, events, advance, listenOn, heard };
}

// 冒頭あいさつの後に listen step があるため、まずそれを終わらせて計数を 0 に戻す
async function begin(c) {
  c.engine.start();
  await flush();
  c.voice.heard('');
  await flush();
  c.events.length = 0;
  c.voice.listens = 0;
  c.voice.stops = 0;
}

async function enterA(c) {
  await begin(c);
  c.engine.onPosition(...at(A));
  await flush();
}

test('autoListen_afterOpeningGreeting_opensMicOnce', async (t) => {
  const c = setup(t);
  c.engine.start();
  await flush();
  const expected = [...scenario.opening.ja, scenario.checkin.states.find((s) => s.id === 'ok').cue.ja];
  assert.deepEqual(c.voice.spoken, expected);
  assert.equal(c.listenOn(), 1, 'あいさつが終わったら聞く');
  assert.equal(c.engine.queue[0].kind, 'listen');
  c.voice.heard('よろしくお願いします');
  await flush();
  assert.equal(c.heard().length, 1);
  assert.equal(c.engine.queue.length, 0);
});

test('autoListen_afterOpening_isSkippedWhenDisabled', async (t) => {
  const c = setup(t, { settings: { autoListen: false } });
  c.engine.start();
  await flush();
  assert.equal(c.voice.listens, 0);
  assert.equal(c.engine.queue.length, 0);
});

test('autoListen_afterSpotNarration_opensMicAndEmitsHeard', async (t) => {
  const c = setup(t);
  await enterA(c);
  assert.equal(c.listenOn(), 1);
  assert.equal(c.voice.listens, 1);
  c.voice.heard('この松について教えて');
  await flush();
  assert.deepEqual(c.heard().map((e) => e.text), ['この松について教えて']);
  assert.equal(c.events.filter((e) => e.type === 'listen').at(-1).on, false);
  assert.ok(c.logs.some((l) => l.type === 'stt_used' && l.purpose === 'auto' && l.ok === true));
});

test('autoListen_withoutSpeech_stopsAfter4sAndEmitsNoHeard', async (t) => {
  const c = setup(t);
  await enterA(c);
  await c.advance(3_500);
  assert.equal(c.voice.stops, 0);
  await c.advance(700);
  assert.equal(c.voice.stops, 1);
  assert.equal(c.heard().length, 0);
  assert.equal(c.events.filter((e) => e.type === 'listen').at(-1).on, false);
});

test('autoListen_underTwoChars_isIgnored', async (t) => {
  const c = setup(t);
  await enterA(c);
  c.voice.heard('あ');
  await flush();
  assert.equal(c.heard().length, 0);
});

test('autoListen_exactlyTwoChars_isAccepted', async (t) => {
  const c = setup(t);
  await enterA(c);
  c.voice.heard('はい');
  await flush();
  assert.equal(c.heard().length, 1);
});

test('autoListen_whenNarrationSaysNothing_doesNotOpenMic', async (t) => {
  const c = setup(t, { handler: () => say('') });
  await enterA(c);
  assert.equal(c.listenOn(), 0);
});

test('autoListen_whenAskFollows_doesNotOpenAutoListen', async (t) => {
  const c = setup(t, { handler: () => say('松です。', { ask: ASK }) });
  await enterA(c);
  assert.equal(c.listenOn(), 0, 'ask の返事待ちは別経路（自動聞き取りではない）');
  assert.equal(c.engine.status, 'asking');
  assert.ok(!c.logs.some((l) => l.type === 'stt_used' && l.purpose === 'auto'));
});

test('autoListen_whenInteractionFollows_opensMicOnlyAfterItEnds', async (t) => {
  const c = setup(t, { handler: () => say('見てみましょう。', { next: 'interaction', interaction: 'LOOK' }) });
  await enterA(c);
  assert.equal(c.listenOn(), 0, '指示の前・最中には聞かない');
  await c.advance(19_000);
  assert.equal(c.listenOn(), 0);
  await c.advance(1_500); // LOOK は 20 秒
  assert.equal(c.listenOn(), 1, '終わりの一言の後に聞く');
});

test('autoListen_whenSilenceFollows_waitsUntilSilenceEnds', async (t) => {
  const c = setup(t, { handler: () => say('静かにしましょう。', { next: 'silence', silenceSec: 20 }) });
  await enterA(c);
  assert.equal(c.listenOn(), 0, '静けさの前には聞かない');
  assert.equal(c.engine.status, 'silence');
  await c.advance(20_500);
  assert.ok(c.voice.spoken.includes(scenario.silenceEnd.ja), '静けさ明けの一言');
  assert.equal(c.listenOn(), 1, '静けさ明けに聞く');
  c.voice.heard('戻りました、ありがとう');
  await flush();
  assert.equal(c.heard().length, 1);
});

test('autoListen_whenPausedWhileListening_ignoresLateSpeech', async (t) => {
  const c = setup(t);
  await enterA(c);
  c.engine.pause();
  c.voice.heard('一時停止中の声');
  await flush();
  assert.equal(c.heard().length, 0);
});

test('autoListen_whenFreeQuestionStartsWhileListening_ignoresLateSpeech', async (t) => {
  const c = setup(t);
  await enterA(c);
  c.engine.beginTalk();
  c.voice.heard('質問中の声');
  await flush();
  assert.equal(c.heard().length, 0);
});

test('autoListen_directCall_whenPausedTalkingEndedOrClosing_doesNotOpenMic', async (t) => {
  const c = setup(t);
  await begin(c);
  for (const flag of ['paused', 'talking', 'ended', 'closing']) {
    c.engine[flag] = true;
    await c.engine._autoListen();
    c.engine[flag] = false;
  }
  assert.equal(c.voice.listens, 0);
});

test('autoListen_whenMicUnavailable_isNotTriedAgain', async (t) => {
  const c = setup(t);
  await begin(c);
  c.voice.failListen = true; // not-allowed
  c.engine.onPosition(...at(A));
  await flush();
  assert.equal(c.voice.listens, 1);
  assert.equal(c.engine.settings.autoListen, false);
  assert.ok(c.logs.some((l) => l.type === 'error' && l.where === 'stt-auto'));
  c.engine.onPosition(...at(B)); // 次の Spot でも試さない
  await flush();
  assert.ok(c.voice.spoken.includes('一言です。'));
  assert.equal(c.voice.listens, 1);
});

test('autoListen_transientSttErrors_doNotDisableAutoListen', async (t) => {
  for (const msg of ['stt_no-speech', 'stt_aborted', 'stt_network']) {
    const c = setup(t);
    await begin(c);
    c.voice.failListen = msg;
    c.engine.onPosition(...at(A));
    await flush();
    assert.equal(c.engine.settings.autoListen, true, msg);
    c.voice.failListen = false;
    c.engine.onPosition(...at(B));
    await flush();
    assert.equal(c.voice.listens, 2, `${msg} のあとも次の区切りで聞く`);
    c.engine.abort();
    t.mock.timers.reset();
  }
});

test('autoListen_whenVoiceCannotListen_neverOpens', async (t) => {
  const a = setup(t, { canListen: false });
  await enterA(a);
  assert.equal(a.listenOn(), 0);
});

test('autoListen_whenSettingOff_neverOpens', async (t) => {
  const b = setup(t, { settings: { autoListen: false } });
  await enterA(b);
  assert.equal(b.listenOn(), 0);
  assert.equal(b.voice.listens, 0);
});

test('autoListen_whenFinishCalledWhileListening_stopsTheMic', async (t) => {
  const c = setup(t);
  await enterA(c);
  c.engine.finish();
  await flush();
  assert.ok(c.voice.stops >= 1);
  assert.equal(c.heard().length, 0);
});

// ---------- rateCommand（public/js/commands.js）----------
async function loadRateCommand() {
  return (await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'commands.js')).href)).rateCommand;
}

test('rateCommand_slowerPhrases_returnMinus1', async () => {
  const r = await loadRateCommand();
  for (const t of ['もう少しゆっくり話して', 'ゆっくりしゃべってください', '遅く話して', '話すのをゆっくりにして', 'Please speak slower', 'can you talk slowly']) assert.equal(r(t), -1, t);
});

test('rateCommand_fasterPhrases_returnPlus1', async () => {
  const r = await loadRateCommand();
  for (const t of ['早く話して', '速くしゃべって', '早口でお願い', '話すのを早めにして', 'speak faster', 'please talk fast', 'speed up']) assert.equal(r(t), 1, t);
});

test('rateCommand_ordinaryQuestions_returnZero', async () => {
  const r = await loadRateCommand();
  for (const t of ['この木の名前は何ですか', 'ゆっくり歩いてもいいですか', '早く着きたい', '', null, undefined, 'What tree is this?', 'slow walk is nice']) assert.equal(r(t), 0, String(t));
});
