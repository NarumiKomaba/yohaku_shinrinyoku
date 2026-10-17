// 保存先（file・memory・Firestore）で共通の決まりごと: エラーの形、ID の形、バックアップの数、録音の組み立て
'use strict';

const { httpError } = require('../http');

const MAX_BACKUPS = 20; // Spot の古い版を残す数（新しいものから）
// パス（Firestore のドキュメント ID）に入れる値は、入れる前に必ず形を確かめる
const PURCHASE_CODE_RE = /^KG-[0-9A-F]{6}$/;
const RECORDING_ID_RE = /^[0-9a-f-]{36}$/;
const MAX_CHUNKS = 400; // 1 回の録音の chunk の数の上限（読むときも書くときも。commit 1 回の書き込み 500 件に収める）
const MAX_CHUNK_INDEX = MAX_CHUNKS - 1;

/** 保存先が使えない（画面には 503 store_unavailable だけを返す）。upstreamStatus・grpc はログと判定用 */
const storeUnavailable = (upstreamStatus = 0, grpc = '') => Object.assign(httpError(503, 'store_unavailable'), { upstreamStatus, grpc });
/** 同じ購入コードがすでにある */
const purchaseExists = () => Object.assign(new Error('purchase_exists'), { code: 'exists' });

function checkId(re, value, what) {
  if (typeof value !== 'string' || !re.test(value)) throw httpError(400, `invalid ${what}`);
  return value;
}

function checkChunkIndex(index) {
  if (!Number.isInteger(index) || index < 0 || index > MAX_CHUNK_INDEX) throw httpError(400, 'invalid chunk index');
  return index;
}

/** 軌跡をつなぐ（同じ時刻の点は最初の 1 つだけ） */
function mergeTrack(tracks) {
  const seen = new Set();
  return tracks.flat().filter((p) => !seen.has(p.t) && seen.add(p.t));
}

/** chunk ごとの記録（{ index, ..., track }）から、番号順の chunks（軌跡なし）と 1 本の軌跡を作る */
function mergeChunks(parts) {
  const sorted = [...parts].sort((a, b) => a.index - b.index);
  return { chunks: sorted.map(({ track, ...chunk }) => chunk), track: mergeTrack(sorted.map((p) => p.track || [])) };
}

module.exports = { MAX_BACKUPS, PURCHASE_CODE_RE, RECORDING_ID_RE, MAX_CHUNKS, MAX_CHUNK_INDEX, storeUnavailable, purchaseExists, checkId, checkChunkIndex, mergeTrack, mergeChunks };
