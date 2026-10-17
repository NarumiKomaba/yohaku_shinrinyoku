'use strict';
// 保存先が止まったとき（メモリ版で故障を起こす）: イベントは 200 で accepted:0、購入と購入コードの確認は 503、デモコードは通る、
// Spot・ガイドさんの保存・集計は 503。あわせて、購入コードの確認は先に失敗として数えて見つかれば取り消すこと、集計の日数、終了時の書き出し
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./_helper');

const dir = h.setupEnv({ extraEnv: { STORE_BACKEND: 'memory', TRUSTED_PROXY_HOPS: '1' } });
// routes が読み込む前に、故障を起こせる保存先に入れ替える（createStore(backend) の差し込み口を使う）
const store = require('../lib/store');
const { createMemoryStore } = require('../lib/store/memory');
const faults = h.withFaults(createMemoryStore({ dataDir: dir }));
Object.assign(store, store.createStore(faults.backend));
const { createSession } = require('../lib/auth');
let srv;
let G;
before(async () => {
  srv = await h.startServer();
  G = { 'X-Guide-Token': (await h.api(srv.base, 'POST', '/api/guide/login', { body: { passcode: 'TEST-PASS' } })).json.token };
});
after(async () => { await srv.close(); });
afterEach(() => faults.setFault(null));

let ipSeq = 0;
const freshIp = () => ({ 'X-Forwarded-For': `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}` }); // テストごとに別の接続元
const session = (code, headers = freshIp()) => h.api(srv.base, 'POST', '/api/session', { headers, body: { code } });
const sessionHeaders = () => ({ 'X-Session-Token': createSession('DEMO2027').token });

test('events_whenStoreDown_return200WithAcceptedZero', async () => {
  faults.setFault('appendEvents');
  const r = await h.api(srv.base, 'POST', '/api/events', { headers: sessionHeaders(), body: { events: [{ type: 'tts', chars: 1 }] } });
  assert.equal(r.status, 200);
  assert.equal(r.json.accepted, 0);
});

test('purchase_whenStoreDown_returns503StoreUnavailable', async () => {
  faults.setFault('createPurchase');
  const r = await h.api(srv.base, 'POST', '/api/purchase', { body: { plan: 'ai40' } });
  assert.equal(r.status, 503);
  assert.deepEqual(r.json, { error: 'store_unavailable' });
});

test('session_withPurchaseCode_whenStoreDown_returns503_andIsNotCountedAsFailure', async () => {
  faults.setFault('getPurchase');
  const headers = freshIp();
  for (let i = 0; i < 12; i++) assert.equal((await session('KG-ABC123', headers)).status, 503);
  faults.setFault(null);
  assert.equal((await session('KG-ABC123', headers)).status, 403, '故障の分は失敗に数えない（429 にならない）');
});

test('session_withDemoCode_worksEvenWhenStoreIsDown', async () => {
  faults.setFault(true);
  const r = await session('DEMO2027');
  assert.equal(r.status, 200);
  assert.ok(r.json.token);
});

test('session_withValidPurchaseCodes_isNotBlockedByCountedThenUndoneFailures', async () => {
  const headers = freshIp();
  for (let i = 0; i < 12; i++) {
    const { json: { code } } = await h.api(srv.base, 'POST', '/api/purchase', { body: {} });
    assert.equal((await session(code, headers)).status, 200, `${i} 回目`);
  }
  const used = (await store.listPurchases()).purchases.filter((p) => p.usedAt);
  assert.ok(used.length >= 12, '使った印が付く');
});

test('session_parallelWrongPurchaseCodes_cannotExceedTenFailures', async () => {
  const headers = freshIp();
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => session(`KG-${String(i).padStart(6, '0')}`, headers)));
  const rejected = results.filter((r) => r.status === 403).length;
  assert.ok(rejected <= 10, `保存先を調べている間に送られても 10 回まで（${rejected} 回）`);
  assert.equal(results.filter((r) => r.status === 429).length, 30 - rejected);
});

test('session_withMalformedCode_isRejectedWithoutReadingStore', async () => {
  faults.setFault('getPurchase'); // 読みに行けば 503 になる
  for (const code of ['KG-12345', 'KG-12345G', 'XX-123456', 'KG-1234567']) assert.equal((await session(code)).status, 403, code);
});

test('dataSpots_whenStoreDown_returns503', async () => {
  faults.setFault('getSpots');
  const r = await h.api(srv.base, 'GET', '/api/data/spots');
  assert.equal(r.status, 503);
  assert.deepEqual(r.json, { error: 'store_unavailable' });
  assert.equal((await h.api(srv.base, 'GET', '/api/data/knowledge')).status, 200, '同梱データはファイルから読む');
});

test('guideSave_whenStoreDown_returns503', async () => {
  faults.setFault('updateSpots');
  const r = await h.api(srv.base, 'PUT', '/api/guide/spots/new-one', { headers: G, body: { name: { ja: 'x' }, lat: 35.68, lng: 139.75 } });
  assert.equal(r.status, 503);
});

test('stats_whenStoreDown_returns503', async () => {
  faults.setFault('listEvents');
  assert.equal((await h.api(srv.base, 'GET', '/api/stats', { headers: G })).status, 503);
});

test('stats_days_defaultsTo7_andAccepts1to90', async () => {
  const r = await h.api(srv.base, 'GET', '/api/stats', { headers: G });
  assert.equal(r.status, 200);
  assert.equal(r.json.days, 7);
  assert.equal(r.json.truncated, false);
  assert.match(r.json.fromDay, /^\d{4}-\d{2}-\d{2}$/);
  for (const d of ['1', '90']) assert.equal((await h.api(srv.base, 'GET', `/api/stats?days=${d}`, { headers: G })).json.days, Number(d));
  for (const d of ['0', '91', 'abc', '1.5', '-1', '']) assert.equal((await h.api(srv.base, 'GET', `/api/stats?days=${d}`, { headers: G })).status, 400, d);
});

test('recordings_whenStoreDown_return503', async () => {
  faults.setFault('createRecording');
  assert.equal((await h.api(srv.base, 'POST', '/api/guide/recordings', { headers: G, body: {} })).status, 503);
});

// 最後に試す（サーバーを閉じる）
test('shutdown_flushesEventsKeptWhileStoreWasDown', async () => {
  const { shutdown } = require('../server.js');
  const headers = sessionHeaders();
  faults.setFault('appendEvents');
  await h.api(srv.base, 'POST', '/api/events', { headers, body: { events: [{ type: 'survey', q: 'kept' }] } });
  faults.setFault(null);
  let code;
  await shutdown({ exit: (c) => { code = c; } });
  assert.equal(code, 0);
  const { jstDay } = require('../lib/limits');
  const { events } = await store.listEvents({ fromDay: jstDay(), toDay: jstDay(), maxDocs: 1000 });
  assert.ok(events.some((e) => e.q === 'kept'), '止まっていた間のイベントを終了前に書く');
});
