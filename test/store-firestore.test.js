'use strict';
// Firestore 版だけの動き（テスト用の Firestore で確かめる。本物にはつながない）:
// ドキュメントの形、Spot の古い版・重なり・大きさ・キャッシュ・止まったとき、名前空間、購入の重なり、録音の軌跡の削除
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./_helper');

h.setupEnv();
const { createFakeFirestore, fakeTokens } = require('./_fake-firestore');
const { createRest } = require('../lib/firestore/rest');
const { createFirestoreStore, fromConfig, restFromConfig } = require('../lib/store/firestore');
const { MAX_BACKUPS, MAX_CHUNKS } = require('../lib/store/common');
const { jstDay } = require('../lib/limits');
const { toFields } = require('../lib/firestore/encode');
const { RID } = require('./_store-contract');

function setup({ namespace = 'test', spotsNamespace, spotsCacheSec = 0, now, fake = createFakeFirestore() } = {}) {
  const rest = createRest({ projectId: 'p1', fetch: fake.fetch, tokens: fakeTokens(), sleep: async () => {} });
  return { fake, store: createFirestoreStore({ rest, namespace, spotsNamespace, spotsCacheSec, ...(now ? { now } : {}) }) };
}
const SPOT = (id, extra = {}) => ({ id, name: { ja: id }, lat: 35.68, lng: 139.75, materials: [], ...extra });
const today = jstDay();
const settle = () => new Promise((r) => setTimeout(r, 10)); // 裏での読み直しを待つ
const silence = () => { const real = console.error; console.error = () => {}; return () => { console.error = real; }; };

test('appendEvents_writesOneBatchDocumentWithDayAndTypes', async () => {
  const { fake, store } = setup();
  const ts = new Date().toISOString();
  assert.equal(await store.appendEvents([{ type: 'tts', ts }, { type: 'tts', ts }, { type: 'survey', ts, next: ['a'] }]), 3);
  const [name] = fake.list('envs/test/eventBatches/');
  assert.match(name, /^envs\/test\/eventBatches\/\d{13}-[0-9a-f]{8}$/);
  const f = fake.getFields(name);
  assert.equal(f.day.stringValue, today);
  assert.equal(f.n.integerValue, '3');
  assert.deepEqual(f.types.arrayValue.values.map((v) => v.stringValue), ['tts', 'survey']);
  assert.equal(f.events.arrayValue.values.length, 3);
});

test('appendEvents_dropsOnlyEventsFirestoreCannotStore', async () => {
  const { store } = setup();
  assert.equal(await store.appendEvents([{ type: 'a', '': 1 }, { type: 'b', __x__: 1 }, { type: 'c' }]), 1);
  assert.deepEqual((await store.listEvents({ fromDay: today, toDay: today, maxDocs: 10 })).events.map((e) => e.type), ['c']);
  assert.equal(await store.appendEvents([{ type: 'a', '': 1 }]), 0);
});

test('appendEvents_alreadyExistsOnRetry_countsAsWritten', async () => {
  const { fake, store } = setup();
  fake.failNext(1, 409, 'ALREADY_EXISTS');
  assert.equal(await store.appendEvents([{ type: 'x' }]), 1);
});

test('listEvents_usesDayField_andPagesPast100Documents', async () => {
  const { fake, store } = setup();
  fake.touch('envs/test/eventBatches/0000000000001-aaaaaaaa', toFields({ day: '2026-01-01', events: [{ type: 'old' }] }));
  for (let i = 0; i < 202; i++) await store.appendEvents([{ type: 'x', i }]);
  const runs = () => fake.calls.filter((c) => c.url.endsWith(':runQuery')).length;
  const before = runs();
  const { events, truncated } = await store.listEvents({ fromDay: today, toDay: today, maxDocs: 3000 });
  assert.equal(truncated, false);
  assert.equal(events.length, 202, '範囲外の日は読まない');
  assert.deepEqual(events.slice(0, 3).map((e) => e.i), [0, 1, 2], '書いた順');
  assert.equal(runs() - before, 3, '100 件ずつ');
  const old = await store.listEvents({ fromDay: '2026-01-01', toDay: '2026-01-01', maxDocs: 10 });
  assert.deepEqual(old.events.map((e) => e.type), ['old']);
});

test('listEvents_overMaxDocs_isTruncated', async () => {
  const { store } = setup();
  for (let i = 0; i < 5; i++) await store.appendEvents([{ type: 'x', i }]);
  const r = await store.listEvents({ fromDay: today, toDay: today, maxDocs: 3 });
  assert.equal(r.truncated, true);
  assert.deepEqual(r.events.map((e) => e.i), [2, 3, 4], '新しいほうを残し、書いた順に返す');
});

test('namespaces_keepRecordsApart_butSpotsCanBeShared', async () => {
  const fake = createFakeFirestore();
  const local = setup({ fake, namespace: 'local', spotsNamespace: 'preview' }).store;
  const preview = setup({ fake, namespace: 'preview' }).store;
  await local.appendEvents([{ type: 'local-only' }]);
  await local.createPurchase({ code: 'KG-000001', usedAt: null });
  assert.deepEqual((await preview.listEvents({ fromDay: today, toDay: today, maxDocs: 10 })).events, []);
  assert.equal(await preview.getPurchase('KG-000001'), null);
  await preview.updateSpots(() => ({ version: 2, spots: [SPOT('shared')] }));
  assert.deepEqual((await local.getSpots()).spots.map((s) => s.id), ['shared'], 'ローカルもお試し版と同じ Spot を読む');
  assert.ok(fake.list('envs/preview/data/spots').length === 1);
});

test('createFirestoreStore_withBadNamespace_throws', () => {
  const rest = createRest({ projectId: 'p1', fetch: async () => { throw new Error('no'); }, tokens: fakeTokens() });
  for (const ns of ['', 'Local', '1abc', 'a/b', 'a'.repeat(32), '../x']) assert.throws(() => createFirestoreStore({ rest, namespace: ns }), /STORE_NAMESPACE/);
  assert.throws(() => createFirestoreStore({ rest, namespace: 'ok', spotsNamespace: 'B' }), /SPOTS_NAMESPACE/);
});

test('fromConfig_withoutProject_throws_andWithProject_doesNotConnect', () => {
  assert.throws(() => fromConfig({ FIRESTORE_PROJECT_ID: '' }), /FIRESTORE_PROJECT_ID/);
  const realFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called++; throw new Error('no'); };
  try {
    const store = fromConfig({ FIRESTORE_PROJECT_ID: 'p1', FIRESTORE_DATABASE: '(default)', FIRESTORE_AUTH: 'metadata', STORE_NAMESPACE: 'preview', SPOTS_NAMESPACE: 'preview', SPOTS_CACHE_SEC: 30 });
    assert.equal(store.warmUp, undefined, 'メタデータサーバーのトークンは先に取らない');
    assert.throws(() => fromConfig({ FIRESTORE_PROJECT_ID: 'p1', FIRESTORE_AUTH: 'gcloud', GCLOUD_CONFIG: '', STORE_NAMESPACE: 'local' }), /GCLOUD_CONFIG/);
    assert.throws(() => restFromConfig({ FIRESTORE_PROJECT_ID: '' }), /FIRESTORE_PROJECT_ID/);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(called, 0, '作るときにはつながない');
});

test('getSpots_whenDocumentMissing_returnsEmptyList', async () => {
  const { store } = setup();
  assert.deepEqual(await store.getSpots(), { version: 2, spots: [] });
});

test('updateSpots_keepsOldVersionsInHistory_andOnlyNewest20', async () => {
  const { fake, store } = setup();
  let t = 1_700_000_000_000;
  const timed = setup({ fake, now: () => (t += 10) }).store;
  for (let i = 0; i < MAX_BACKUPS + 5; i++) await timed.updateSpots((cur) => ({ ...cur, spots: [SPOT(`s${i}`)] }));
  const history = fake.list('envs/test/spotsHistory/');
  assert.equal(history.length, MAX_BACKUPS);
  const newest = fake.getFields(history[history.length - 1]);
  assert.equal(newest.spots.arrayValue.values[0].mapValue.fields.id.stringValue, `s${MAX_BACKUPS + 3}`, '一番新しい履歴は 1 つ前の内容');
  assert.ok(!('updatedAt' in (await store.getSpots())), '保存先の印は外に出さない');
});

test('updateSpots_whenAnotherSaveSlipsIn_retriesOnceWithFreshData', async () => {
  const { fake, store } = setup();
  await store.updateSpots(() => ({ version: 2, spots: [SPOT('a')] }));
  fake.beforeCommit(() => fake.touch('envs/test/data/spots', toFields({ version: 2, spots: [SPOT('a'), SPOT('other')] })));
  const seen = [];
  await store.updateSpots((cur) => { seen.push(cur.spots.map((s) => s.id)); return { ...cur, spots: [...cur.spots, SPOT('mine')] }; });
  assert.deepEqual(seen, [['a'], ['a', 'other']], '読み直してもう 1 回');
  assert.deepEqual((await store.getSpots()).spots.map((s) => s.id), ['a', 'other', 'mine'], 'ほかの保存を消さない');
});

test('updateSpots_whenConflictsTwice_returns409', async () => {
  const { fake, store } = setup();
  await store.updateSpots(() => ({ version: 2, spots: [SPOT('a')] }));
  for (let i = 0; i < 2; i++) fake.beforeCommit(() => fake.touch('envs/test/data/spots', toFields({ version: 2, spots: [SPOT(`x${i}`)] })));
  await assert.rejects(store.updateSpots((cur) => cur), (e) => e.status === 409 && e.message === 'spots_conflict');
});

test('updateSpots_tooLarge_returns413WithoutWriting', async () => {
  const { fake, store } = setup();
  const big = 'あ'.repeat(310_000); // UTF-8 で 930KB
  await assert.rejects(store.updateSpots(() => ({ version: 2, spots: [SPOT('big', { materials: [{ text: big }] })] })), (e) => e.status === 413);
  assert.deepEqual(fake.list('envs/test/data/'), []);
});

test('updateSpots_withDataFirestoreCannotStore_returns400', async () => {
  const { store } = setup();
  await assert.rejects(store.updateSpots(() => ({ version: 2, spots: [SPOT('o', { osm: { tags: [[1, 2]] } })] })), (e) => e.status === 400);
});

test('getSpots_cachesForSpotsCacheSec_butOwnSaveIsSeenAtOnce', async () => {
  let t = 0;
  const { fake, store } = setup({ spotsCacheSec: 30, now: () => t });
  await store.updateSpots(() => ({ version: 2, spots: [SPOT('a')] }));
  const gets = () => fake.calls.filter((c) => c.method === 'GET').length;
  const g0 = gets();
  await store.getSpots();
  await store.getSpots();
  assert.equal(gets(), g0, '保存した内容をそのまま使う');
  fake.touch('envs/test/data/spots', toFields({ version: 2, spots: [SPOT('elsewhere')] }));
  assert.deepEqual((await store.getSpots()).spots.map((s) => s.id), ['a'], '30 秒のあいだはほかのインスタンスの保存が見えない');
  t = 31_000;
  const g1 = gets();
  const stale = await Promise.all([store.getSpots(), store.getSpots()]);
  assert.deepEqual(stale.map((d) => d.spots[0].id), ['a', 'a'], '過ぎたら、まず前の内容をすぐ返す');
  await settle();
  assert.equal(gets() - g1, 1, '裏で読み直すのは 1 回');
  assert.deepEqual((await store.getSpots()).spots.map((s) => s.id), ['elsewhere']);
});

test('getSpots_withoutCache_readsEveryTime', async () => {
  const { fake, store } = setup({ spotsCacheSec: 0 });
  await store.updateSpots(() => ({ version: 2, spots: [SPOT('a')] }));
  fake.touch('envs/test/data/spots', toFields({ version: 2, spots: [SPOT('elsewhere')] }));
  assert.deepEqual((await store.getSpots()).spots.map((s) => s.id), ['elsewhere']);
});

test('getSpots_whenFirestoreDown_usesLastGoodForUpToOneHour', async () => {
  let t = 0;
  const { fake, store } = setup({ spotsCacheSec: 30, now: () => t });
  await store.updateSpots(() => ({ version: 2, spots: [SPOT('a')] }));
  const restore = silence();
  try {
    t = 60_000;
    fake.failNext(3);
    assert.deepEqual((await store.getSpots()).spots.map((s) => s.id), ['a']);
    await settle();
    const n = fake.calls.length;
    t = 80_000;
    assert.deepEqual((await store.getSpots()).spots.map((s) => s.id), ['a']);
    await settle();
    assert.equal(fake.calls.length, n, '読めなかったあと 30 秒は読みに行かない');
    t = 3601_000;
    fake.failNext(3);
    await assert.rejects(store.getSpots(), (e) => e.message === 'store_unavailable' && e.status === 503);
    t = 3604_000;
    const m = fake.calls.length;
    await assert.rejects(store.getSpots(), (e) => e.status === 503, '使える内容がなく、5 秒たっていなければすぐ 503');
    assert.equal(fake.calls.length, m);
    t = 3607_000;
    assert.deepEqual((await store.getSpots()).spots.map((s) => s.id), ['a'], '使える内容がないときは 5 秒で読み直す');
  } finally {
    restore();
  }
});

test('getSpots_returnsTheSameFrozenObject_andUpdateSpotsGivesFnAWritableCopy', async () => {
  const { store } = setup({ spotsCacheSec: 30 });
  await store.updateSpots(() => ({ version: 2, spots: [SPOT('a')] }));
  const a = await store.getSpots();
  assert.equal(await store.getSpots(), a, '複製しない');
  assert.ok(Object.isFrozen(a.spots[0]));
  assert.throws(() => a.spots.push(SPOT('x')), TypeError);
  await store.updateSpots((cur) => { cur.spots.push(SPOT('b')); return cur; });
  assert.deepEqual((await store.getSpots()).spots.map((s) => s.id), ['a', 'b']);
});

test('finish_withVersionsInHand_doesNotReadAgain', async () => {
  const { fake, store } = setup();
  await store.createRecording({ id: RID, createdAt: 'c', status: 'recording', candidates: [] });
  await store.putRecordingChunk(RID, { index: 0, startedAt: 'a', durationSec: 1, segments: [] }, [{ t: 1, lat: 1, lng: 1, acc: 5 }]);
  const rec = await store.getRecording(RID);
  const n = fake.calls.length;
  const v1 = await store.setRecordingStatus(RID, { status: 'finishing' }, { ifStatus: rec.status, ifVersion: rec.version });
  assert.equal(typeof v1, 'string');
  assert.ok(await store.setRecordingStatus(RID, { status: 'finished', candidates: [] }, { ifStatus: 'finishing', ifVersion: v1, dropTrack: true }));
  assert.deepEqual(fake.calls.slice(n).map((c) => c.url.split(':').pop()), ['commit', 'runQuery', 'commit'], '本体は読み直さない（chunk は検索して全部の軌跡を消す）');
  assert.deepEqual((await store.getRecording(RID)).track, []);
  assert.equal(await store.setRecordingStatus(RID, { status: 'recording' }, { ifVersion: v1 }), false, '古い version では書かない');
});

test('getRecordingMeta_readsOnlyTheRecordingDocument', async () => {
  const { fake, store } = setup();
  await store.createRecording({ id: RID, createdAt: 'c', status: 'recording', candidates: [] });
  const n = fake.calls.length;
  assert.equal((await store.getRecordingMeta(RID)).status, 'recording');
  assert.deepEqual(fake.calls.slice(n).map((c) => c.method), ['GET']);
});

test('markPurchaseUsed_withVersionFromGetPurchase_writesWithoutReading', async () => {
  const { fake, store } = setup();
  await store.createPurchase({ code: 'KG-0000AA', usedAt: null });
  const p = await store.getPurchase('KG-0000AA');
  const n = fake.calls.length;
  assert.equal(await store.markPurchaseUsed('KG-0000AA', 'now', { ifVersion: p.version }), true);
  assert.equal(fake.calls.length - n, 1);
  assert.equal((await store.getPurchase('KG-0000AA')).usedAt, 'now');
});

test('markPurchaseUsed_whenAnotherInstanceMarksFirst_keepsTheirs', async () => {
  const { fake, store } = setup();
  await store.createPurchase({ code: 'KG-00000F', usedAt: null });
  fake.beforeCommit(() => fake.touch('envs/test/purchases/KG-00000F', toFields({ code: 'KG-00000F', usedAt: 'theirs' })));
  assert.equal(await store.markPurchaseUsed('KG-00000F', 'mine'), true);
  assert.equal((await store.getPurchase('KG-00000F')).usedAt, 'theirs');
});

test('ids_areCheckedBeforeTheyReachThePath', async () => {
  const { fake, store } = setup();
  const n = fake.calls.length;
  assert.equal(await store.getPurchase('../../x'), null);
  assert.equal(await store.getPurchase('KG-00000g'), null);
  await assert.rejects(store.createPurchase({ code: 'KG-1/../x' }), (e) => e.status === 400);
  await assert.rejects(store.getRecording('../spots'), (e) => e.status === 400);
  await assert.rejects(store.putRecordingChunk(RID, { index: 1.5 }, []), (e) => e.status === 400);
  await assert.rejects(store.putRecordingChunk(RID, { index: 1_000_000 }, []), (e) => e.status === 400);
  await assert.rejects(store.putRecordingChunk(RID, { index: MAX_CHUNKS }, []), (e) => e.status === 400, '読める数（MAX_CHUNKS）と合わせる');
  assert.equal(fake.calls.length, n, 'Firestore には送らない');
});

test('finishedRecording_removesTrackFromEveryChunkDocument', async () => {
  const { fake, store } = setup();
  await store.createRecording({ id: RID, createdAt: 'c', status: 'recording', candidates: [] });
  await store.putRecordingChunk(RID, { index: 0, startedAt: 'a', durationSec: 1, segments: [] }, [{ t: 1, lat: 1, lng: 1, acc: 5 }]);
  await store.putRecordingChunk(RID, { index: 1, startedAt: 'b', durationSec: 1, segments: [] }, [{ t: 2, lat: 1, lng: 1, acc: 5 }]);
  const chunks = fake.list(`envs/test/recordings/${RID}/chunks/`);
  assert.deepEqual(chunks.map((c) => c.slice(-6)), ['000000', '000001']);
  assert.ok(await store.setRecordingStatus(RID, { status: 'finished', candidates: [] }, { ifStatus: 'recording', dropTrack: true }));
  for (const c of chunks) assert.ok(!('track' in fake.getFields(c)), c);
});

test('setRecordingStatus_whenChangedAfterRead_returnsFalse', async () => {
  const { fake, store } = setup();
  await store.createRecording({ id: RID, createdAt: 'c', status: 'recording', candidates: [] });
  fake.beforeCommit(() => fake.touch(`envs/test/recordings/${RID}`, toFields({ id: RID, status: 'finishing' })));
  assert.equal(await store.setRecordingStatus(RID, { status: 'finishing' }, { ifStatus: 'recording' }), false, '同時に押された 2 回目は通さない');
});

test('chunk_afterFinishingStarted_isRejectedWithoutWritingTrack', async () => {
  const { fake, store } = setup();
  await store.createRecording({ id: RID, createdAt: 'c', status: 'recording', candidates: [] });
  const meta = await store.getRecordingMeta(RID); // chunk の受け付けで読んだ内容
  assert.ok(await store.setRecordingStatus(RID, { status: 'finishing' }, { ifStatus: 'recording', ifVersion: meta.version })); // 文字起こしの間に finish
  await assert.rejects(store.putRecordingChunk(RID, { index: 0, startedAt: 'a', durationSec: 1, segments: [] }, [{ t: 1, lat: 1, lng: 1, acc: 5 }], { ifVersion: meta.version }), (e) => e.status === 409);
  assert.deepEqual(fake.list(`envs/test/recordings/${RID}/chunks/`), [], 'chunk も軌跡も書かない');
});

test('chunk_whenAnotherChunkChangedVersion_rereadsAndWrites', async () => {
  const { store } = setup();
  await store.createRecording({ id: RID, createdAt: 'c', status: 'recording', candidates: [] });
  const meta = await store.getRecordingMeta(RID);
  await store.putRecordingChunk(RID, { index: 0, startedAt: 'a', durationSec: 1, segments: [] }, [], { ifVersion: meta.version });
  await store.putRecordingChunk(RID, { index: 1, startedAt: 'b', durationSec: 1, segments: [] }, [], { ifVersion: meta.version }); // 古い version
  assert.deepEqual((await store.getRecording(RID)).chunks.map((c) => c.index), [0, 1]);
});

test('createRecording_alreadyExistsOnRetry_isSuccess', async () => {
  const { fake, store } = setup();
  fake.failNext(1, 409, 'ALREADY_EXISTS');
  await store.createRecording({ id: RID, createdAt: 'c', status: 'recording', candidates: [] });
});

test('listPurchases_reportsTruncatedFlag', async () => {
  const { store } = setup();
  const { truncated } = await store.listPurchases();
  assert.equal(truncated, false);
});

test('missingSpotsDocument_warnsOnce', async () => {
  const { store } = setup();
  const warns = [];
  const real = console.warn;
  console.warn = (m) => warns.push(m);
  try {
    await store.getSpots();
    await store.getSpots();
  } finally {
    console.warn = real;
  }
  assert.equal(warns.length, 1);
});

test('backgroundRefresh_thatReadBeforeASave_doesNotOverwriteTheNewerCache', async () => {
  let t = 0;
  const fake = createFakeFirestore();
  let release = null;
  // GET はその場で読むが、応答を release まで遅らせる
  const fetch = (url, init) => {
    const res = fake.fetch(url, init);
    if (init.method !== 'GET' || !release) return res;
    const gate = release;
    release = null;
    return gate.then(() => res);
  };
  const rest = createRest({ projectId: 'p1', fetch, tokens: fakeTokens(), sleep: async () => {} });
  const store = createFirestoreStore({ rest, namespace: 'test', spotsCacheSec: 30, now: () => t });
  await store.updateSpots(() => ({ version: 2, spots: [SPOT('old')] }));
  t = 31_000;
  let open;
  release = new Promise((r) => { open = r; });
  assert.equal((await store.getSpots()).spots[0].id, 'old'); // 裏で読み直しが始まる（応答は止めてある）
  await store.updateSpots(() => ({ version: 2, spots: [SPOT('new')] }));
  open();
  await settle();
  assert.equal((await store.getSpots()).spots[0].id, 'new', '保存より前に読んだ内容で戻さない');
});

test('getRecording_readsChunksInSmallPages', async () => {
  const { fake, store } = setup();
  await store.createRecording({ id: RID, createdAt: 'c', status: 'recording', candidates: [] });
  const n = fake.calls.length;
  await store.getRecording(RID);
  const q = fake.calls.slice(n).find((c) => c.url.endsWith(':runQuery'));
  assert.ok(q.body.structuredQuery.limit <= 20, '軌跡を含む chunk は 20 件ずつ');
});
