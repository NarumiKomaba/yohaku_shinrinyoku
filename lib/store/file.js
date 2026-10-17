// ファイル版の保存先（テストと start:offline 用）。置き場所と形式は今までどおり:
//   DATA_DIR/spots.json（上書き前に logs/spots.backup-{ms}.json）、logs/events.jsonl、logs/purchases.json、logs/recordings/<rid>.json
// fs の同期関数だけを使うので、1 つの関数の中で読んでから書くまでに他のリクエストが割り込まない
'use strict';

const fs = require('fs');
const path = require('path');
const { jstDay } = require('../limits');
const { httpError } = require('../http');
const { deepFreeze } = require('../freeze');
const { MAX_BACKUPS, RECORDING_ID_RE, purchaseExists, checkId, mergeTrack } = require('./common');

function createFileStore({ dataDir }) {
  const logDir = path.join(dataDir, 'logs');
  const recDir = path.join(logDir, 'recordings');
  const eventsFile = path.join(logDir, 'events.jsonl');
  const spotsFile = path.join(dataDir, 'spots.json');
  fs.mkdirSync(logDir, { recursive: true });

  const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
  const writeJson = (file, obj, space = 2) => fs.writeFileSync(file, JSON.stringify(obj, null, space), 'utf8');

  // Spot はメモリに持たない（毎回ファイルから読む）。Firestore 版と同じく、getSpots の内容は変えられないようにして返す
  function backupSpots() {
    if (!fs.existsSync(spotsFile)) return;
    fs.copyFileSync(spotsFile, path.join(logDir, `spots.backup-${Date.now()}.json`));
    const prefix = 'spots.backup-';
    const stamp = (f) => Number(f.slice(prefix.length, -'.json'.length)) || 0;
    const backups = fs.readdirSync(logDir).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).sort((a, b) => stamp(b) - stamp(a));
    for (const f of backups.slice(MAX_BACKUPS)) fs.rmSync(path.join(logDir, f), { force: true });
  }

  function readPurchases() {
    try { return readJson(path.join(logDir, 'purchases.json')); } catch { return {}; }
  }
  const writePurchases = (p) => writeJson(path.join(logDir, 'purchases.json'), p);

  const recFile = (rid) => path.join(recDir, `${checkId(RECORDING_ID_RE, rid, 'recording id')}.json`);
  function readRec(rid) {
    const file = recFile(rid);
    return fs.existsSync(file) ? readJson(file) : null;
  }
  const writeRec = (rec) => writeJson(recFile(rec.id), rec, 0);
  // 外に返す形（Firestore 版と同じ: 終わって軌跡を消したあとは []）
  const viewRec = (rec) => (rec ? { ...rec, track: rec.track || [] } : null);

  return {
    async getSpots() {
      return deepFreeze(readJson(spotsFile));
    },

    async updateSpots(fn) {
      const next = fn(readJson(spotsFile));
      backupSpots();
      writeJson(spotsFile, next);
      return next;
    },

    async appendEvents(events) {
      if (!events.length) return 0;
      fs.appendFileSync(eventsFile, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
      return events.length;
    },

    // ファイル版は 1 行 = 1 イベントで、まとめ（ドキュメント）の区切りがないので打ち切らない
    async listEvents({ fromDay, toDay }) {
      if (!fs.existsSync(eventsFile)) return { events: [], truncated: false };
      const events = fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
        try { return [JSON.parse(l)]; } catch { return []; }
      }).filter((e) => {
        const ms = Date.parse(e.ts);
        if (!Number.isFinite(ms)) return false;
        const day = jstDay(ms);
        return day >= fromDay && day <= toDay;
      });
      return { events, truncated: false };
    },

    async listPurchases() {
      return { purchases: Object.values(readPurchases()), truncated: false };
    },

    async createPurchase(p) {
      const all = readPurchases();
      if (Object.hasOwn(all, p.code)) throw purchaseExists();
      writePurchases({ ...all, [p.code]: p });
    },

    async getPurchase(code) {
      const all = readPurchases();
      return Object.hasOwn(all, code) ? all[code] : null;
    },

    async markPurchaseUsed(code, at) {
      const all = readPurchases();
      if (!Object.hasOwn(all, code)) return false;
      if (!all[code].usedAt) writePurchases({ ...all, [code]: { ...all[code], usedAt: at } });
      return true;
    },

    async createRecording(rec) {
      fs.mkdirSync(recDir, { recursive: true });
      writeRec({ ...rec, chunks: [], track: [] });
    },

    async getRecording(rid) {
      return viewRec(readRec(rid));
    },

    // 1 ファイルなので本体だけを読むことはできない
    async getRecordingMeta(rid) {
      return viewRec(readRec(rid));
    },

    /** 録音の id の一覧（移行用） */
    async listRecordingIds() {
      if (!fs.existsSync(recDir)) return [];
      return fs.readdirSync(recDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length)).filter((id) => RECORDING_ID_RE.test(id));
    },

    // 同じ番号の chunk は置き換え、軌跡は同じ時刻の点を除いて足す（録音があることは呼び出し側が確かめている）。
    // 録音中のときだけ（読んでから書くまでに割り込まれないので、finish と重ならない）
    async putRecordingChunk(rid, chunk, track) {
      const rec = readRec(rid);
      if (rec.status !== 'recording') throw httpError(409, 'recording already finished');
      writeRec({
        ...rec,
        chunks: rec.chunks.filter((c) => c.index !== chunk.index).concat(chunk).sort((a, b) => a.index - b.index),
        track: mergeTrack([rec.track || [], track]),
      });
    },

    // ifVersion・chunkIndexes は Firestore 版のためのもの（ファイル版は読み直しても安い）
    async setRecordingStatus(rid, patch, { ifStatus, dropTrack = false } = {}) {
      const rec = readRec(rid);
      if (!rec || (ifStatus !== undefined && rec.status !== ifStatus)) return false;
      const { track, ...rest } = { ...rec, ...patch };
      writeRec(dropTrack ? rest : { ...rest, track });
      return true;
    },
  };
}

module.exports = { createFileStore };
