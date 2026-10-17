'use strict';
// routes/guide.js（実 Gemini は呼ばない: fetch を googleapis 宛のみスタブ）
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./_helper');

const dir = h.setupEnv({ key: 'test-key-not-real' });
const { _test } = require('../routes/guide');
let srv;
let G; // ガイド用ヘッダ
before(async () => {
  srv = await h.startServer();
  const r = await h.api(srv.base, 'POST', '/api/guide/login', { body: { passcode: 'TEST-PASS' } });
  G = { 'X-Guide-Token': r.json.token };
});
after(async () => { await srv.close(); });

const call = (method, p, body, headers = G) => h.api(srv.base, method, p, { body, headers });
const GOOD = { name: { ja: '新しい場所' }, lat: 35.69, lng: 139.75 };
const AUDIO = 'A'.repeat(200);
const j = (o) => JSON.stringify(o);
const readSpots = () => JSON.parse(fs.readFileSync(path.join(dir, 'spots.json'), 'utf8')).spots;

// ---------- normalizeSpot ----------
test('normalizeSpot_withMinimalInput_fillsDefaults', () => {
  const sp = _test.normalizeSpot({ name: { ja: ' 松 ' }, lat: 35.123456789, lng: 139.5 }, 'pine');
  assert.equal(sp.id, 'pine');
  assert.equal(sp.name.ja, '松');
  assert.equal(sp.kind, 'other');
  assert.equal(sp.enabled, true);
  assert.equal(sp.radius, 40);
  assert.equal(sp.lat, 35.123457);
  assert.deepEqual(sp.materials, []);
  assert.deepEqual(sp.interactions, []);
  assert.equal(sp.osm, null);
  assert.ok(!('order' in sp));
});

test('normalizeSpot_invalidInputs_throw400', () => {
  const bad = [null, 'x', { name: { ja: 'a' }, lat: 'x', lng: 1 }, { name: { ja: 'a' }, lat: 91, lng: 1 }, { name: { ja: 'a' }, lat: 1, lng: 181 },
    { name: { ja: ' ', en: '' }, lat: 1, lng: 1 }, { lat: 1, lng: 1 }];
  for (const b of bad) assert.throws(() => _test.normalizeSpot(b, 'x'), (e) => e.status === 400, JSON.stringify(b));
});

test('normalizeSpot_radius_isRoundedAndClampedTo15to100', () => {
  const r = (v) => _test.normalizeSpot({ ...GOOD, radius: v }, 'x').radius;
  assert.equal(r(5), 15);
  assert.equal(r(500), 100);
  assert.equal(r(33.6), 34);
  assert.equal(r(undefined), 40);
});

test('normalizeSpot_kindAndEnabled', () => {
  assert.equal(_test.normalizeSpot({ ...GOOD, kind: 'bridge' }, 'x').kind, 'bridge');
  assert.equal(_test.normalizeSpot({ ...GOOD, kind: 'nonsense' }, 'x').kind, 'other');
  assert.equal(_test.normalizeSpot({ ...GOOD, enabled: false }, 'x').enabled, false);
  assert.equal(_test.normalizeSpot({ ...GOOD, enabled: 'no' }, 'x').enabled, true);
});

test('normalizeSpot_materials_areCleanedAndGetUniqueIds', () => {
  const sp = _test.normalizeSpot({ ...GOOD, materials: [
    { id: 'a', type: 'must', text: ' 必ず ', lang: 'en', topics: ['plant', 'bogus'], source: 'guide', verified: true, author: '山田' },
    { id: 'a', type: 'weird', text: '重複 id' },
    { type: 'story', text: 'id なし' },
    { text: '   ' },
    null,
    { type: 'fact' },
  ] }, 'sp');
  assert.equal(sp.materials.length, 3, '空テキストは捨てる');
  const [m1, m2, m3] = sp.materials;
  assert.equal(m1.id, 'a');
  assert.equal(m1.type, 'must');
  assert.equal(m1.text, '必ず');
  assert.equal(m1.lang, 'en');
  assert.deepEqual(m1.topics, ['plant']);
  assert.equal(m1.verified, true);
  assert.equal(m2.type, 'fact', '不正な type は fact');
  assert.equal(m2.lang, 'ja');
  assert.equal(m2.verified, false);
  assert.equal(m2.source, 'guide');
  assert.notEqual(m2.id, 'a');
  assert.ok(m2.id.startsWith('sp-m'));
  assert.equal(new Set([m1.id, m2.id, m3.id]).size, 3);
  assert.ok(m1.createdAt);
});

test('normalizeSpot_interactions_filteredAndSilenceClamped', () => {
  const sp = _test.normalizeSpot({ ...GOOD, interactions: [
    { type: 'LOOK' }, { type: 'DANCE' }, { type: 'SILENCE', seconds: 5 }, { type: 'SILENCE', seconds: 9999 }, { type: 'SILENCE' },
    { type: 'LISTEN', text: { ja: '耳を澄ます' } }, null,
  ] }, 'x');
  assert.deepEqual(sp.interactions.map((i) => i.type), ['LOOK', 'SILENCE', 'SILENCE', 'SILENCE', 'LISTEN']);
  assert.deepEqual(sp.interactions.filter((i) => i.type === 'SILENCE').map((i) => i.seconds), [10, 600, 60]);
  assert.equal(sp.interactions[4].text.ja, '耳を澄ます');
});

// ---------- PUT / DELETE /api/guide/spots/:id ----------
test('putSpot_withoutGuideToken_returns401', async () => {
  assert.equal((await call('PUT', '/api/guide/spots/abc', GOOD, {})).status, 401);
  const s = await h.newSession(srv.base);
  assert.equal((await call('PUT', '/api/guide/spots/abc', GOOD, s.headers)).status, 401, '体験者トークンでは不可');
});

test('putSpot_withInvalidId_returns400', async () => {
  for (const id of ['Bad_ID', 'UPPER', 'a.b', 'x'.repeat(61), 'sp%20ace']) {
    const r = await call('PUT', `/api/guide/spots/${id}`, GOOD);
    assert.equal(r.status, 400, id);
  }
});

test('putSpot_withInvalidBody_returns400', async () => {
  assert.equal((await call('PUT', '/api/guide/spots/abc', { name: { ja: 'x' }, lat: 'a', lng: 1 })).status, 400);
  assert.equal((await call('PUT', '/api/guide/spots/abc', { lat: 1, lng: 1 })).status, 400);
});

test('putSpot_newSpot_isCreatedWithNextOrderAndPersisted', async () => {
  const before = readSpots();
  const r = await call('PUT', '/api/guide/spots/new-one', { spot: { ...GOOD, materials: [{ text: 'a。' }] } }); // {spot:{}} 形式
  assert.equal(r.status, 200);
  assert.equal(r.json.created, true);
  assert.equal(r.json.spot.id, 'new-one');
  assert.equal(r.json.spot.order, Math.max(...before.map((s) => s.order || 0)) + 1);
  const saved = readSpots().find((s) => s.id === 'new-one');
  assert.ok(saved.materials[0].id.startsWith('new-one-m'));
  assert.equal(readSpots().length, before.length + 1);
});

test('putSpot_existingSpot_isReplacedAndKeepsOrder', async () => {
  const order = readSpots().find((s) => s.id === 't1').order;
  const r = await call('PUT', '/api/guide/spots/t1', { ...GOOD, name: { ja: '改名' } });
  assert.equal(r.json.created, false);
  assert.equal(r.json.spot.order, order);
  assert.equal(readSpots().find((s) => s.id === 't1').name.ja, '改名');
});

test('putSpot_bodyIdIsIgnored_urlIdWins', async () => {
  const r = await call('PUT', '/api/guide/spots/url-id', { ...GOOD, id: 'body-id' });
  assert.equal(r.json.spot.id, 'url-id');
  assert.ok(!readSpots().some((s) => s.id === 'body-id'));
});

test('deleteSpot_authInvalidIdNotFoundAndSuccess', async () => {
  assert.equal((await call('DELETE', '/api/guide/spots/url-id', undefined, {})).status, 401);
  assert.equal((await call('DELETE', '/api/guide/spots/BAD', undefined)).status, 400);
  assert.equal((await call('DELETE', '/api/guide/spots/ghost', undefined)).status, 404);
  const r = await call('DELETE', '/api/guide/spots/url-id', undefined);
  assert.equal(r.status, 200);
  assert.ok(!readSpots().some((s) => s.id === 'url-id'));
});

test('putSpots_all_requiresGuideAndValidArray', async () => {
  assert.equal((await call('PUT', '/api/spots', { spots: [] }, {})).status, 401);
  assert.equal((await call('PUT', '/api/spots', { spots: 'x' })).status, 400);
  assert.equal((await call('PUT', '/api/spots', { spots: [{ id: 'a' }] })).status, 400);
});

// ---------- extract ----------
test('extract_withoutGuideOrTranscript_returns401or400', async () => {
  assert.equal((await call('POST', '/api/guide/extract', { transcript: 'x' }, {})).status, 401);
  assert.equal((await call('POST', '/api/guide/extract', { transcript: '   ' })).status, 400);
  assert.equal((await call('POST', '/api/guide/extract', {})).status, 400);
});

test('extract_whenLlmFails_returnsWholeTranscriptAsOneMaterialFallback', async () => {
  h.stubGemini(() => new Error('down'));
  const r = await call('POST', '/api/guide/extract', { transcript: 'ここに大きな松があります。', lang: 'ja' });
  assert.equal(r.status, 200);
  assert.equal(r.json.fallback, true);
  assert.equal(r.json.materials.length, 1);
  assert.equal(r.json.materials[0].text, 'ここに大きな松があります。');
  assert.equal(r.json.materials[0].source, 'recording');
  assert.equal(r.json.materials[0].verified, false);
  assert.deepEqual(r.json.interactions, []);
});

test('extract_fallbackWithEnglish_setsLangEn', async () => {
  h.stubGemini(() => new Error('down'));
  const r = await call('POST', '/api/guide/extract', { transcript: 'A big pine.', lang: 'en' });
  assert.equal(r.json.materials[0].lang, 'en');
});

test('extract_whenLlmReturnsEmptyMaterialsOrBadJson_fallsBack', async () => {
  h.stubGemini(() => j({ materials: [] }));
  assert.equal((await call('POST', '/api/guide/extract', { transcript: 'abc。' })).json.fallback, true);
  h.stubGemini(() => 'not json');
  assert.equal((await call('POST', '/api/guide/extract', { transcript: 'abc。' })).json.fallback, true);
});

test('extract_withLlmSuccess_returnsSanitizedMaterials', async () => {
  await call('PUT', '/api/guide/spots/ext-spot', { ...GOOD, materials: [{ text: '足元に注意してください。' }] });
  const stub = h.stubGemini(() => j({
    name: { ja: '黒松', en: 'Black Pine' }, kind: 'trees',
    materials: [
      { id: 'evil-id', type: 'story', text: ' 話 1。 ', topics: ['plant', 'zzz'], source: 'guide', verified: true },
      { type: 'nonsense', text: '話 2。' },
      { type: 'fact', text: '' },
    ],
    interactions: [{ type: 'LOOK' }, { type: 'FLY' }],
  }));
  const r = await call('POST', '/api/guide/extract', { transcript: '黒松の話をします。', spotId: 'ext-spot', lang: 'ja' });
  assert.equal(r.status, 200);
  assert.equal(r.json.fallback, false);
  assert.deepEqual(r.json.name, { ja: '黒松', en: 'Black Pine' });
  assert.equal(r.json.kind, 'trees');
  assert.equal(r.json.materials.length, 2);
  for (const m of r.json.materials) {
    assert.equal(m.source, 'recording', 'LLM が source を詐称できない');
    assert.equal(m.verified, false, '未確認で登録される');
    assert.ok(!('id' in m), 'LLM 指定の id は使わない');
  }
  assert.equal(r.json.materials[0].text, '話 1。');
  assert.deepEqual(r.json.materials[0].topics, ['plant']);
  assert.equal(r.json.materials[1].type, 'fact');
  assert.deepEqual(r.json.interactions, [{ type: 'LOOK' }]);
  // 既存素材が重複回避のためプロンプトに入り、「話していない事実を足さない」規則が系統指示にある
  const prompt = stub.bodies[0].contents[0].parts[0].text;
  assert.match(prompt, /足元に注意/);
  assert.match(prompt, /黒松の話をします/);
  assert.match(stub.bodies[0].systemInstruction.parts[0].text, /Never add facts/);
});

test('extract_withInvalidKindOrName_omitsThem', async () => {
  h.stubGemini(() => j({ name: '', kind: 'castle', materials: [{ type: 'fact', text: 'a。' }] }));
  const r = await call('POST', '/api/guide/extract', { transcript: 'a。' });
  assert.ok(!('name' in r.json));
  assert.ok(!('kind' in r.json));
});

// ---------- transcribe ----------
test('transcribe_withoutGuide_returns401', async () => {
  assert.equal((await call('POST', '/api/guide/transcribe', { audioBase64: AUDIO, mimeType: 'audio/webm' }, {})).status, 401);
});

test('transcribe_withInvalidMimeType_returns400', async () => {
  const stub = h.stubGemini(() => 'x');
  for (const mimeType of ['text/plain', 'video/mp4', '', undefined, 'audio/', 'audio/we bm', 'image/png']) {
    const r = await call('POST', '/api/guide/transcribe', { audioBase64: AUDIO, mimeType });
    assert.equal(r.status, 400, String(mimeType));
  }
  assert.equal(stub.calls, 0);
});

test('transcribe_withTooShortAudio_returns400', async () => {
  const stub = h.stubGemini(() => 'x');
  for (const audioBase64 of ['', 'A'.repeat(99), undefined, 123]) {
    const r = await call('POST', '/api/guide/transcribe', { audioBase64, mimeType: 'audio/webm' });
    assert.equal(r.status, 400, String(audioBase64));
  }
  assert.equal((await call('POST', '/api/guide/transcribe', { audioBase64: 'A'.repeat(100), mimeType: 'audio/webm' })).status, 200, '100 文字はちょうど可');
  assert.equal(stub.calls, 1);
});

test('transcribe_withMimeParams_isNormalizedAndSentToLlm', async () => {
  const stub = h.stubGemini(() => '  こんにちは  ');
  const r = await call('POST', '/api/guide/transcribe', { audioBase64: AUDIO, mimeType: 'Audio/WebM;codecs=opus', lang: 'ja' });
  assert.equal(r.status, 200);
  assert.equal(r.json.text, 'こんにちは');
  const part = stub.bodies[0].contents[0].parts[0].inlineData;
  assert.equal(part.mimeType, 'audio/webm');
  assert.equal(part.data, AUDIO);
});

test('transcribe_whenLlmFails_returns502', async () => {
  h.stubGemini(() => new Error('down'));
  const r = await call('POST', '/api/guide/transcribe', { audioBase64: AUDIO, mimeType: 'audio/webm' });
  assert.equal(r.status, 502);
});

// ---------- detectPlaces ----------
const T0 = 1_700_000_000_000;
const LAT = 35.68;
const LNG = 139.756;
const M = 111_320;
const pt = (sec, northM = 0, acc = 5, eastM = 0) => ({ t: T0 + sec * 1000, lat: LAT + northM / M, lng: LNG + eastM / (M * Math.cos((LAT * Math.PI) / 180)), acc });
const seg = (s0, s1, text) => ({ t0: T0 + s0 * 1000, t1: T0 + s1 * 1000, text });
const stayTrack = (from, to, northM = 0) => { const a = []; for (let s = from; s <= to; s += 5) a.push(pt(s, northM)); return a; };
const LONG = 'ここには大きな松の木があります。';

test('detectPlaces_withEmptyInputs_returnsEmpty', () => {
  assert.deepEqual(_test.detectPlaces([], []), []);
  assert.deepEqual(_test.detectPlaces(stayTrack(0, 60), []), []);
  assert.deepEqual(_test.detectPlaces([], [seg(0, 5, LONG)]), []);
});

test('detectPlaces_stayWithSpeech_yieldsOneNonWalkingCandidate', () => {
  const c = _test.detectPlaces(stayTrack(0, 40), [seg(10, 20, LONG)]);
  assert.equal(c.length, 1);
  assert.equal(c[0].walking, false);
  assert.equal(c[0].transcript, LONG);
  assert.ok(Math.abs(c[0].lat - LAT) < 1e-5);
  assert.ok(c[0].radius >= 20 && c[0].radius <= 50);
  assert.equal(c[0].t0, T0);
  assert.equal(c[0].t1, T0 + 40_000);
});

test('detectPlaces_shortUtterance_under15Chars_isDropped', () => {
  assert.equal(_test.detectPlaces(stayTrack(0, 40), [seg(10, 12, 'いい木ですね')]).length, 0);
  assert.equal(_test.detectPlaces(stayTrack(0, 40), [seg(10, 12, '１２３４５ ６７８９０ １２３４')]).length, 0, '空白は数えない（14 文字）');
  assert.equal(_test.detectPlaces(stayTrack(0, 40), [seg(10, 12, '一二三四五六七八九十一二三四五')]).length, 1, '15 文字はちょうど可');
});

test('detectPlaces_shortUtterancesInSameStay_areCombined', () => {
  const c = _test.detectPlaces(stayTrack(0, 40), [seg(5, 8, 'いい木です。'), seg(15, 18, 'とても大きいです。')]);
  assert.equal(c.length, 1);
  assert.equal(c[0].transcript, 'いい木です。\nとても大きいです。');
});

test('detectPlaces_stayShorterThan20s_isNotAStay_speechBecomesWalkingCandidate', () => {
  const c = _test.detectPlaces(stayTrack(0, 15), [seg(5, 10, LONG)]);
  assert.equal(c.length, 1);
  assert.equal(c[0].walking, true);
  assert.equal(c[0].radius, 30);
});

test('detectPlaces_movingTrack_hasNoStay', () => {
  const track = []; for (let s = 0; s <= 60; s += 5) track.push(pt(s, s * 3)); // 3 m/s（小走り）。1.4 m/s だと 20m 以内に 20 秒以上いるので滞在扱いになる（報告済みの観察）
  const c = _test.detectPlaces(track, [seg(10, 20, LONG)]);
  assert.equal(c.length, 1);
  assert.equal(c[0].walking, true);
});

test('detectPlaces_twoStaysFarApart_giveTwoCandidatesSortedByTime', () => {
  const track = [...stayTrack(0, 40, 0), ...stayTrack(100, 140, 200)];
  const c = _test.detectPlaces(track, [seg(110, 120, 'ここは二つ目の場所で、とても静かです。'), seg(10, 20, LONG)]);
  assert.equal(c.length, 2);
  assert.ok(c[0].t0 < c[1].t0);
  assert.equal(c[0].transcript, LONG);
  assert.ok(Math.abs((c[1].lat - c[0].lat) * M - 200) < 5);
});

test('detectPlaces_poorAccuracyPointsOver60m_areIgnored', () => {
  const track = [...stayTrack(0, 40), pt(22, 500, 100), pt(23, -500, 120)]; // 大きくずれた低精度点
  const c = _test.detectPlaces(track, [seg(10, 20, LONG)]);
  assert.equal(c.length, 1);
  assert.equal(c[0].walking, false);
  assert.ok(Math.abs(c[0].lat - LAT) < 1e-4);
});

test('detectPlaces_unsortedTrack_isHandled', () => {
  const c = _test.detectPlaces(stayTrack(0, 40).reverse(), [seg(10, 20, LONG)]);
  assert.equal(c.length, 1);
  assert.equal(c[0].walking, false);
});

test('detectPlaces_speechShortlyAfterStay_isAbsorbedIntoStay', () => {
  const c = _test.detectPlaces(stayTrack(0, 40), [seg(50, 55, LONG)]); // 滞在終了の 10 秒後 + 近傍
  assert.equal(c.length, 1);
  assert.equal(c[0].walking, false);
});

// ---------- recordings ----------
const UUID0 = '00000000-0000-4000-8000-000000000000';
const recFile = (rid) => path.join(dir, 'logs', 'recordings', `${rid}.json`);
const isoAt = (ms) => new Date(ms).toISOString();

test('recordings_withoutGuide_returns401', async () => {
  assert.equal((await call('POST', '/api/guide/recordings', {}, {})).status, 401);
  assert.equal((await call('GET', `/api/guide/recordings/${UUID0}`, undefined, {})).status, 401);
  assert.equal((await call('POST', `/api/guide/recordings/${UUID0}/finish`, {}, {})).status, 401);
});

test('recordings_ridValidation_rejectsNonUuidAnd404ForUnknown', async () => {
  for (const rid of ['abc', '..%2F..%2Fspots', 'A'.repeat(36), `${UUID0}x`]) {
    for (const [m, suffix] of [['GET', ''], ['POST', '/finish'], ['POST', '/chunk']]) {
      const r = await call(m, `/api/guide/recordings/${rid}${suffix}`, m === 'POST' ? {} : undefined);
      assert.equal(r.status, 400, `${m} ${rid}${suffix} -> ${r.status}`);
    }
  }
  assert.equal((await call('GET', `/api/guide/recordings/${UUID0}`)).status, 404);
  assert.equal((await call('POST', `/api/guide/recordings/${UUID0}/finish`, {})).status, 404);
});

test('recordings_create_returnsIdAndGetShowsRecordingState', async () => {
  const c = await call('POST', '/api/guide/recordings', {});
  assert.equal(c.status, 200);
  assert.match(c.json.recordingId, /^[0-9a-f-]{36}$/);
  const g = await call('GET', `/api/guide/recordings/${c.json.recordingId}`);
  assert.equal(g.json.status, 'recording');
  assert.deepEqual(g.json.chunks, []);
  assert.deepEqual(g.json.candidates, []);
});

test('chunk_validation_requiresStartedAtAndIndex', async () => {
  const { json: { recordingId: rid } } = await call('POST', '/api/guide/recordings', {});
  const url = `/api/guide/recordings/${rid}/chunk`;
  assert.equal((await call('POST', url, { index: 0 })).status, 400);
  assert.equal((await call('POST', url, { startedAt: 'garbage', index: 0 })).status, 400);
  assert.equal((await call('POST', url, { startedAt: isoAt(T0) })).status, 400);
  assert.equal((await call('POST', url, { startedAt: isoAt(T0), index: -1 })).status, 400);
  assert.equal((await call('POST', url, { startedAt: isoAt(T0), index: 1.5 })).status, 400);
});

test('chunk_trackOnlyWithoutAudio_isAcceptedWithoutCallingLlm', async () => {
  const stub = h.stubGemini(() => { throw new Error('should not be called'); });
  const { json: { recordingId: rid } } = await call('POST', '/api/guide/recordings', {});
  const track = [...stayTrack(0, 20), { t: 'x', lat: 1, lng: 1 }, { t: T0, lat: NaN, lng: 1 }, null];
  const r = await call('POST', `/api/guide/recordings/${rid}/chunk`, { startedAt: isoAt(T0), index: 0, durationSec: 300, track });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.segments, 0);
  assert.equal(stub.calls, 0);
  // 同じ時刻の点を再送しても重複しない
  await call('POST', `/api/guide/recordings/${rid}/chunk`, { startedAt: isoAt(T0), index: 1, track: stayTrack(0, 30) });
  const saved = JSON.parse(fs.readFileSync(recFile(rid), 'utf8'));
  assert.equal(saved.track.length, 7, '0..30 秒 5 秒刻み = 7 点（不正な点は除外・重複は無し）');
  assert.equal(saved.chunks.length, 2);
});

test('chunk_withInvalidMimeTypeAndAudio_returns400', async () => {
  h.stubGemini(() => j({ segments: [] }));
  const { json: { recordingId: rid } } = await call('POST', '/api/guide/recordings', {});
  const r = await call('POST', `/api/guide/recordings/${rid}/chunk`, { startedAt: isoAt(T0), index: 0, audioBase64: AUDIO, mimeType: 'text/plain' });
  assert.equal(r.status, 400);
});

test('chunk_whenTranscriptionFails_recordsErrorButKeepsTrack', async () => {
  h.stubGemini(() => new Error('down'));
  const { json: { recordingId: rid } } = await call('POST', '/api/guide/recordings', {});
  const r = await call('POST', `/api/guide/recordings/${rid}/chunk`, { startedAt: isoAt(T0), index: 0, audioBase64: AUDIO, mimeType: 'audio/webm', track: stayTrack(0, 10) });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
  assert.ok(r.json.error);
  assert.equal(JSON.parse(fs.readFileSync(recFile(rid), 'utf8')).track.length, 3);
  const g = await call('GET', `/api/guide/recordings/${rid}`);
  assert.ok(g.json.chunks[0].error);
});

test('recordingFlow_createChunkFinish_detectsPlaceDropsTrackAndStoresNoAudio', async () => {
  const stub = h.stubGemini((n, body) => {
    const sys = body.systemInstruction.parts[0].text;
    if (/verbatim transcriber/.test(sys)) return j({ segments: [{ start: 10, end: 20, text: LONG }] });
    return j({ places: [{ index: 0, name: { ja: '松の場所', en: 'Pine' }, kind: 'trees', materials: [{ type: 'fact', text: LONG, topics: ['plant'] }], interactions: [{ type: 'LOOK' }] }] });
  });
  const { json: { recordingId: rid } } = await call('POST', '/api/guide/recordings', {});
  const ch = await call('POST', `/api/guide/recordings/${rid}/chunk`, {
    startedAt: isoAt(T0), index: 0, durationSec: 60, lang: 'ja', audioBase64: AUDIO, mimeType: 'audio/webm;codecs=opus', track: stayTrack(0, 40),
  });
  assert.equal(ch.json.ok, true);
  assert.equal(ch.json.segments, 1);
  assert.ok(!fs.readFileSync(recFile(rid), 'utf8').includes(AUDIO), '音声は保存しない');

  const fin = await call('POST', `/api/guide/recordings/${rid}/finish`, {});
  assert.equal(fin.status, 200);
  assert.equal(fin.json.candidates.length, 1);
  const c = fin.json.candidates[0];
  assert.equal(c.name.ja, '松の場所');
  assert.equal(c.kind, 'trees');
  assert.equal(c.walking, false);
  assert.equal(c.materials[0].source, 'recording');
  assert.equal(c.materials[0].verified, false);
  assert.deepEqual(c.interactions, [{ type: 'LOOK' }]);
  assert.ok('nearestSpotId' in c);
  assert.equal(c.transcript, LONG);
  assert.ok(Math.abs(c.lat - LAT) < 1e-4);
  assert.ok(c.radius >= 20 && c.radius <= 50);

  const saved = JSON.parse(fs.readFileSync(recFile(rid), 'utf8'));
  assert.equal(saved.status, 'finished');
  assert.ok(!('track' in saved), 'finish 後は軌跡の点列を削除');
  assert.equal(saved.candidates.length, 1);

  // 再度 finish しても同じ結果（LLM を再度呼ばない）
  const calls = stub.calls;
  const again = await call('POST', `/api/guide/recordings/${rid}/finish`, {});
  assert.deepEqual(again.json.candidates, fin.json.candidates);
  assert.equal(stub.calls, calls);

  // finish 後の chunk は 409、GET は finished
  const late = await call('POST', `/api/guide/recordings/${rid}/chunk`, { startedAt: isoAt(T0), index: 9 });
  assert.equal(late.status, 409);
  assert.equal((await call('GET', `/api/guide/recordings/${rid}`)).json.status, 'finished');
});

test('finish_candidateNearExistingSpot_reportsNearestSpotId', async () => {
  // テスト用 Spot t1 は (35.68, 139.756)。軌跡はその上
  const spots = readSpots();
  const target = spots.find((s) => s.id === 't1') || spots[0];
  h.stubGemini((n, body) => (/verbatim transcriber/.test(body.systemInstruction.parts[0].text)
    ? j({ segments: [{ start: 10, end: 20, text: LONG }] }) : j({ places: [] })));
  const { json: { recordingId: rid } } = await call('POST', '/api/guide/recordings', {});
  const track = []; for (let s = 0; s <= 40; s += 5) track.push({ t: T0 + s * 1000, lat: target.lat, lng: target.lng, acc: 5 });
  await call('POST', `/api/guide/recordings/${rid}/chunk`, { startedAt: isoAt(T0), index: 0, durationSec: 60, audioBase64: AUDIO, mimeType: 'audio/webm', track });
  const fin = await call('POST', `/api/guide/recordings/${rid}/finish`, {});
  assert.equal(fin.json.candidates[0].nearestSpotId, target.id);
});

test('finish_whenLlmFails_usesTranscriptAsMaterialAndDefaultName', async () => {
  h.stubGemini((n, body) => {
    if (/verbatim transcriber/.test(body.systemInstruction.parts[0].text)) return j({ segments: [{ start: 10, end: 20, text: LONG }] });
    return new Error('down');
  });
  const { json: { recordingId: rid } } = await call('POST', '/api/guide/recordings', {});
  await call('POST', `/api/guide/recordings/${rid}/chunk`, { startedAt: isoAt(T0), index: 0, durationSec: 60, audioBase64: AUDIO, mimeType: 'audio/webm', track: stayTrack(0, 40, 3000) });
  const fin = await call('POST', `/api/guide/recordings/${rid}/finish`, {});
  assert.equal(fin.status, 200);
  const c = fin.json.candidates[0];
  assert.equal(c.name.ja, '録音地点 1');
  assert.equal(c.materials[0].text, LONG);
  assert.equal(c.nearestSpotId, null, '30m 以内に Spot が無い');
});

test('finish_withNoSpeech_returnsNoCandidates', async () => {
  const stub = h.stubGemini(() => j({ segments: [] }));
  const { json: { recordingId: rid } } = await call('POST', '/api/guide/recordings', {});
  await call('POST', `/api/guide/recordings/${rid}/chunk`, { startedAt: isoAt(T0), index: 0, durationSec: 60, audioBase64: AUDIO, mimeType: 'audio/webm', track: stayTrack(0, 40) });
  const calls = stub.calls;
  const fin = await call('POST', `/api/guide/recordings/${rid}/finish`, {});
  assert.deepEqual(fin.json.candidates, []);
  assert.equal(stub.calls, calls, '候補が無ければ抽出 LLM は呼ばない');
});
