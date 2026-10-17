'use strict';
// lib/store/index.js の共通の守り: 1 日の書き込み量・回数の上限、書けなかったイベントの持ち越し、終了時の書き出し
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./_helper');

h.setupEnv();
const { createStore } = require('../lib/store');
const { createMemoryStore } = require('../lib/store/memory');
const { withFaults } = h;
const { jstDay } = require('../lib/limits');

const ev = (n) => ({ type: 'tts', ts: new Date().toISOString(), n });
const listAll = async (store) => (await store.listEvents({ fromDay: jstDay(), toDay: jstDay(), maxDocs: 1000 })).events;

test('dailyBytes_overLimit_dropsAndReturnsZero', async () => {
  const one = Buffer.byteLength(JSON.stringify(ev(1)) + '\n');
  const store = createStore(createMemoryStore(), { dailyBytes: one * 2 });
  assert.equal(await store.appendEvents([ev(1)]), 1);
  assert.equal(await store.appendEvents([ev(2)]), 1);
  assert.equal(await store.appendEvents([ev(3)]), 0);
  assert.deepEqual((await listAll(store)).map((e) => e.n), [1, 2]);
});

test('dailyBytes_reservedBeforeAwait_soParallelWritesCannotExceed', async () => {
  const one = Buffer.byteLength(JSON.stringify(ev(1)) + '\n');
  const store = createStore(createMemoryStore(), { dailyBytes: one * 3 });
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.appendEvents([ev(i)])));
  assert.equal(results.reduce((a, b) => a + b, 0), 3);
});

test('dailyWrites_limitsDocumentsPerDay', async () => {
  const store = createStore(createMemoryStore(), { dailyWrites: 2 });
  assert.deepEqual([await store.appendEvents([ev(1), ev(2)]), await store.appendEvents([ev(3)]), await store.appendEvents([ev(4)])], [2, 1, 0]);
});

test('dailyLimits_resetOnNextJstDay', async () => {
  let t = Date.parse('2026-10-17T10:00:00Z');
  const store = createStore(createMemoryStore(), { dailyWrites: 1, now: () => t });
  assert.equal(await store.appendEvents([ev(1)]), 1);
  assert.equal(await store.appendEvents([ev(2)]), 0);
  t += 24 * 3600_000;
  assert.equal(await store.appendEvents([ev(3)]), 1);
});

test('appendEvents_whenBackendFails_returnsZeroWithoutThrowing_andReleasesReservation', async () => {
  let t = Date.now();
  const { backend, setFault } = withFaults(createMemoryStore());
  const store = createStore(backend, { dailyWrites: 1, now: () => t });
  setFault('appendEvents');
  assert.equal(await store.appendEvents([ev(1)]), 0);
  setFault(null);
  t += 31_000; // 止まったあとの 30 秒が過ぎた
  assert.equal(await store.appendEvents([ev(2)]), 1, '失敗した分は上限に数えない');
});

test('appendEvents_afterFailure_rewritesKeptEventsOnNextSuccess', async () => {
  let t = Date.now();
  const { backend, setFault } = withFaults(createMemoryStore());
  const store = createStore(backend, { now: () => t });
  setFault('appendEvents');
  await store.appendEvents([ev(1), ev(2)]);
  setFault(null);
  t += 31_000;
  assert.equal(await store.appendEvents([ev(3)]), 1, '返すのは今回の件数');
  assert.deepEqual((await listAll(store)).map((e) => e.n).sort(), [1, 2, 3]);
});

test('appendEvents_keepsAtMostPendingMaxEvents', async () => {
  const { backend, setFault } = withFaults(createMemoryStore());
  const store = createStore(backend, { pendingMax: 3 });
  setFault('appendEvents');
  await store.appendEvents([ev(1), ev(2)]);
  await store.appendEvents([ev(3), ev(4)]);
  setFault(null);
  await store.flush();
  assert.deepEqual((await listAll(store)).map((e) => e.n), [2, 3, 4], '新しいものから残す');
});

test('flush_waitsForInflightWrites', async () => {
  const backend = createMemoryStore();
  let release;
  const slow = { ...backend, appendEvents: (events) => new Promise((r) => { release = () => r(backend.appendEvents(events)); }) };
  const store = createStore(slow);
  const writing = store.appendEvents([ev(1)]);
  let flushed = false;
  const flushing = store.flush().then(() => { flushed = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(flushed, false, '書きかけが終わるまで待つ');
  release();
  await Promise.all([writing, flushing]);
  assert.equal(flushed, true);
  assert.equal((await listAll(backend)).length, 1);
});

test('otherMethods_arePassedThrough', async () => {
  const store = createStore(createMemoryStore({ spots: { version: 2, spots: [{ id: 'q' }] } }));
  assert.equal((await store.getSpots()).spots[0].id, 'q');
  await store.createPurchase({ code: 'KG-ABCDEF', usedAt: null });
  assert.ok(await store.getPurchase('KG-ABCDEF'));
});

test('warmUp_callsBackendWarmUpAndSwallowsErrors', async () => {
  let called = 0;
  const store = createStore({ ...createMemoryStore(), warmUp: async () => { called++; throw new Error('no token'); } });
  await store.warmUp();
  assert.equal(called, 1);
  await createStore(createMemoryStore()).warmUp(); // warmUp がない保存先でも呼べる
});

test('memoryStore_seedsSpotsFromDataDir', async () => {
  const fs = require('fs');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'kg-mem-'));
  fs.writeFileSync(path.join(dir, 'spots.json'), JSON.stringify({ version: 2, spots: [{ id: 'from-file' }] }));
  assert.equal((await createMemoryStore({ dataDir: dir }).getSpots()).spots[0].id, 'from-file');
});

// 書き込みを記録する保存先（失敗も指定できる）
function recordingBackend(failWith) {
  const writes = [];
  return { writes, backend: { ...createMemoryStore(), appendEvents: async (events) => { if (failWith && failWith(events)) throw failWith(events); writes.push(events); return events.length; } } };
}
const big = (n) => ({ type: 'tts', ts: new Date().toISOString(), n, pad: 'x'.repeat(90_000) });

test('appendEvents_oversizedCall_isSplitIntoDocumentsByBytes', async () => {
  const { backend, writes } = recordingBackend();
  const store = createStore(backend, { docBytes: 200_000 });
  assert.equal(await store.appendEvents([big(1), big(2), big(3), big(4), big(5)]), 5);
  assert.deepEqual(writes.map((w) => w.map((e) => e.n)), [[1, 2], [3, 4], [5]], '1 ドキュメント 200KB まで');
});

test('appendEvents_isSplitByCountToo', async () => {
  const { backend, writes } = recordingBackend();
  const store = createStore(backend, { docEvents: 2 });
  await store.appendEvents([ev(1), ev(2), ev(3)]);
  assert.deepEqual(writes.map((w) => w.length), [2, 1]);
});

test('pending_isRewrittenInDocumentSizedPieces', async () => {
  let down = true;
  const { backend, writes } = recordingBackend(() => (down ? Object.assign(new Error('store_unavailable'), { status: 503, upstreamStatus: 503 }) : null));
  const store = createStore(backend, { docBytes: 200_000 });
  for (let i = 1; i <= 4; i++) await store.appendEvents([big(i)]);
  down = false;
  await store.flush();
  assert.deepEqual(writes.map((w) => w.map((e) => e.n)), [[1, 2], [3, 4]]);
});

test('permanentFailure_isDroppedInsteadOfKept', async () => {
  const bad = Object.assign(new Error('store_unavailable'), { status: 503, upstreamStatus: 400, grpc: 'INVALID_ARGUMENT' });
  const { backend, writes } = recordingBackend((events) => (events.some((e) => e.bad) ? bad : null));
  const store = createStore(backend);
  const realError = console.error;
  console.error = () => {};
  try {
    assert.equal(await store.appendEvents([{ ...ev(1), bad: true }]), 0);
  } finally {
    console.error = realError;
  }
  await store.appendEvents([ev(2)]);
  await store.flush();
  assert.deepEqual(writes.map((w) => w.map((e) => e.n)), [[2]], '400 で断られたものは持ち越さない');
});

// 止まっている保存先（呼ばれた回数を数える）
function downBackend() {
  const state = { down: true, calls: 0, writes: [] };
  const backend = {
    ...createMemoryStore(),
    appendEvents: async (events) => {
      state.calls++;
      if (state.down) throw Object.assign(new Error('store_unavailable'), { status: 503, upstreamStatus: 503, grpc: 'UNAVAILABLE' });
      state.writes.push(events);
      return events.length;
    },
  };
  return { state, backend };
}

test('circuitBreaker_afterTransientFailure_skipsBackendFor30s_andKeepsEvents', async () => {
  let t = Date.parse('2026-10-17T01:00:00Z');
  const { state, backend } = downBackend();
  const store = createStore(backend, { now: () => t });
  assert.equal(await store.appendEvents([ev(1)]), 0);
  assert.equal(state.calls, 1);
  t += 10_000;
  assert.equal(await store.appendEvents([ev(2)]), 0, 'すぐ 0 を返す（保存先を待たない）');
  assert.equal(state.calls, 1, '30 秒は保存先を呼ばない');
  state.down = false;
  t += 21_000;
  assert.equal(await store.appendEvents([ev(3)]), 1);
  assert.deepEqual(state.writes.flat().map((e) => e.n).sort(), [1, 2, 3], '止まっていた間の分も書く');
});

test('writeDocs_stopsAtFirstTransientFailure_andKeepsTheRest', async () => {
  const { state, backend } = downBackend();
  const store = createStore(backend, { docEvents: 1 });
  assert.equal(await store.appendEvents([ev(1), ev(2), ev(3)]), 0);
  assert.equal(state.calls, 1, '残りのドキュメントは試さない');
  state.down = false;
  await store.flush();
  assert.deepEqual(state.writes.map((w) => w[0].n), [1, 2, 3]);
});
