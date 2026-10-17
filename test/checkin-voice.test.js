'use strict';
// runVoiceCheckin（音声チェックインの進行）。vc は偽物。
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

let runVoiceCheckin;
before(async () => {
  ({ runVoiceCheckin } = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'checkin-voice.js')).href));
});

const STR = {
  vcAsk: '今日はどうですか', vcListening: '聞いています', vcThinking: '考え中', vcRetry: 'もう一度', vcFixAsk: 'どこを直しますか',
  vcMissing: { state: 'MISS-state', desire: 'MISS-desire', durationMin: 'MISS-dur' },
};
const full = (extra = {}) => ({ missing: [], confirmText: 'CONFIRM', ...extra });

// listens: 文字列（聞き取れた文）/ Error（マイク拒否など）/ 'BUTTON:yes'（ボタン先着）
// parses: parse の返り値を順に返す（最後の値を繰り返す）
function makeVc({ listens = [], parses = [full()] } = {}) {
  const log = { said: [], listens: 0, parsed: [], defaults: [], confirms: [], applied: [] };
  const vc = {
    cancelled: false, onButton: null, cancelHook: null,
    S: () => STR,
    setStatus() {},
    say: async (t) => { log.said.push(t); },
    voice: {
      listen() {
        log.listens++;
        const next = listens.shift();
        if (next instanceof Error) return Promise.reject(next);
        if (typeof next === 'string' && next.startsWith('BUTTON:')) {
          setImmediate(() => vc.onButton && vc.onButton(next.slice(7)));
          return new Promise(() => {});
        }
        return Promise.resolve(next ?? '');
      },
      stopListening() {},
    },
    parse: async (text) => { log.parsed.push(text); return parses.length > 1 ? parses.shift() : parses[0]; },
    apply: (r) => log.applied.push(r),
    setDefaults: (m) => log.defaults.push([...m]),
    defaultConfirmText: () => 'DEFAULT-CONFIRM',
    showConfirm: (on) => log.confirms.push(on),
  };
  return { vc, log };
}

test('flow_allAnsweredAndConfirmedByVoice_returnsDone', async () => {
  const { vc, log } = makeVc({ listens: ['元気です、40分、木が好き', 'はい'] });
  assert.equal(await runVoiceCheckin(vc), 'done');
  assert.deepEqual(log.said, [STR.vcAsk, 'CONFIRM']);
  assert.deepEqual(log.parsed, ['元気です、40分、木が好き']);
  assert.equal(log.defaults.length, 0);
  assert.equal(log.confirms.at(-1), false, '確認表示は閉じる');
});

test('flow_confirmByButton_returnsDone', async () => {
  const { vc } = makeVc({ listens: ['元気', 'BUTTON:yes'] });
  assert.equal(await runVoiceCheckin(vc), 'done');
});

test('flow_missingItem_isAskedOnceThenAnswered', async () => {
  const { vc, log } = makeVc({ listens: ['元気です', '40分で', 'はい'], parses: [full({ missing: ['durationMin'] }), full()] });
  assert.equal(await runVoiceCheckin(vc), 'done');
  assert.deepEqual(log.said, [STR.vcAsk, 'MISS-dur', 'CONFIRM']);
  assert.equal(log.defaults.length, 0);
});

test('flow_sameItemStillMissing_isNotAskedAgain_usesDefaultsAndDefaultConfirm', async () => {
  const { vc, log } = makeVc({ listens: ['うーん', 'わかりません', 'はい'], parses: [full({ missing: ['state'] })] });
  assert.equal(await runVoiceCheckin(vc), 'done');
  assert.equal(log.said.filter((s) => s === 'MISS-state').length, 1, '同一項目の聞き直しは 1 回まで');
  assert.deepEqual(log.defaults, [['state']]);
  assert.equal(log.said.at(-1), 'DEFAULT-CONFIRM');
  assert.ok(!log.said.includes('CONFIRM'));
});

test('flow_followupsAreLimitedTo2InTotal_thenDefaults', async () => {
  const { vc, log } = makeVc({
    listens: ['a', 'b', 'c', 'はい'],
    parses: [full({ missing: ['state'] }), full({ missing: ['desire'] }), full({ missing: ['durationMin'] })],
  });
  assert.equal(await runVoiceCheckin(vc), 'done');
  const asked = log.said.filter((s) => s.startsWith('MISS-'));
  assert.deepEqual(asked, ['MISS-state', 'MISS-desire'], '全体で 2 回まで');
  assert.deepEqual(log.defaults, [['durationMin']]);
  assert.equal(log.said.at(-1), 'DEFAULT-CONFIRM');
});

test('flow_multipleMissingAtOnce_areAskedInOneFollowup', async () => {
  const { vc, log } = makeVc({ listens: ['a', 'b', 'はい'], parses: [full({ missing: ['state', 'desire'] }), full()] });
  assert.equal(await runVoiceCheckin(vc), 'done');
  assert.equal(log.said[1], 'MISS-stateMISS-desire');
});

test('hear_silenceOnce_retriesOnceThenContinues', async () => {
  const { vc, log } = makeVc({ listens: ['', '元気です', 'はい'] });
  assert.equal(await runVoiceCheckin(vc), 'done');
  assert.deepEqual(log.said.slice(0, 2), [STR.vcAsk, STR.vcRetry]);
  assert.equal(log.listens, 3);
});

test('hear_silenceTwice_returnsFallback', async () => {
  const { vc, log } = makeVc({ listens: ['', ''] });
  assert.equal(await runVoiceCheckin(vc), 'fallback');
  assert.equal(log.said.filter((s) => s === STR.vcRetry).length, 1, '聞き直しは 1 回だけ');
  assert.equal(log.listens, 2);
  assert.equal(log.parsed.length, 0);
});

test('hear_micDenied_returnsFallbackImmediatelyWithoutRetry', async () => {
  const { vc, log } = makeVc({ listens: [new Error('stt_not-allowed')] });
  assert.equal(await runVoiceCheckin(vc), 'fallback');
  assert.equal(log.listens, 1);
  assert.deepEqual(log.said, [STR.vcAsk], '聞き直しの声かけもしない');
});

test('flow_parseFails_returnsFallback', async () => {
  const { vc } = makeVc({ listens: ['元気'] });
  vc.parse = async () => { throw new Error('network'); };
  assert.equal(await runVoiceCheckin(vc), 'fallback');
});

test('flow_cancelledDuringFlow_returnsCancelled', async () => {
  const { vc } = makeVc({ listens: ['元気'] });
  const orig = vc.say;
  vc.say = async (t) => { await orig(t); vc.cancelled = true; };
  assert.equal(await runVoiceCheckin(vc), 'cancelled');
});

test('confirm_noThenFix_reparsesAndConfirmsAgain', async () => {
  const { vc, log } = makeVc({ listens: ['元気', 'いいえ', '時間を変えて', 'はい'], parses: [full(), full({ confirmText: 'CONFIRM2' })] });
  assert.equal(await runVoiceCheckin(vc), 'done');
  assert.deepEqual(log.said, [STR.vcAsk, 'CONFIRM', STR.vcFixAsk, 'CONFIRM2']);
  assert.deepEqual(log.parsed, ['元気', '時間を変えて']);
});

test('confirm_silence_returnsFallback', async () => {
  const { vc, log } = makeVc({ listens: ['元気', ''] });
  assert.equal(await runVoiceCheckin(vc), 'fallback');
  assert.equal(log.confirms.at(-1), false);
});

test('confirm_longCorrection_isReparsedDirectly', async () => {
  const { vc, log } = makeVc({ listens: ['元気', 'いえ、60分にして木を中心に', 'OK'], parses: [full(), full({ confirmText: 'C2' })] });
  assert.equal(await runVoiceCheckin(vc), 'done');
  assert.equal(log.parsed[1], 'いえ、60分にして木を中心に');
  assert.ok(!log.said.includes(STR.vcFixAsk));
});
