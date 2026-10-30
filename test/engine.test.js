'use strict';
// WalkEngine（クライアント ESM）。偽 voice / 偽 narrate / 注入 now / mock.timers で決定的に動かす。
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
  globalThis.window = globalThis.window || {}; // voice.js がトップレベルで window を参照する
  ({ WalkEngine } = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'engine.js')).href));
});

const A = { id: 'A', order: 1, enabled: true, name: { ja: 'A', en: 'A' }, lat: 35.68, lng: 139.756, radius: 40, materials: [
  { id: 'A-fact', type: 'fact', lang: 'ja', text: 'A の事実です。' },
  { id: 'A-must', type: 'must', lang: 'ja', text: 'A の必須です。' },
] };
const B = { id: 'B', order: 2, enabled: true, name: { ja: 'B', en: 'B' }, lat: 35.68 + 300 / M_PER_DEG, lng: 139.756, radius: 40, materials: [
  { id: 'B-fact', type: 'fact', lang: 'ja', text: 'B の事実です。' },
] };
const at = (spot, northM = 0) => [spot.lat + northM / M_PER_DEG, spot.lng, 5];

class FakeVoice {
  constructor() { this.spoken = []; this.hold = false; this.cancels = 0; this._pending = null; this.canListen = false; }
  speak(text) {
    this.spoken.push(text);
    if (!this.hold) return Promise.resolve(true);
    return new Promise((res) => { this._pending = res; });
  }
  release(ok = true) { const p = this._pending; this._pending = null; if (p) p(ok); }
  cancel() { this.cancels++; this.release(false); }
  stopListening() {}
}

const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };

// handler(payload, signal, callIndex) => レスポンス。省略時は say '' を返す
function setup(t, { spots = [A, B], checkin = { state: 'ok', desire: 'nature' }, handler, lang = 'ja' } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let clock = 5_000_000;
  const voice = new FakeVoice();
  const calls = [];
  const logs = [];
  const narrate = async (payload, signal) => {
    calls.push(payload);
    return handler ? handler(payload, signal, calls.length) : { say: '', ask: null, next: 'wait', usedMaterialIds: [] };
  };
  const engine = new WalkEngine({
    voice, scenario, spots: JSON.parse(JSON.stringify(spots)), lang, checkin, narrate, now: () => clock,
    log: (type, data) => logs.push({ type, ...data }),
  });
  const events = [];
  for (const ev of ['phase', 'status', 'spot', 'ask', 'finished']) engine.addEventListener(ev, (e) => events.push({ type: ev, ...e.detail }));
  const advance = async (ms) => { clock += ms; t.mock.timers.tick(ms); await flush(); };
  t.after(() => engine.abort());
  return { engine, voice, calls, logs, events, advance, now: () => clock };
}

// 冒頭を読み終えて歩行フェーズへ
async function startWalking(ctx) {
  ctx.engine.start();
  await flush();
}

const say = (text, extra = {}) => ({ say: text, ask: null, next: 'wait', interaction: null, silenceSec: null, usedMaterialIds: [], ...extra });
const ASK = { text: 'もう少し聞きますか？', options: [{ id: 'more', label: 'もっと' }, { id: 'next', label: '先へ' }], defaultId: 'next' };

test('start_speaksOpeningThenStateCueAndEntersWalkPhase', async (t) => {
  const c = setup(t);
  await startWalking(c);
  const expected = [...scenario.opening.ja, scenario.checkin.states.find((s) => s.id === 'ok').cue.ja];
  assert.deepEqual(c.voice.spoken, expected);
  const phases = c.events.filter((e) => e.type === 'phase').map((e) => e.phase);
  assert.deepEqual(phases, ['slowdown', 'walk']);
  assert.equal(c.engine.status, 'idle');
});

test('start_inEnglish_usesEnglishOpening', async (t) => {
  const c = setup(t, { lang: 'en' });
  await startWalking(c);
  assert.equal(c.voice.spoken[0], scenario.opening.en[0]);
});

test('onPosition_nearSpot_prefetchesArriveNarrateBeforeEntering', async (t) => {
  const c = setup(t, { handler: () => say('A へようこそ。') });
  await startWalking(c);
  c.engine.onPosition(...at(A, 80)); // 半径 40 + 60 以内、まだ入場前
  await flush();
  assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0].trigger, 'arrive');
  assert.equal(c.calls[0].spotId, 'A');
  assert.ok(!c.voice.spoken.includes('A へようこそ。'), '入場前は読まない');
  assert.equal(c.events.filter((e) => e.type === 'spot' && e.spot).length, 0);
});

test('onPosition_farFromSpot_doesNotPrefetch', async (t) => {
  const c = setup(t, { handler: () => say('x。') });
  await startWalking(c);
  c.engine.onPosition(...at(A, 150));
  await flush();
  assert.equal(c.calls.length, 0);
});

test('onPosition_enteringPrefetchedSpot_speaksImmediatelyWithoutSecondNarrate', async (t) => {
  const c = setup(t, { handler: () => say('A へようこそ。') });
  await startWalking(c);
  c.engine.onPosition(...at(A, 80));
  await flush();
  c.engine.onPosition(...at(A, 10));
  await flush();
  assert.equal(c.calls.length, 1, '先読みを再利用');
  assert.ok(c.voice.spoken.includes('A へようこそ。'));
  assert.equal(c.events.find((e) => e.type === 'spot' && e.spot).spot.id, 'A');
  assert.ok(c.logs.some((l) => l.type === 'spot_reached' && l.spotId === 'A'));
});

test('onPosition_enteringWithoutPrefetch_callsNarrateOnEntry', async (t) => {
  const c = setup(t, { handler: () => say('いきなり。') });
  await startWalking(c);
  c.engine.onPosition(...at(A, 5));
  await flush();
  assert.equal(c.calls.length, 1);
  assert.ok(c.voice.spoken.includes('いきなり。'));
});

test('onPosition_withPoorAccuracyOver60_doesNotTriggerSpots', async (t) => {
  const c = setup(t, { handler: () => say('x。') });
  await startWalking(c);
  c.engine.onPosition(A.lat, A.lng, 100);
  await flush();
  assert.equal(c.calls.length, 0);
});

test('narratePayload_hasContractFields', async (t) => {
  const c = setup(t, { checkin: { state: 'low', desire: 'calm', durationMin: 40, note: '木が好き' }, handler: () => say('') });
  await startWalking(c);
  c.engine.onPosition(...at(A, 5));
  await flush();
  const p = c.calls[0];
  assert.equal(p.lang, 'ja');
  assert.deepEqual(p.checkin, { state: 'low', desire: 'calm', durationMin: 40, note: '木が好き' });
  assert.equal(p.trigger, 'arrive');
  assert.equal(p.motion.distanceToSpotM, 5);
  assert.equal(p.timing.totalMin, 40);
  assert.equal(p.timing.remainingMin, 40);
  assert.deepEqual(p.spokenMaterialIds, []);
  assert.equal(p.askedAtSpot, false);
  assert.equal(p.pendingAsk, null);
  assert.ok(Array.isArray(p.history));
});

test('narrate_ask_isSpokenThenShownThenButtonReplyTriggersReplyNarrate', async (t) => {
  const c = setup(t, {
    handler: (p) => (p.trigger === 'arrive' ? say('松です。', { ask: ASK, usedMaterialIds: ['A-fact'] }) : say('では続きを。')),
  });
  await startWalking(c);
  c.engine.onPosition(...at(A, 5));
  await flush();
  assert.deepEqual(c.voice.spoken.slice(-2), ['松です。', ASK.text]);
  assert.equal(c.engine.status, 'asking');
  assert.deepEqual(c.events.filter((e) => e.type === 'ask' && e.ask).map((e) => e.ask), [ASK]);

  c.engine.replyAsk({ optionId: 'more' });
  await flush();
  const reply = c.calls[1];
  assert.equal(reply.trigger, 'reply');
  assert.deepEqual(reply.userReply, { optionId: 'more' });
  assert.deepEqual(reply.pendingAsk, ASK);
  assert.deepEqual(reply.spokenMaterialIds, ['A-fact']);
  assert.equal(reply.askedAtSpot, true);
  assert.equal(c.voice.spoken.at(-1), 'では続きを。');
  assert.ok(c.logs.some((l) => l.type === 'guide_ask_reply' && l.via === 'button' && l.optionId === 'more'));
  assert.ok(c.logs.some((l) => l.type === 'guide_ask' && l.spotId === 'A'));
  // ask 表示は消える
  assert.equal(c.events.filter((e) => e.type === 'ask').at(-1).ask, null);
});

test('ask_voiceReply_isPassedAsText', async (t) => {
  const c = setup(t, { handler: (p) => (p.trigger === 'arrive' ? say('松。', { ask: ASK }) : say('はい。')) });
  c.voice.canListen = true;
  c.voice.listen = async () => '先に進みたい';
  await startWalking(c);
  c.engine.onPosition(...at(A, 5));
  await flush();
  assert.deepEqual(c.calls[1].userReply, { text: '先に進みたい' });
  assert.ok(c.logs.some((l) => l.type === 'guide_ask_reply' && l.via === 'voice'));
});

test('ask_withNoReplyFor12s_timesOutQuietlyWithoutReplyNarrate', async (t) => {
  const c = setup(t, { handler: () => say('松。', { ask: ASK }) });
  await startWalking(c);
  c.engine.onPosition(...at(A, 5));
  await flush();
  assert.equal(c.engine.status, 'asking');
  await c.advance(11_000);
  assert.equal(c.engine.status, 'asking', '12 秒まではまだ待つ');
  await c.advance(1_500);
  assert.equal(c.calls.length, 1, '無返事では reply を呼ばない');
  assert.equal(c.engine.status, 'idle');
  assert.ok(c.logs.some((l) => l.type === 'guide_ask_reply' && l.via === 'timeout'));
  assert.equal(c.events.filter((e) => e.type === 'ask').at(-1).ask, null);
});

test('ask_perSpot_onlyOnceEvenWhenLingerFollows_andPayloadReportsAsked', async (t) => {
  const c = setup(t, { handler: (p) => (p.trigger === 'arrive' ? say('松。', { ask: ASK }) : say('')) });
  await startWalking(c);
  c.engine.onPosition(...at(A, 5));
  await flush();
  await c.advance(12_500); // 無返事
  c.engine.debugAdvanceDwell(50);
  await c.advance(1_000);
  const linger = c.calls.find((p) => p.trigger === 'linger');
  assert.ok(linger, 'linger narrate が呼ばれる');
  assert.equal(linger.askedAtSpot, true);
  assert.equal(c.logs.filter((l) => l.type === 'guide_ask').length, 1);
});

test('linger_isLimitedToTwiceAndRequiresDwell', async (t) => {
  const c = setup(t, { handler: () => say('') });
  await startWalking(c);
  c.engine.onPosition(...at(A, 5));
  await flush();
  await c.advance(30_000);
  assert.equal(c.calls.filter((p) => p.trigger === 'linger').length, 0, '45 秒未満');
  for (let i = 0; i < 5; i++) {
    c.engine.debugAdvanceDwell(50);
    await c.advance(1_000);
  }
  assert.equal(c.calls.filter((p) => p.trigger === 'linger').length, 2);
});

test('narrate_timeoutAfter8s_fallsBackToMaterialsAndLogsError', async (t) => {
  const c = setup(t, {
    handler: (p, signal) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))),
  });
  await startWalking(c);
  c.engine.onPosition(...at(A, 5));
  await flush();
  assert.ok(!c.voice.spoken.includes('A の必須です。'));
  await c.advance(7_900);
  assert.ok(!c.voice.spoken.includes('A の必須です。'), '8 秒前はまだ');
  await c.advance(200);
  assert.equal(c.voice.spoken.at(-1), 'A の必須です。', 'must を最優先');
  assert.ok(c.logs.some((l) => l.type === 'error' && l.where === 'narrate'));
});

test('narrate_invalidResponse_fallsBackToMaterials', async (t) => {
  const c = setup(t, { handler: () => ({ nonsense: true }) });
  await startWalking(c);
  c.engine.onPosition(...at(A, 5));
  await flush();
  assert.equal(c.voice.spoken.at(-1), 'A の必須です。');
});

test('narrate_fallbackSkipsAlreadySpokenMaterials', async (t) => {
  const c = setup(t, { handler: (p) => { if (p.trigger === 'arrive') return say('一言。', { usedMaterialIds: ['A-must'] }); throw new Error('offline'); } });
  await startWalking(c);
  c.engine.onPosition(...at(A, 5));
  await flush();
  c.engine.debugAdvanceDwell(50);
  await c.advance(1_000);
  assert.equal(c.voice.spoken.at(-1), 'A の事実です。', 'must は話し済みなので fact');
});

test('leavingSpot_mid-narrate_stopsAtSentenceBoundary', async (t) => {
  const c = setup(t, { handler: () => say('一文目です。二文目です。三文目です。') });
  await startWalking(c);
  c.voice.hold = true;
  c.engine.onPosition(...at(A, 5));
  await flush();
  assert.equal(c.voice.spoken.at(-1), '一文目です。');
  c.engine.onPosition(...at(A, 80)); // 半径 × 1.5 = 60m を超えた
  await flush();
  assert.equal(c.engine.currentSpot, null);
  c.voice.release(true); // 一文目の読み上げが終わる
  await flush();
  assert.ok(!c.voice.spoken.includes('二文目です。'), '文の切れ目で打ち切る');
  assert.equal(c.voice.cancels, 0, '話の途中でも音声自体は切らない');
});

test('leavingSpot_beforeNarrateReturns_discardsItsSpeech', async (t) => {
  let resolveIt;
  const c = setup(t, { handler: () => new Promise((r) => { resolveIt = r; }) });
  await startWalking(c);
  c.engine.onPosition(...at(A, 5));
  await flush();
  c.engine.onPosition(...at(A, 80));
  resolveIt(say('もう遅い話。'));
  await flush();
  assert.ok(!c.voice.spoken.includes('もう遅い話。'));
});

test('leavingSpot_withinRadiusTimes1_5_doesNotLeave', async (t) => {
  const c = setup(t, { handler: () => say('') });
  await startWalking(c);
  c.engine.onPosition(...at(A, 5));
  await flush();
  c.engine.onPosition(...at(A, 55)); // 60m 以内
  assert.equal(c.engine.currentSpot?.id, 'A');
});

test('visitedSpot_isNotEnteredAgain', async (t) => {
  const c = setup(t, { handler: () => say('') });
  await startWalking(c);
  c.engine.onPosition(...at(A, 5));
  await flush();
  c.engine.onPosition(...at(A, 80));
  c.engine.onPosition(...at(A, 5));
  await flush();
  assert.equal(c.calls.filter((p) => p.spotId === 'A').length, 1);
});

test('disabledSpot_isIgnored', async (t) => {
  const c = setup(t, { spots: [{ ...A, enabled: false }, B], handler: () => say('') });
  await startWalking(c);
  c.engine.onPosition(...at(A, 5));
  await flush();
  assert.equal(c.calls.length, 0);
});

test('allSpotsVisited_andSettledAtLastSpot_playsClosingThenFinished', async (t) => {
  const c = setup(t, { handler: () => say('') });
  await startWalking(c);
  c.engine.onPosition(...at(A, 5));
  await flush();
  c.engine.onPosition(...at(B, 5)); // A を離れて B へ
  await flush();
  assert.equal(c.engine.currentSpot.id, 'B');
  assert.equal(c.events.filter((e) => e.type === 'finished').length, 0);
  c.engine.debugAdvanceDwell(35);
  await c.advance(1_000);
  assert.deepEqual(c.voice.spoken.slice(-scenario.closing.ja.length), scenario.closing.ja);
  const fin = c.events.find((e) => e.type === 'finished');
  assert.ok(fin);
  assert.deepEqual(fin.visited.sort(), ['A', 'B']);
  assert.equal(c.engine.status, 'ended');
  const phases = c.events.filter((e) => e.type === 'phase').map((e) => e.phase);
  assert.deepEqual(phases.slice(-2), ['reflect', 'return']);
});

test('allSpotsVisited_butLastSpotNotSettled_doesNotCloseYet', async (t) => {
  const c = setup(t, { handler: () => say('') });
  await startWalking(c);
  c.engine.onPosition(...at(A, 5));
  c.engine.onPosition(...at(B, 5));
  await flush();
  await c.advance(10_000);
  assert.equal(c.events.filter((e) => e.type === 'finished').length, 0);
});

test('timeUp_withDuration_asksOnceAndEndsOnEndReply', async (t) => {
  const c = setup(t, { checkin: { state: 'ok', desire: 'nature', durationMin: 1 }, handler: () => say('') });
  await startWalking(c);
  await c.advance(61_000);
  const asks = c.events.filter((e) => e.type === 'ask' && e.ask);
  assert.equal(asks.length, 1);
  assert.equal(asks[0].ask.text, scenario.timeUp.text.ja);
  assert.equal(asks[0].ask.defaultId, 'more');
  assert.deepEqual(asks[0].ask.options.map((o) => o.id), ['end', 'more']);
  c.engine.replyAsk({ optionId: 'end' });
  await flush();
  assert.ok(c.events.some((e) => e.type === 'finished'));
  assert.deepEqual(c.voice.spoken.slice(-scenario.closing.ja.length), scenario.closing.ja);
  assert.equal(c.calls.length, 0, 'ローカルの質問なので narrate は呼ばない');
});

test('timeUp_replyMore_continuesAndDoesNotAskAgain', async (t) => {
  const c = setup(t, { checkin: { state: 'ok', desire: 'nature', durationMin: 1 }, handler: () => say('') });
  await startWalking(c);
  await c.advance(61_000);
  c.engine.replyAsk({ optionId: 'more' });
  await flush();
  await c.advance(120_000);
  assert.equal(c.events.filter((e) => e.type === 'ask' && e.ask).length, 1);
  assert.equal(c.events.filter((e) => e.type === 'finished').length, 0);
});

test('timeUp_noReplyForTimeUpAsk_keepsWalking', async (t) => {
  const c = setup(t, { checkin: { state: 'ok', desire: 'nature', durationMin: 1 }, handler: () => say('') });
  await startWalking(c);
  await c.advance(61_000);
  await c.advance(13_000);
  assert.equal(c.events.filter((e) => e.type === 'finished').length, 0);
});

test('timeUp_withoutDuration_neverAsks', async (t) => {
  const c = setup(t, { checkin: { state: 'ok', desire: 'nature', durationMin: null }, handler: () => say('') });
  await startWalking(c);
  await c.advance(3 * 3600_000 / 60); // 3 分ぶんを 1 秒刻み
  c.engine.startedAt -= 3 * 3600_000; // 3 時間経過扱い
  await c.advance(5_000);
  assert.equal(c.events.filter((e) => e.type === 'ask' && e.ask).length, 0);
  assert.equal(c.calls.length, 0);
});

test('pause_duringOpening_cancelsSpeechAndResumeRepeatsInterruptedLine', async (t) => {
  const c = setup(t);
  c.voice.hold = true;
  c.engine.start();
  await flush();
  assert.equal(c.voice.spoken.length, 1);
  c.engine.pause();
  await flush();
  assert.equal(c.engine.status, 'paused');
  assert.equal(c.voice.cancels, 1);
  assert.equal(c.voice.spoken.length, 1, '一時停止中は進まない');
  c.voice.hold = false;
  c.engine.resume();
  await flush();
  assert.equal(c.voice.spoken[1], scenario.opening.ja[0], '中断した行からやり直す');
  assert.equal(c.voice.spoken.length, 1 + scenario.opening.ja.length + 1);
  assert.equal(c.engine.status, 'idle');
});

test('pause_whenAlreadyPaused_andResumeWhenNotPaused_areNoOps', async (t) => {
  const c = setup(t);
  await startWalking(c);
  c.engine.resume();
  assert.equal(c.engine.status, 'idle');
  c.engine.pause();
  c.engine.pause();
  assert.equal(c.voice.cancels, 1);
});

test('pause_whileAskIsShown_thenResume_reasksQuestion', async (t) => {
  const c = setup(t, { handler: () => say('松。', { ask: ASK }) });
  await startWalking(c);
  c.engine.onPosition(...at(A, 5));
  await flush();
  c.engine.pause();
  await flush();
  c.engine.resume();
  await flush();
  assert.equal(c.engine.status, 'asking');
  assert.equal(c.calls.length, 1, 'narrate を重複して呼ばない');
  assert.equal(c.logs.filter((l) => l.type === 'guide_ask').length, 1, 'ask は 1 回だけ記録');
});

test('finish_midWalk_playsClosingAndEnds', async (t) => {
  const c = setup(t);
  await startWalking(c);
  c.engine.finish();
  await flush();
  assert.ok(c.events.some((e) => e.type === 'finished'));
  assert.deepEqual(c.voice.spoken.slice(-scenario.closing.ja.length), scenario.closing.ja);
});

test('abort_stopsEverythingAndIgnoresPositions', async (t) => {
  const c = setup(t, { handler: () => say('x。') });
  await startWalking(c);
  c.engine.abort();
  c.engine.onPosition(...at(A, 5));
  await flush();
  assert.equal(c.calls.length, 0);
});

test('nextSpot_withoutPosition_isFirstByOrder_thenNearestUnvisited', async (t) => {
  const c = setup(t, { handler: () => say('') });
  assert.equal(c.engine.nextSpot().spot.id, 'A');
  assert.equal(c.engine.nextSpot().distance, null);
  await startWalking(c);
  c.engine.onPosition(...at(B, 100));
  const n = c.engine.nextSpot();
  assert.equal(n.spot.id, 'B');
  assert.ok(Math.abs(n.distance - 100) <= 1);
});

test('walkCue_whileMovingAndSilentLongEnough_speaksAtMostFromPool', async (t) => {
  const c = setup(t, { handler: () => say('') });
  await startWalking(c);
  // 歩いている状態を作る（5 秒ごとに 7m 北へ ≒ 1.4m/s、Spot からは遠いところ）
  const base = { lat: 35.70, lng: 139.8 };
  let i = 0;
  for (let s = 0; s < 260; s += 5) {
    c.engine.onPosition(base.lat + (i++ * 7) / M_PER_DEG, base.lng, 5);
    await c.advance(5_000);
  }
  const cues = c.voice.spoken.filter((s) => scenario.walkCues.ja.includes(s));
  assert.ok(cues.length >= 1, '240 秒の無言のあと声かけ');
  assert.ok(cues.length <= 2);
});

test('finish_midWalk_emitsFinishingBeforeClosingIsSpoken', async (t) => {
  const c = setup(t);
  await startWalking(c);
  let finishing = 0;
  c.engine.addEventListener('finishing', () => { finishing++; });
  c.engine.finish();
  assert.equal(finishing, 1, '「はい」を押した瞬間に通知する（締めの言葉を待たない）');
  assert.ok(!c.events.some((e) => e.type === 'finished'));
  await flush();
  assert.ok(c.events.some((e) => e.type === 'finished'));
});
