// メモリ版の保存先（テスト用）。Firestore 版と同じ形で持つ（イベントは 1 回の appendEvents = 1 まとめ、録音は chunk ごと）。
// Spot は dataDir/spots.json があればそこから、なければ spots から始める
'use strict';

const fs = require('fs');
const path = require('path');
const { jstDay } = require('../limits');
const { httpError } = require('../http');
const { deepFreeze } = require('../freeze');
const { purchaseExists, mergeChunks } = require('./common');

const clone = (v) => structuredClone(v);

function initialSpots(dataDir, spots) {
  const file = dataDir ? path.join(dataDir, 'spots.json') : '';
  if (file && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  return clone(spots);
}

function createMemoryStore({ dataDir, spots = { version: 2, spots: [] }, now = Date.now } = {}) {
  let spotsDoc = deepFreeze(initialSpots(dataDir, spots)); // Firestore 版と同じく、getSpots の内容は変えられない
  let batches = []; // { day, events }
  let purchases = new Map();
  let recordings = new Map(); // rid -> { rec, chunks: Map(index -> { ...chunk, track }) }

  const viewRec = (r, withChunks) => clone({ ...r.rec, ...(withChunks ? mergeChunks([...r.chunks.values()]) : {}) });

  return {
    async getSpots() {
      return spotsDoc;
    },

    async updateSpots(fn) {
      const next = fn(clone(spotsDoc));
      spotsDoc = deepFreeze(clone(next));
      return next;
    },

    async appendEvents(events) {
      if (!events.length) return 0;
      batches = [...batches, { day: jstDay(now()), events: clone(events) }];
      return events.length;
    },

    async listEvents({ fromDay, toDay, maxDocs = Infinity }) {
      // Firestore 版と同じく、上限に届いたら新しいほうを残す
      const hit = batches.filter((b) => b.day >= fromDay && b.day <= toDay);
      return { events: clone(hit.slice(Math.max(0, hit.length - maxDocs)).flatMap((b) => b.events)), truncated: hit.length > maxDocs };
    },

    async listPurchases() {
      return { purchases: clone([...purchases.values()]), truncated: false };
    },

    async createPurchase(p) {
      if (purchases.has(p.code)) throw purchaseExists();
      purchases = new Map(purchases).set(p.code, clone(p));
    },

    async getPurchase(code) {
      return purchases.has(code) ? clone(purchases.get(code)) : null;
    },

    async markPurchaseUsed(code, at) {
      const p = purchases.get(code);
      if (!p) return false;
      if (!p.usedAt) purchases = new Map(purchases).set(code, { ...p, usedAt: at });
      return true;
    },

    async createRecording(rec) {
      recordings = new Map(recordings).set(rec.id, { rec: clone(rec), chunks: new Map() });
    },

    async getRecordingMeta(rid) {
      const r = recordings.get(rid);
      return r ? viewRec(r, false) : null;
    },

    async getRecording(rid) {
      const r = recordings.get(rid);
      return r ? viewRec(r, true) : null;
    },

    // 録音があることは呼び出し側が確かめている。録音中のときだけ
    async putRecordingChunk(rid, chunk, track) {
      const r = recordings.get(rid);
      if (r.rec.status !== 'recording') throw httpError(409, 'recording already finished');
      recordings = new Map(recordings).set(rid, { ...r, chunks: new Map(r.chunks).set(chunk.index, clone({ ...chunk, track })) });
    },

    async setRecordingStatus(rid, patch, { ifStatus, dropTrack = false } = {}) {
      const r = recordings.get(rid);
      if (!r || (ifStatus !== undefined && r.rec.status !== ifStatus)) return false;
      const chunks = dropTrack ? new Map([...r.chunks].map(([i, c]) => [i, { ...c, track: [] }])) : r.chunks;
      recordings = new Map(recordings).set(rid, { rec: { ...r.rec, ...clone(patch) }, chunks });
      return true;
    },
  };
}

module.exports = { createMemoryStore };
