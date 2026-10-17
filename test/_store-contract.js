'use strict';
// どの保存先（file・memory・Firestore）でも同じように動くことを確かめるテスト。
// makeStore() は { store, spots } を返す（spots = 最初に入っている Spot）。各テストで新しく作るので、テスト同士は影響しない
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { jstDay } = require('../lib/limits');

const SPOTS = { version: 2, spots: [{ id: 'a', name: { ja: 'あ' }, lat: 35.68, lng: 139.75, materials: [] }] };
const RID = '11111111-2222-4333-8444-555555555555';
const today = () => jstDay();
const purchase = (code, extra = {}) => ({ code, plan: 'ai40', lang: 'ja', priceJpy: 2000, createdAt: '2026-10-17T00:00:00.000Z', usedAt: null, ...extra });

function runStoreContract(name, makeStore) {
  const t = (title, fn) => test(`${name}: ${title}`, async () => fn(await makeStore()));

  t('getSpots_returnsInitialSpots', async ({ store }) => {
    const data = await store.getSpots();
    assert.equal(data.version, 2);
    assert.deepEqual(data.spots.map((s) => s.id), ['a']);
  });

  t('getSpots_changingReturnedObject_doesNotChangeStore', async ({ store }) => {
    const data = await store.getSpots();
    try { data.spots.push({ id: 'x' }); } catch { /* 使い回す内容は変えられない（Firestore 版） */ }
    assert.equal((await store.getSpots()).spots.length, 1);
  });

  t('updateSpots_savesFnResultAndReturnsIt', async ({ store }) => {
    const seen = [];
    const out = await store.updateSpots((cur) => { seen.push(cur.spots.length); return { ...cur, spots: [...cur.spots, { id: 'b', name: { ja: 'い' }, lat: 1, lng: 2, materials: [] }] }; });
    assert.deepEqual(seen, [1]);
    assert.deepEqual(out.spots.map((s) => s.id), ['a', 'b']);
    assert.deepEqual((await store.getSpots()).spots.map((s) => s.id), ['a', 'b']);
  });

  t('updateSpots_whenFnThrows_keepsOldSpots', async ({ store }) => {
    await assert.rejects(store.updateSpots(() => { throw Object.assign(new Error('spot not found'), { status: 404 }); }), /spot not found/);
    assert.deepEqual((await store.getSpots()).spots.map((s) => s.id), ['a']);
  });

  t('appendEvents_thenListEvents_returnsTodayEventsInOrder', async ({ store }) => {
    const ts = new Date().toISOString();
    assert.equal(await store.appendEvents([{ type: 'x', ts, n: 1 }, { type: 'y', ts, n: 2 }]), 2);
    assert.equal(await store.appendEvents([{ type: 'z', ts, n: 3, list: ['a', 'b'], ok: true, none: null, ratio: 0.5 }]), 1);
    const { events, truncated } = await store.listEvents({ fromDay: today(), toDay: today(), maxDocs: 100 });
    assert.equal(truncated, false);
    assert.deepEqual(events.map((e) => e.n), [1, 2, 3]);
    assert.deepEqual(events[2], { type: 'z', ts, n: 3, list: ['a', 'b'], ok: true, none: null, ratio: 0.5 }, '型をそのまま戻す');
  });

  t('appendEvents_withEmptyList_returnsZero', async ({ store }) => {
    assert.equal(await store.appendEvents([]), 0);
  });

  t('listEvents_outsideRange_returnsNothing', async ({ store }) => {
    await store.appendEvents([{ type: 'x', ts: new Date().toISOString() }]);
    const { events } = await store.listEvents({ fromDay: '2000-01-01', toDay: '2000-01-02', maxDocs: 100 });
    assert.deepEqual(events, []);
  });

  t('purchases_createGetListAndDuplicate', async ({ store }) => {
    assert.equal(await store.getPurchase('KG-00000A'), null);
    await store.createPurchase(purchase('KG-00000A'));
    const { version, ...saved } = await store.getPurchase('KG-00000A'); // version は保存先が付ける印（Firestore 版だけ）
    assert.deepEqual(saved, purchase('KG-00000A'));
    await assert.rejects(store.createPurchase(purchase('KG-00000A', { lang: 'en' })), (e) => e.code === 'exists');
    assert.equal((await store.getPurchase('KG-00000A')).lang, 'ja', '重なったら上書きしない');
    await store.createPurchase(purchase('KG-00000B'));
    const { purchases, truncated } = await store.listPurchases();
    assert.deepEqual(purchases.map((p) => p.code).sort(), ['KG-00000A', 'KG-00000B']);
    assert.equal(truncated, false);
  });

  t('markPurchaseUsed_setsUsedAtOnlyOnce', async ({ store }) => {
    await store.createPurchase(purchase('KG-0000C1'));
    await store.markPurchaseUsed('KG-0000C1', '2026-10-17T01:00:00.000Z');
    await store.markPurchaseUsed('KG-0000C1', '2026-10-17T02:00:00.000Z');
    assert.equal((await store.getPurchase('KG-0000C1')).usedAt, '2026-10-17T01:00:00.000Z');
    assert.equal(await store.markPurchaseUsed('KG-FFFFFF', 'x'), false, 'ないコードは何もしない');
  });

  t('recordings_createChunkStatusAndFinish', async ({ store }) => {
    assert.equal(await store.getRecording(RID), null);
    await store.createRecording({ id: RID, createdAt: '2026-10-17T00:00:00.000Z', status: 'recording', candidates: [] });
    const fresh = await store.getRecording(RID);
    assert.equal(fresh.status, 'recording');
    assert.equal((await store.getRecordingMeta(RID)).status, 'recording');
    assert.equal(await store.getRecordingMeta('22222222-2222-4333-8444-555555555555'), null);
    assert.deepEqual(fresh.chunks, []);
    assert.deepEqual(fresh.track, []);
    const pt = (t) => ({ t, lat: 35, lng: 139, acc: 5 });
    await store.putRecordingChunk(RID, { index: 1, startedAt: 'b', durationSec: 60, segments: [{ t0: 1, t1: 2, text: 'こんにちは' }] }, [pt(3), pt(4)]);
    await store.putRecordingChunk(RID, { index: 0, startedAt: 'a', durationSec: 60, segments: [], error: 'transcribe_failed' }, [pt(1), pt(2), pt(3)]);
    await store.putRecordingChunk(RID, { index: 0, startedAt: 'a', durationSec: 30, segments: [] }, [pt(1), pt(2)]); // 送り直し
    const rec = await store.getRecording(RID);
    assert.deepEqual(rec.chunks.map((c) => [c.index, c.durationSec]), [[0, 30], [1, 60]], '同じ番号は置き換え、番号順');
    assert.deepEqual(rec.chunks[1].segments, [{ t0: 1, t1: 2, text: 'こんにちは' }]);
    assert.deepEqual(rec.track.map((p) => p.t).sort((x, y) => x - y), [1, 2, 3, 4], '同じ時刻の点は 1 つだけ');

    assert.equal(await store.setRecordingStatus(RID, { status: 'finishing', finishingAt: 'f' }, { ifStatus: 'finished' }), false, '状態が違えば変えない');
    assert.ok(await store.setRecordingStatus(RID, { status: 'finishing', finishingAt: 'f' }, { ifStatus: 'recording' }), '書けたら true か新しい version');
    assert.equal((await store.getRecording(RID)).finishingAt, 'f');
    const candidates = [{ lat: 35, lng: 139, name: { ja: 'x' }, materials: [] }];
    assert.ok(await store.setRecordingStatus(RID, { status: 'finished', finishedAt: 'g', candidates }, { ifStatus: 'finishing', dropTrack: true }));
    const done = await store.getRecording(RID);
    assert.equal(done.status, 'finished');
    assert.deepEqual(done.candidates, candidates);
    assert.deepEqual(done.track, [], '終わったら軌跡は消す');
    assert.equal(done.chunks.length, 2, '文字起こしの記録は残す');
    await assert.rejects(store.putRecordingChunk(RID, { index: 5, startedAt: 'z', durationSec: 1, segments: [] }, [pt(9)]), (e) => e.status === 409, '終わったあとの chunk は受け付けない');
    const after = await store.getRecording(RID);
    assert.equal(after.chunks.length, 2);
    assert.deepEqual(after.track, [], '軌跡も書かない');
  });

  t('setRecordingStatus_forUnknownRecording_returnsFalse', async ({ store }) => {
    assert.equal(await store.setRecordingStatus(RID, { status: 'finishing' }, { ifStatus: 'recording' }), false);
  });
}

module.exports = { runStoreContract, SPOTS, RID };
