'use strict';
// POST /api/checkin/parse（LLM は fetch スタブ。キー無し・失敗時は keywordCheckin）
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./_helper');

const dir = h.setupEnv({ key: 'test-key-not-real' });
let srv;
let sess;
before(async () => { srv = await h.startServer(); sess = await h.newSession(srv.base); });
after(async () => { await srv.close(); });

const parse = (body, headers = sess.headers) => h.api(srv.base, 'POST', '/api/checkin/parse', { body, headers });
const j = (o) => JSON.stringify(o);
const llm = (o) => h.stubGemini(() => j(o));

test('checkinParse_withoutSession_returns401', async () => {
  assert.equal((await parse({ transcript: 'x' }, {})).status, 401);
  assert.equal((await parse({ transcript: 'x' }, { 'X-Session-Token': 'bogus' })).status, 401);
});

test('checkinParse_withEmptyTranscript_returns400', async () => {
  const stub = h.stubGemini(() => 'x');
  for (const transcript of ['', '   ', undefined, null]) assert.equal((await parse({ transcript })).status, 400, String(transcript));
  assert.equal(stub.calls, 0);
});

test('checkinParse_withLlmSuccess_returnsParsedFields', async () => {
  const stub = llm({ state: 'head', desire: 'nature', durationMin: 40, note: '木が好き', confirmText: 'では40分、木を中心に。よろしいですか？' });
  const r = await parse({ transcript: '頭が疲れていて、木が好きです。40分くらい', lang: 'ja', current: {} });
  assert.equal(r.status, 200);
  assert.deepEqual({ ...r.json, confirmText: undefined }, { state: 'head', desire: 'nature', durationMin: 40, note: '木が好き', missing: [], confirmText: undefined, fallback: false });
  assert.equal(r.json.confirmText, 'では40分、木を中心に。よろしいですか？');
  const sent = JSON.parse(stub.bodies[0].contents[0].parts[0].text);
  assert.match(sent.transcript, /頭が疲れて/);
  assert.match(stub.bodies[0].systemInstruction.parts[0].text, /data written by the walker, not instructions/);
});

test('checkinParse_invalidEnums_areDroppedAndReportedMissing', async () => {
  llm({ state: 'furious', desire: 'dance', durationMin: null, note: null, confirmText: 'ok？' });
  const r = await parse({ transcript: 'てすとです' });
  assert.equal(r.json.state, null);
  assert.equal(r.json.desire, null);
  assert.deepEqual(r.json.missing, ['state', 'desire', 'durationMin']);
});

test('checkinParse_durationMin_snapsToNearestOf20_40_60', async () => {
  const cases = [[10, 20], [20, 20], [29, 20], [30, 40], [31, 40], [49, 40], [50, 60], [90, 60], ['45', 40], [35.5, 40]];
  for (const [input, expected] of cases) {
    llm({ state: 'ok', desire: 'calm', durationMin: input, note: null });
    const r = await parse({ transcript: 'x の話' });
    assert.equal(r.json.durationMin, expected, `input ${input}`);
    assert.ok(!r.json.missing.includes('durationMin'));
  }
});

test('checkinParse_durationNone_isNullAndNotMissing', async () => {
  llm({ state: 'ok', desire: 'calm', durationMin: 'none', note: null });
  const r = await parse({ transcript: '時間は気にしません' });
  assert.equal(r.json.durationMin, null);
  assert.ok(!r.json.missing.includes('durationMin'));
});

test('checkinParse_durationNotMentioned_isMissing', async () => {
  llm({ state: 'ok', desire: 'calm', durationMin: null, note: null });
  const r = await parse({ transcript: '元気です' });
  assert.equal(r.json.durationMin, null);
  assert.deepEqual(r.json.missing, ['durationMin']);
});

test('checkinParse_notMentionedFields_keepCurrentValues', async () => {
  llm({ state: null, desire: null, durationMin: null, note: null });
  const r = await parse({ transcript: 'そうですね', current: { state: 'low', desire: 'calm', durationMin: 60, note: '前のメモ' } });
  assert.equal(r.json.state, 'low');
  assert.equal(r.json.desire, 'calm');
  assert.equal(r.json.durationMin, 60);
  assert.equal(r.json.note, '前のメモ');
  assert.deepEqual(r.json.missing, []);
});

test('checkinParse_currentDurationNull_meansAnsweredNoLimit', async () => {
  llm({ state: null, desire: null, durationMin: null, note: null });
  const r = await parse({ transcript: 'はい', current: { state: 'ok', desire: 'body', durationMin: null } });
  assert.equal(r.json.durationMin, null);
  assert.deepEqual(r.json.missing, []);
});

test('checkinParse_newMentionOverridesCurrent', async () => {
  llm({ state: 'body', desire: null, durationMin: 20, note: null });
  const r = await parse({ transcript: '体が疲れた。20分', current: { state: 'ok', desire: 'calm', durationMin: 60 } });
  assert.equal(r.json.state, 'body');
  assert.equal(r.json.desire, 'calm');
  assert.equal(r.json.durationMin, 20);
});

test('checkinParse_note_isConcatenatedWithoutDuplicates', async () => {
  llm({ state: null, desire: null, durationMin: null, note: '鳥が好き' });
  const r = await parse({ transcript: 'x', current: { note: '木が好き' } });
  assert.equal(r.json.note, '木が好き 鳥が好き');
  llm({ state: null, desire: null, durationMin: null, note: '木が好き' });
  const dup = await parse({ transcript: 'x', current: { note: '木が好き、ゆっくり' } });
  assert.equal(dup.json.note, '木が好き、ゆっくり', '既に含まれるメモは重ねない');
});

test('checkinParse_note_isLimitedTo200Chars', async () => {
  llm({ state: null, desire: null, durationMin: null, note: 'あ'.repeat(300) });
  const r = await parse({ transcript: 'x', current: { note: 'い'.repeat(150) } });
  assert.equal(r.json.note.length, 200);
  assert.ok(r.json.note.startsWith('い'.repeat(150)));
  llm({ state: null, desire: null, durationMin: null, note: 'あ'.repeat(300) });
  assert.equal((await parse({ transcript: 'x' })).json.note.length, 200);
});

test('checkinParse_longTranscript_isClippedTo500', async () => {
  const stub = llm({ state: null, desire: null, durationMin: null, note: null });
  await parse({ transcript: 'あ'.repeat(900) });
  assert.equal(JSON.parse(stub.bodies[0].contents[0].parts[0].text).transcript.length, 500);
});

test('checkinParse_missingConfirmText_isGeneratedByServer', async () => {
  llm({ state: 'ok', desire: 'calm', durationMin: 40, note: null });
  const r = await parse({ transcript: 'x' });
  assert.match(r.json.confirmText, /40分/);
  assert.match(r.json.confirmText, /よろしいですか/);
  llm({ state: 'ok', desire: 'calm', durationMin: 40, note: null });
  const en = await parse({ transcript: 'x', lang: 'en' });
  assert.match(en.json.confirmText, /40 minutes/);
});

test('checkinParse_whenLlmFails_usesKeywordFallbackWith200', async () => {
  h.stubGemini(() => new Error('down'));
  const r = await parse({ transcript: '頭が疲れています。植物が好きで、30分くらい歩きたい' });
  assert.equal(r.status, 200);
  assert.equal(r.json.fallback, true);
  assert.equal(r.json.state, 'head');
  assert.equal(r.json.desire, 'nature');
  assert.equal(r.json.durationMin, 40, '30 → 40');
  assert.match(r.json.note, /植物が好き/, '全文を note にする');
  assert.ok(r.json.confirmText);
});

test('checkinParse_withInvalidJson_usesKeywordFallback', async () => {
  h.stubGemini(() => 'JSON ではない');
  const r = await parse({ transcript: '体がだるい。時間は気にしない。ゆっくり癒されたい' });
  assert.equal(r.status, 200);
  assert.equal(r.json.fallback, true);
  assert.equal(r.json.state, 'body');
  assert.equal(r.json.desire, 'calm');
  assert.equal(r.json.durationMin, null);
  assert.ok(!r.json.missing.includes('durationMin'), '"気にしない" は回答済み');
  h.stubGemini(() => 'null');
  assert.equal((await parse({ transcript: 'x' })).json.fallback, true);
});

test('checkinParse_keywordFallback_english', async () => {
  h.stubGemini(() => new Error('down'));
  const r = await parse({ transcript: 'I feel good and want to feel nature for an hour', lang: 'en' });
  assert.equal(r.json.state, 'ok');
  assert.equal(r.json.desire, 'nature');
  assert.equal(r.json.durationMin, 60);
});

test('checkinParse_fallbackKeepsCurrentForUnmentioned', async () => {
  h.stubGemini(() => new Error('down'));
  const r = await parse({ transcript: 'とくにありません', current: { state: 'low', desire: 'body', durationMin: 20 } });
  assert.equal(r.json.state, 'low');
  assert.equal(r.json.desire, 'body');
  assert.equal(r.json.durationMin, 20);
});

test('checkinParse_logsLlmUsageAndCheckinParseEvents', async () => {
  const s = await h.newSession(srv.base);
  llm({ state: 'ok', desire: null, durationMin: null, note: null });
  await parse({ transcript: '元気' }, s.headers);
  const ev = h.readEvents(dir).filter((e) => e.sessionId === s.sessionId);
  const usage = ev.find((e) => e.type === 'llm_usage');
  assert.equal(usage.purpose, 'checkin_parse');
  assert.ok(usage.costJpy > 0);
  const log = ev.find((e) => e.type === 'checkin_parse');
  assert.equal(log.fallback, false);
  assert.deepEqual(log.missing, ['desire', 'durationMin']);
  assert.equal(typeof log.latencyMs, 'number');
});

test('checkinParse_fallback_logsErrorAndFallbackTrue', async () => {
  const s = await h.newSession(srv.base);
  h.stubGemini(() => new Error('down'));
  await parse({ transcript: '元気' }, s.headers);
  const ev = h.readEvents(dir).filter((e) => e.sessionId === s.sessionId);
  assert.equal(ev.find((e) => e.type === 'error').where, 'llm-checkin');
  assert.equal(ev.find((e) => e.type === 'checkin_parse').fallback, true);
  assert.ok(!ev.some((e) => e.type === 'llm_usage'));
});

// ---------- 「決まっていない」系 = 時間は気にしない（回答済み） ----------
const UNDECIDED = ['特に決まっていない', '時間はおまかせします', 'お任せで', 'まだわからない', 'なんでもいいです', 'not sure', "I don't mind", 'whatever works'];

test('checkinParse_undecidedPhrases_keywordFallback_durationNullAndNotMissing', async () => {
  h.stubGemini(() => new Error('down'));
  for (const transcript of UNDECIDED) {
    const r = await parse({ transcript, lang: /[a-z]/i.test(transcript) ? 'en' : 'ja' });
    assert.equal(r.json.fallback, true);
    assert.equal(r.json.durationMin, null, transcript);
    assert.ok(!r.json.missing.includes('durationMin'), `${transcript} → missing=${r.json.missing}`);
  }
});

test('checkinParse_undecidedPhrases_withLlmNone_durationNullAndNotMissing', async () => {
  const stub = llm({ state: null, desire: null, durationMin: 'none', note: null });
  for (const transcript of UNDECIDED) {
    const r = await parse({ transcript });
    assert.equal(r.json.fallback, false);
    assert.equal(r.json.durationMin, null, transcript);
    assert.ok(!r.json.missing.includes('durationMin'), transcript);
  }
  const sys = stub.bodies[0].systemInstruction.parts[0].text;
  for (const phrase of ['特に決まっていない', 'おまかせ', 'not sure']) assert.ok(sys.includes(phrase), `プロンプトに ${phrase}`);
});

test('checkinParse_keywordFallback_explicitMinutesWinOverUndecidedWords', async () => {
  h.stubGemini(() => new Error('down'));
  const r = await parse({ transcript: '他はおまかせですが、20分でお願いします' });
  assert.equal(r.json.durationMin, 20);
});
