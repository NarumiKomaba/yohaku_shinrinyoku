// Firestore への移行: Spot（お試し版の今の内容など）と、ファイル版の記録（events.jsonl・purchases.json・recordings/）を移す。
//   node scripts/migrate-to-firestore.js --namespace <ns> [--spots-from <file|https-url>] [--logs] [--dry-run] [--force] [--yes]
// お試し版（--namespace preview）に書くときは --yes が要る（--dry-run で確かめてから）。
// FIRESTORE_PROJECT_ID（必須）・FIRESTORE_AUTH・GCLOUD_CONFIG（gcloud なら必須）・DATA_DIR は環境変数で（npm start と同じ）。
// Spot はガイドさんページの保存と同じ検査・整形を通し、すでにあれば --force なしでは上書きしない（上書きしたときは古い版を履歴に残す）。
// 記録はどれも「なければ作る」で書くので、何度流しても 2 重にならない。記録はファイル版の保存先（lib/store/file.js）で読む
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { jstDay } = require('../lib/limits');
const { namespaceProblem } = require('../lib/config');
const { PURCHASE_CODE_RE, MAX_CHUNK_INDEX } = require('../lib/store/common');
const { isEncodable } = require('../lib/firestore/encode');
const { createWrite } = require('../lib/firestore/writes');
const { normalizeSpotList } = require('../lib/spot-validate');
const { createFileStore } = require('../lib/store/file');
const { createFirestoreStore, restFromConfig } = require('../lib/store/firestore');
const { batchId, batchDoc } = require('../lib/store/firestore/events');
const { spotsPath } = require('../lib/store/firestore/spots');
const { recPath, chunkPath } = require('../lib/store/firestore/recordings');

const EVENTS_PER_DOC = 100;
const WRITES_PER_CALL = 500;
const ALREADY_EXISTS = 6;
const ALL_DAYS = { fromDay: '0000-01-01', toDay: '9999-12-31' };
const CONFIRM_NAMESPACES = new Set(['preview']); // 書き込みに --yes が要る（お試し版）

function parseArgs(argv) {
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const opts = { namespace: val('--namespace'), spotsFrom: val('--spots-from'), logs: argv.includes('--logs'), dryRun: argv.includes('--dry-run'), force: argv.includes('--force') };
  const problem = namespaceProblem('--namespace', opts.namespace || '');
  if (problem) throw new Error(problem);
  if (!opts.spotsFrom && !opts.logs) throw new Error('--spots-from か --logs を指定してください');
  if (CONFIRM_NAMESPACES.has(opts.namespace) && !opts.dryRun && !argv.includes('--yes')) throw new Error(`envs/${opts.namespace} はお試し版です。--dry-run で確かめてから --yes を付けてください`);
  return opts;
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, (i + 1) * n));

async function loadSpots(spotsFrom, fetchUrl) {
  let data;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(spotsFrom)) {
    if (!/^https:\/\//i.test(spotsFrom)) throw new Error('--spots-from の URL は https:// にしてください');
    const res = await fetchUrl(spotsFrom, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Spot を取得できません（${res.status}）`);
    data = await res.json();
  } else {
    data = JSON.parse(fs.readFileSync(spotsFrom, 'utf8'));
  }
  if (!data || !Array.isArray(data.spots)) throw new Error('Spot のデータに spots の配列がありません');
  try {
    return { version: data.version || 2, spots: normalizeSpotList(data.spots) };
  } catch (e) {
    throw new Error(`Spot のデータが正しくありません（${e.message}）`);
  }
}

// 日（日本時間）ごとに 100 件ずつ 1 ドキュメントにする。ID は中身のハッシュから決まるので、流し直しても同じ。
// あとからイベントが増えた日は、中身が変わったまとめだけが新しい ID になって書かれる（その前の分と重なることはある）
const contentId = (part) => `m${crypto.createHash('sha256').update(JSON.stringify(part)).digest('hex').slice(0, 7)}`;

async function eventDocs(source, base) {
  const { events: all } = await source.listEvents({ ...ALL_DAYS, maxDocs: Infinity });
  const events = all.filter(isEncodable);
  const byDay = events.reduce((m, e) => {
    const day = jstDay(Date.parse(e.ts));
    if (m.has(day)) m.get(day).push(e);
    else m.set(day, [e]);
    return m;
  }, new Map());
  const docs = [...byDay.values()].flatMap((list) => chunk(list, EVENTS_PER_DOC).map((part) => {
    const ms = Date.parse(part[0].ts);
    return { path: `${base}/eventBatches/${batchId(ms, contentId(part))}`, data: { ...batchDoc(part, ms), migrated: true } };
  }));
  return { docs, dropped: all.length - events.length };
}

async function purchaseDocs(source, base) {
  const { purchases } = await source.listPurchases();
  return purchases.filter((p) => p && PURCHASE_CODE_RE.test(String(p.code)) && isEncodable(p)).map((p) => ({ path: `${base}/purchases/${p.code}`, data: p }));
}

// ファイル版は 1 録音 1 ファイル（軌跡は全体で 1 つ）。Firestore 版の形に分け、軌跡は一番前の chunk に入れる。
// Firestore 版で読める番号（MAX_CHUNK_INDEX）を超える chunk は移さず、その数を返す
async function recordingDocs(source, base) {
  const recs = (await Promise.all((await source.listRecordingIds()).map((rid) => source.getRecording(rid)))).filter(Boolean);
  const usable = (c) => Number.isInteger(c.index) && c.index >= 0 && c.index <= MAX_CHUNK_INDEX;
  const docs = recs.flatMap(({ chunks, track, ...head }) => [
    { path: recPath(base, head.id), data: head },
    ...chunks.filter(usable).map((c, i) => ({ path: chunkPath(base, head.id, c.index), data: { ...c, track: i === 0 ? track : [] } })),
  ].filter((d) => isEncodable(d.data)));
  return { docs, skippedChunks: recs.reduce((a, r) => a + r.chunks.filter((c) => !usable(c)).length, 0) };
}

// 1 つずつ「なければ作る」（batchWrite は 1 つの失敗でほかを止めない）
async function createAll(rest, docs, dryRun) {
  const empty = { docs: docs.length, written: 0, skipped: 0, failed: 0 };
  if (dryRun) return empty;
  let counts = empty;
  for (const part of chunk(docs, WRITES_PER_CALL)) {
    // なければ作るだけなので、やり直しても「既存」になるだけ
    const res = await rest.batchWrite(part.map((d) => createWrite(rest.docName(d.path), d.data)), { retry: true });
    for (const st of res.status || []) {
      const code = (st && st.code) || 0;
      const key = code === 0 ? 'written' : code === ALREADY_EXISTS ? 'skipped' : 'failed';
      counts = { ...counts, [key]: counts[key] + 1 };
    }
  }
  return counts;
}

async function migrateSpots({ rest, namespace, spotsFrom, force, dryRun, fetchUrl }) {
  const data = await loadSpots(spotsFrom, fetchUrl);
  const exists = Boolean(await rest.get(spotsPath(`envs/${namespace}`)));
  if (exists && !force) return 'skipped';
  if (dryRun) return 'dry-run';
  await createFirestoreStore({ rest, namespace, spotsCacheSec: 0 }).updateSpots(() => data);
  return 'written';
}

async function migrateLogs({ rest, namespace, dataDir, dryRun, log }) {
  const source = createFileStore({ dataDir });
  const base = `envs/${namespace}`;
  const ev = await eventDocs(source, base);
  const rec = await recordingDocs(source, base);
  const report = {
    events: { ...(await createAll(rest, ev.docs, dryRun)), dropped: ev.dropped },
    purchases: await createAll(rest, await purchaseDocs(source, base), dryRun),
    recordings: { ...(await createAll(rest, rec.docs, dryRun)), skippedChunks: rec.skippedChunks },
  };
  for (const [k, c] of Object.entries(report)) {
    const dropped = [c.dropped ? `Firestore に書けないイベント ${c.dropped} 件は捨てる` : '', c.skippedChunks ? `番号が大きすぎる chunk ${c.skippedChunks} 件は移さない` : ''].filter(Boolean).map((x) => `（${x}）`).join('');
    log(`${k}: ドキュメント ${c.docs} 件${dropped}${dryRun ? '（--dry-run: 書いていません）' : ` → 作成 ${c.written}・既存 ${c.skipped}・失敗 ${c.failed}`}`);
  }
  return report;
}

async function migrate({ rest, namespace, spotsFrom, logs = false, dryRun = false, force = false, dataDir, fetchUrl = globalThis.fetch, log = console.log }) {
  const spots = spotsFrom ? await migrateSpots({ rest, namespace, spotsFrom, force, dryRun, fetchUrl }) : 'not-requested';
  if (spotsFrom) log(`Spot: ${spots}`);
  return { spots, ...(logs ? await migrateLogs({ rest, namespace, dataDir, dryRun, log }) : {}) };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cfg = require('../lib/config');
  const rest = restFromConfig(cfg);
  console.log(`移行先: ${cfg.FIRESTORE_PROJECT_ID} envs/${opts.namespace}${opts.dryRun ? '（--dry-run）' : ''}`);
  await migrate({ ...opts, rest, dataDir: cfg.DATA_DIR });
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { migrate, parseArgs };
