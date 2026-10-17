'use strict';
// WalkEngine の進行まわり: 目安時間つき interaction / Silence、activity イベント、区切りの一言、
// 次の場所の予告、一時停止での残り時間引き継ぎ、文間の間。
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
const B = { id: 'B', order: 2, enabled: true, name: { ja: 'Bの広場', en: 'B Plaza' }, lat: 35.68 + 300 / M_PER_DEG, lng: 139.756, radius: 40, materials: [{ id: 'B-fact', type: 'fact', lang: 'ja', text: 'B の事実です。' }] };
const pos = (spot, northM = 0) => [spot.lat + northM / M_PER_DEG, spot.lng, 5];

class FakeVoice {
  constructor() { this.spoken = []; this.pauses = []; this.cancels = 0; this.canListen = false; this.hold = false; this._pending = null; }
  speak(t) {
    this.spoken.push(t);
    if (!this.hold) return Promise.resolve(true);
    return new Promise((r) => { this._pending = r; });
  }
  pause(ms) { this.pauses.push(ms); return Promise.resolve(true); }
  cancel() { this.cancels++; const p = this._pending; this._pending = null; if (p) p(false); }
  stopListening() {}
}

const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };
const say = (text, extra = {}) => ({ say: text, ask: null, next: 'wait', interaction: null, silenceSec: null, usedMaterialIds: [], ...extra });

function setup(t, { handler, lang = 'ja', spots = [A, B], sc } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let clock = 7_000_000;
  const voice = new FakeVoice();
  const events = [];
  const engine = new WalkEngine({
    voice, scenario: sc || scenario, spots, lang, checkin: { state: 'ok', desire: 'nature' },
    narrate: async (p) => (handler ? handler(p) : say('')), now: () => clock, log: () => {},
  });
  for (const ev of ['activity', 'caption', 'phase', 'status']) engine.addEventListener(ev, (e) => events.push({ ev, ...e.detail }));
  const advance = async (ms) => { clock += ms; t.mock.timers.tick(ms); await flush(); };
  t.after(() => engine.abort());
  return { engine, voice, events, advance, activity: () => events.filter((e) => e.ev === 'activity') };
}

async function begin(c) { c.engine.start(); await flush(); c.voice.spoken.length = 0; c.voice.pauses.length = 0; c.events.length = 0; }
const interactionHandler = (type) => () => say('始めます。', { next: 'interaction', interaction: type });

// ---------- 間 ----------
test('opening_sayLines_areFollowedByTopicPause1200', async (t) => {
  const c = setup(t);
  c.engine.start();
  await flush();
  const n = scenario.opening.ja.length + 1; // + 状態の一言
  assert.equal(c.voice.pauses.filter((ms) => ms === 1200).length, n);
});

test('narrate_betweenSentences_pauses700ButNotAfterLast', async (t) => {
  const c = setup(t, { handler: () => say('一文目です。二文目です。三文目です。') });
  await begin(c);
  c.engine.onPosition(...pos(A));
  await flush();
  assert.deepEqual(c.voice.spoken, ['一文目です。', '二文目です。', '三文目です。']);
  assert.deepEqual(c.voice.pauses, [700, 700]);
});

test('narrate_singleSentence_hasNoPause', async (t) => {
  const c = setup(t, { handler: () => say('一文だけです。') });
  await begin(c);
  c.engine.onPosition(...pos(A));
  await flush();
  assert.deepEqual(c.voice.pauses, []);
});

test('narrate_sentencePause_usesVoiceSettingWhenPresent', async (t) => {
  const c = setup(t, { handler: () => say('一。二。') });
  c.voice.sentencePauseMs = 300;
  await begin(c);
  c.engine.onPosition(...pos(A));
  await flush();
  assert.deepEqual(c.voice.pauses, [300]);
});

test('caption_isEmittedForEverySpokenLine', async (t) => {
  const c = setup(t, { handler: () => say('字幕の文です。') });
  await begin(c);
  c.engine.onPosition(...pos(A));
  await flush();
  assert.ok(c.events.some((e) => e.ev === 'caption' && e.text === '字幕の文です。'));
});

// ---------- interaction（目安時間つき） ----------
test('interaction_withInteractionSec_startsWithTimeBoxSentence', async (t) => {
  const c = setup(t, { handler: interactionHandler('LOOK') });
  await begin(c);
  c.engine.onPosition(...pos(A));
  await flush();
  const line = c.voice.spoken.find((s) => s.startsWith('20秒ほど、時間をとります。'));
  assert.ok(line, `先頭に目安時間の一文: ${c.voice.spoken.join(' / ')}`);
  assert.ok(line.length > '20秒ほど、時間をとります。'.length, '指示文が続く');
});

test('interaction_timeBox_usesMinutesFrom90Seconds', async (t) => {
  const sc = JSON.parse(JSON.stringify(scenario));
  sc.interactionSec = { ...sc.interactionSec, REST: 120, LOOK: 45 };
  const c = setup(t, { handler: interactionHandler('REST'), sc });
  await begin(c);
  c.engine.onPosition(...pos(A));
  await flush();
  assert.ok(c.voice.spoken.some((s) => s.startsWith('2分ほど、時間をとります。')));
});

test('interaction_timeBox_english', async (t) => {
  const c = setup(t, { handler: interactionHandler('LOOK'), lang: 'en' });
  await begin(c);
  c.engine.onPosition(...pos(A));
  await flush();
  assert.ok(c.voice.spoken.some((s) => s.startsWith("Let's take about 20 seconds.")), c.voice.spoken.join(' / '));
});

test('interaction_waitsForInteractionSec_thenClosesWithMoveOnLine', async (t) => {
  const c = setup(t, { handler: interactionHandler('LOOK') });
  await begin(c);
  c.engine.onPosition(...pos(A));
  await flush();
  const before = c.voice.spoken.length;
  await c.advance(19_000);
  assert.equal(c.voice.spoken.length, before, '20 秒の途中では何も言わない');
  await c.advance(1_500);
  assert.ok(scenario.phrases.moveOn.ja.includes(c.voice.spoken.at(-1)), '終わりに区切りの一言');
});

test('interaction_withoutInteractionSec_keepsShortGapAndNoClosingLine', async (t) => {
  const c = setup(t, { handler: interactionHandler('WALK') }); // WALK は interactionSec 無し
  await begin(c);
  c.engine.onPosition(...pos(A));
  await flush();
  assert.ok(!c.voice.spoken.some((s) => s.includes('時間をとります')));
  await c.advance(4_500);
  assert.ok(!c.voice.spoken.some((s) => scenario.phrases.moveOn.ja.includes(s)));
  assert.equal(c.activity().filter((e) => e.type === 'WALK').length, 0, 'activity は目安時間があるときだけ');
});

test('activity_duringTimedInteraction_emitsTypeLabelEndsAtThenNull', async (t) => {
  const c = setup(t, { handler: interactionHandler('LISTEN') });
  await begin(c);
  c.engine.onPosition(...pos(A));
  await flush();
  const start = c.activity().find((e) => e.type === 'LISTEN');
  assert.ok(start);
  assert.equal(start.label, scenario.activityLabels.LISTEN.ja);
  assert.equal(typeof start.endsAt, 'number');
  await c.advance(30_500);
  assert.equal(c.activity().at(-1).type, null, '終了で null');
  assert.equal(c.activity().at(-1).label, '');
});

test('activity_duringSilence_emitsSilenceThenNull_andSilenceStartsWithTimeBox', async (t) => {
  const c = setup(t, { handler: () => say('静かに。', { next: 'silence', silenceSec: 30 }) });
  await begin(c);
  c.engine.onPosition(...pos(A));
  await flush();
  assert.ok(c.voice.spoken.some((s) => s.startsWith('30秒ほど、時間をとります。')));
  const s = c.activity().find((e) => e.type === 'SILENCE');
  assert.ok(s && s.endsAt > 0);
  await c.advance(30_500);
  assert.equal(c.activity().at(-1).type, null);
  assert.ok(c.voice.spoken.includes(scenario.silenceEnd.ja));
});

test('pause_duringTimedInteraction_carriesRemainingTimeOnResume', async (t) => {
  const c = setup(t, { handler: interactionHandler('LOOK') });
  await begin(c);
  c.engine.onPosition(...pos(A));
  await flush();
  await c.advance(8_000);
  c.engine.pause();
  await flush();
  const spokenAtPause = c.voice.spoken.length;
  assert.equal(c.engine.queue[0].remainingMs, 12_000);
  await c.advance(60_000); // 一時停止中は進まない
  assert.equal(c.voice.spoken.length, spokenAtPause);
  c.engine.resume();
  await flush();
  assert.equal(c.voice.spoken.length, spokenAtPause, '指示文・目安時間を言い直さない');
  await c.advance(11_000);
  assert.equal(c.voice.spoken.length, spokenAtPause, '残り 12 秒のうち 11 秒ではまだ');
  await c.advance(1_500);
  assert.ok(scenario.phrases.moveOn.ja.includes(c.voice.spoken.at(-1)));
});

// ---------- 次の場所の予告 ----------
test('leavingSpot_towardNextSpot_speaksPreviewWithNameDirectionDistanceMinutes', async (t) => {
  const c = setup(t, { handler: () => say('A です。') });
  await begin(c);
  c.engine.onPosition(...pos(A));
  await flush();
  c.engine.onPosition(...pos(A, 80)); // A を離れる。B まで約 220m（真北）
  await flush();
  // 220m → 50m 単位で 200、1.1 m/s で ceil(220/1.1/60) = 4 分
  assert.equal(c.voice.spoken.at(-1), '次は、Bの広場です。北の方向に約200メートル、歩いて4分ほどです。');
  assert.equal(c.engine.phase, 'walk');
});

test('leavingSpot_preview_english', async (t) => {
  const c = setup(t, { lang: 'en', handler: () => say('') });
  await begin(c);
  c.engine.onPosition(...pos(A));
  await flush();
  c.engine.onPosition(...pos(A, 80));
  await flush();
  assert.equal(c.voice.spoken.at(-1), 'Next is B Plaza, about 200 meters to the north, about 4 minutes on foot.');
});

test('leavingSpot_preview_under100mRoundsTo10m_andUsesCompassForEast', async (t) => {
  const E = { ...B, id: 'E', order: 2, name: { ja: '東の池', en: 'East Pond' }, lat: A.lat, lng: A.lng + 250 / (111195 * Math.cos((35.68 * Math.PI) / 180)) };
  const c = setup(t, { spots: [A, E], handler: () => say('') });
  await begin(c);
  c.engine.onPosition(...pos(A));
  await flush();
  c.engine.onPosition(A.lat, E.lng - 90 / (111195 * Math.cos((35.68 * Math.PI) / 180)), 5); // E の 90m 手前（A からは 160m で離脱）
  await flush();
  const line = c.voice.spoken.at(-1);
  assert.match(line, /^次は、東の池です。東の方向に約90メートル、歩いて2分ほどです。$/);
});

test('enteringNextSpotDirectly_doesNotSpeakPreview', async (t) => {
  const c = setup(t, { handler: () => say('') });
  await begin(c);
  c.engine.onPosition(...pos(A));
  await flush();
  c.engine.onPosition(...pos(B)); // 一気に B の中へ
  await flush();
  assert.ok(!c.voice.spoken.some((s) => s.startsWith('次は、')));
});

test('leavingLastSpot_hasNoNextSpotPreview', async (t) => {
  const c = setup(t, { spots: [A], handler: () => say('') });
  await begin(c);
  c.engine.onPosition(...pos(A));
  await flush();
  c.engine.onPosition(...pos(A, 80));
  await flush();
  assert.ok(!c.voice.spoken.some((s) => s.startsWith('次は、')));
});

test('leavingSpot_withScenarioWithoutPhrases_doesNotCrashOrSpeakPreview', async (t) => {
  const sc = JSON.parse(JSON.stringify(scenario));
  delete sc.phrases;
  const c = setup(t, { sc, handler: () => say('') });
  await begin(c);
  c.engine.onPosition(...pos(A));
  await flush();
  c.engine.onPosition(...pos(A, 80));
  await flush();
  assert.ok(!c.voice.spoken.some((s) => s.startsWith('次は、')));
});

// ---------- reply で素材が尽きたときのフォールバック（クライアント側） ----------
test('narrateFallback_replyWhenNoMaterialsLeft_saysEndLineAndMovesOn', async (t) => {
  const ASK = { text: '先へ？', options: [{ id: 'more', label: 'もっと' }, { id: 'next', label: '先へ' }], defaultId: 'next' };
  let n = 0;
  const c = setup(t, { handler: () => { n++; if (n === 1) return say('A です。', { ask: ASK, usedMaterialIds: ['A-fact'] }); throw new Error('offline'); } });
  await begin(c);
  c.engine.onPosition(...pos(A));
  await flush();
  c.engine.replyAsk({ optionId: 'more' });
  await flush();
  assert.equal(c.voice.spoken.at(-1), scenario.phrases.endLine.ja);
});
