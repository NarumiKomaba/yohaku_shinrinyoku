'use strict';
// scripts/migrate-to-firestore.js（テスト用の Firestore に流す）: --dry-run では書かない、2 回流しても増えない、Spot は --force なしで上書きしない
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./_helper');

h.setupEnv();
const { createFakeFirestore, fakeTokens } = require('./_fake-firestore');
const { createRest } = require('../lib/firestore/rest');
const { migrate, parseArgs } = require('../scripts/migrate-to-firestore');

const RID = '11111111-2222-4333-8444-555555555555';
const SRC_SPOTS = { version: 2, spots: [{ id: 'from-preview', name: { ja: 'お試し版' }, lat: 35.68, lng: 139.75, materials: [] }] };

function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-migrate-'));
  const logs = path.join(dir, 'logs');
  fs.mkdirSync(path.join(logs, 'recordings'), { recursive: true });
  const day1 = Array.from({ length: 150 }, (_, i) => ({ type: 'tts', ts: new Date(Date.parse('2026-10-15T01:00:00.000Z') + i * 1000).toISOString(), i }));
  const day2 = [{ type: 'survey', ts: '2026-10-16T01:00:00.000Z' }, { type: 'bad', ts: '2026-10-16T01:00:00.000Z', '': 1 }];
  fs.writeFileSync(path.join(logs, 'events.jsonl'), [...day1, ...day2].map((e) => JSON.stringify(e)).join('\n') + '\n{broken\n');
  fs.writeFileSync(path.join(logs, 'purchases.json'), JSON.stringify({ 'KG-00000A': { code: 'KG-00000A', usedAt: null }, '../bad': { code: '../bad' } }));
  fs.writeFileSync(path.join(logs, 'recordings', `${RID}.json`), JSON.stringify({
    id: RID, createdAt: 'c', status: 'recording', candidates: [],
    chunks: [{ index: 0, startedAt: 'a', durationSec: 60, segments: [] }, { index: 1, startedAt: 'b', durationSec: 60, segments: [] }, { index: 5000, startedAt: 'c', durationSec: 60, segments: [] }],
    track: [{ t: 1, lat: 35, lng: 139, acc: 5 }],
  }));
  fs.writeFileSync(path.join(logs, 'recordings', 'not-a-uuid.json'), '{}');
  const spotsFile = path.join(dir, 'spots-src.json');
  fs.writeFileSync(spotsFile, JSON.stringify(SRC_SPOTS));
  return { dir, spotsFile };
}

function setup() {
  const fake = createFakeFirestore();
  const rest = createRest({ projectId: 'p1', fetch: fake.fetch, tokens: fakeTokens(), sleep: async () => {} });
  return { fake, rest, ...makeDataDir() };
}
const quiet = () => {};
const writes = (fake) => fake.calls.filter((c) => /:(commit|batchWrite)$/.test(c.url)).length;

test('parseArgs_readsFlags_andRequiresValidNamespace', () => {
  assert.deepEqual(parseArgs(['--namespace', 'preview', '--spots-from', 'x.json', '--logs', '--dry-run', '--force']), { namespace: 'preview', spotsFrom: 'x.json', logs: true, dryRun: true, force: true });
  assert.throws(() => parseArgs(['--namespace', 'preview', '--logs']), /--yes/, 'お試し版に書くときは --yes が要る');
  assert.equal(parseArgs(['--namespace', 'preview', '--logs', '--yes']).namespace, 'preview');
  assert.equal(parseArgs(['--namespace', 'local', '--logs']).namespace, 'local');
  assert.throws(() => parseArgs([]), /--namespace/);
  assert.throws(() => parseArgs(['--namespace', 'Bad/NS']), /--namespace/);
  assert.throws(() => parseArgs(['--namespace', 'preview']), /--spots-from か --logs/);
});

test('dryRun_writesNothing', async () => {
  const s = setup();
  const report = await migrate({ rest: s.rest, namespace: 'preview', spotsFrom: s.spotsFile, logs: true, dryRun: true, dataDir: s.dir, log: quiet });
  assert.equal(writes(s.fake), 0);
  assert.deepEqual(s.fake.list('envs/'), []);
  assert.equal(report.events.docs, 3, '日ごとに 100 件ずつ（150 件 → 2、1 件 → 1）');
  assert.equal(report.events.dropped, 1, 'Firestore に書けないイベントの数を出す');
  assert.equal(report.purchases.docs, 1, '形の正しいコードだけ');
  assert.equal(report.recordings.docs, 3, '本体 1 + chunk 2');
  assert.equal(report.recordings.skippedChunks, 1, '番号が大きすぎる chunk は止めずに数える');
  assert.equal(report.spots, 'dry-run');
});

test('migrate_writesEverything_andSecondRunAddsNothing', async () => {
  const s = setup();
  const first = await migrate({ rest: s.rest, namespace: 'preview', spotsFrom: s.spotsFile, logs: true, dataDir: s.dir, log: quiet });
  assert.equal(first.spots, 'written');
  assert.deepEqual([first.events.written, first.purchases.written, first.recordings.written], [3, 1, 3]);
  const before = s.fake.list('envs/');
  const second = await migrate({ rest: s.rest, namespace: 'preview', spotsFrom: s.spotsFile, logs: true, dataDir: s.dir, log: quiet });
  assert.deepEqual(s.fake.list('envs/'), before, '何度流しても 2 重にならない');
  assert.deepEqual([second.events.written, second.events.skipped], [0, 3]);
  assert.equal(second.spots, 'skipped', 'Spot はあれば --force なしでは上書きしない');

  const { createFirestoreStore } = require('../lib/store/firestore');
  const store = createFirestoreStore({ rest: s.rest, namespace: 'preview', spotsCacheSec: 0 });
  const { jstDay } = require('../lib/limits');
  const { events } = await store.listEvents({ fromDay: '2026-10-15', toDay: jstDay(), maxDocs: 100 });
  assert.equal(events.length, 151, '書けないイベント・壊れた行は捨てる');
  assert.deepEqual(events.slice(0, 2).map((e) => e.i), [0, 1]);
  assert.deepEqual((await store.getSpots()).spots.map((x) => x.id), ['from-preview']);
  const rec = await store.getRecording(RID);
  assert.deepEqual(rec.chunks.map((c) => c.index), [0, 1]);
  assert.equal(rec.track.length, 1, '軌跡も移す');
  assert.ok(await store.getPurchase('KG-00000A'));
});

test('spots_withForce_overwritesAndKeepsOldInHistory', async () => {
  const s = setup();
  const { createFirestoreStore } = require('../lib/store/firestore');
  const store = createFirestoreStore({ rest: s.rest, namespace: 'preview', spotsCacheSec: 0 });
  await store.updateSpots(() => ({ version: 2, spots: [{ id: 'old', name: { ja: '古い' }, lat: 1, lng: 1 }] }));
  assert.equal((await migrate({ rest: s.rest, namespace: 'preview', spotsFrom: s.spotsFile, dataDir: s.dir, log: quiet })).spots, 'skipped');
  assert.equal((await migrate({ rest: s.rest, namespace: 'preview', spotsFrom: s.spotsFile, force: true, dataDir: s.dir, log: quiet })).spots, 'written');
  assert.deepEqual((await store.getSpots()).spots.map((x) => x.id), ['from-preview']);
  assert.equal(s.fake.list('envs/preview/spotsHistory/').length, 1, '上書き前の内容は履歴に残る');
});

test('spotsFrom_url_isFetched_andBadDataIsRejected', async () => {
  const s = setup();
  const urls = [];
  const fetchUrl = async (url) => { urls.push(url); return new Response(JSON.stringify(SRC_SPOTS), { status: 200 }); };
  const r = await migrate({ rest: s.rest, namespace: 'preview', spotsFrom: 'https://example.invalid/api/data/spots', fetchUrl, dataDir: s.dir, log: quiet });
  assert.equal(r.spots, 'written');
  assert.deepEqual(urls, ['https://example.invalid/api/data/spots']);
  const bad = async () => new Response(JSON.stringify({ spots: 'nope' }), { status: 200 });
  await assert.rejects(migrate({ rest: s.rest, namespace: 'preview', spotsFrom: 'https://x.invalid/', fetchUrl: bad, dataDir: s.dir, log: quiet }), /spots/);
  const down = async () => new Response('err', { status: 500 });
  await assert.rejects(migrate({ rest: s.rest, namespace: 'preview', spotsFrom: 'https://x.invalid/', fetchUrl: down, dataDir: s.dir, log: quiet }), /500/);
});

test('events_appendedAfterFirstRun_areWrittenOnSecondRun', async () => {
  const s = setup();
  await migrate({ rest: s.rest, namespace: 'local', logs: true, dataDir: s.dir, log: quiet });
  fs.appendFileSync(path.join(s.dir, 'logs', 'events.jsonl'), JSON.stringify({ type: 'late', ts: '2026-10-16T02:00:00.000Z' }) + '\n');
  const second = await migrate({ rest: s.rest, namespace: 'local', logs: true, dataDir: s.dir, log: quiet });
  assert.equal(second.events.written, 1, '中身が変わった日のまとめだけ新しく書く');
  assert.equal(second.events.skipped, 2);
});

test('spotsFrom_httpUrl_isRefused_andSpotsAreNormalized', async () => {
  const s = setup();
  const fetchUrl = async () => new Response(JSON.stringify(SRC_SPOTS), { status: 200 });
  await assert.rejects(migrate({ rest: s.rest, namespace: 'local', spotsFrom: 'http://x.invalid/api/data/spots', fetchUrl, dataDir: s.dir, log: quiet }), /https/);
  const dirty = path.join(s.dir, 'dirty.json');
  fs.writeFileSync(dirty, JSON.stringify({ version: 2, spots: [{ ...SRC_SPOTS.spots[0], junk: 'x', name: { ja: 'あ'.repeat(500) } }] }));
  await migrate({ rest: s.rest, namespace: 'local', spotsFrom: dirty, dataDir: s.dir, log: quiet });
  const { createFirestoreStore } = require('../lib/store/firestore');
  const spot = (await createFirestoreStore({ rest: s.rest, namespace: 'local', spotsCacheSec: 0 }).getSpots()).spots[0];
  assert.ok(!('junk' in spot), 'ガイドさんページの保存と同じ整形');
  assert.equal(spot.name.ja.length, 100);
  fs.writeFileSync(dirty, JSON.stringify({ version: 2, spots: [{ id: 'BAD ID', name: { ja: 'x' }, lat: 1, lng: 1 }] }));
  await assert.rejects(migrate({ rest: s.rest, namespace: 'local', spotsFrom: dirty, force: true, dataDir: s.dir, log: quiet }), /正しくありません/);
});

test('logs_withoutFiles_migratesNothing', async () => {
  const s = setup();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-migrate-empty-'));
  const r = await migrate({ rest: s.rest, namespace: 'preview', logs: true, dataDir: empty, log: quiet });
  assert.deepEqual([r.events.docs, r.purchases.docs, r.recordings.docs], [0, 0, 0]);
});
