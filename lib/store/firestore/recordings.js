// 録音ウォーク: 本体 envs/{ns}/recordings/{rid}（{ id, createdAt, status, finishingAt, finishedAt, candidates, lastChunkAt }）と
// chunks/{index 6 桁}（{ index, startedAt, durationSec, segments, error, track }）。
// 同じ時刻の点は getRecording で集めるときに除く。終わったら軌跡は消す（文字起こしと候補は残す）。
// 読んだ記録には version（本体の updateTime）が付き、setRecordingStatus・putRecordingChunk の ifVersion に渡すと読み直さずに書ける。
// chunk は本体の version を条件に本体（lastChunkAt）と一緒に書くので、finish（本体の状態を変える）と同時には成り立たない
'use strict';

const { httpError } = require('../../http');
const { RECORDING_ID_RE, MAX_CHUNKS, checkId, checkChunkIndex, mergeChunks } = require('../common');
const { updateWrite, createWrite, dataOf, order } = require('../../firestore/writes');

const CHUNK_TRIES = 3; // ほかの chunk と重なったときにやり直す回数
const CHUNK_PAGE = 20; // chunk は軌跡を含んで大きいので、少しずつ読む

/** 録音の本体と chunk のパス（base = envs/{ns}） */
const recPath = (base, rid) => `${base}/recordings/${checkId(RECORDING_ID_RE, rid, 'recording id')}`;
const chunkPath = (base, rid, index) => `${recPath(base, rid)}/chunks/${String(checkChunkIndex(index)).padStart(6, '0')}`;

function createRecordings({ rest, base, now }) {
  const chunksQuery = (extra = {}) => ({ from: [{ collectionId: 'chunks' }], orderBy: [order('__name__')], ...extra });
  const meta = (doc) => (doc ? { ...dataOf(doc), version: doc.updateTime } : null);

  // 録音中なら本体の version。終わっていれば 409
  async function recordingVersion(rid) {
    const doc = await rest.get(recPath(base, rid));
    if (!doc) throw httpError(404, 'recording not found');
    if (dataOf(doc).status !== 'recording') throw httpError(409, 'recording already finished');
    return doc.updateTime;
  }

  return {
    async createRecording(rec) {
      try {
        await rest.commit([createWrite(rest.docName(recPath(base, rec.id)), rec)], { retry: true });
      } catch (e) {
        // id は作るたびに新しい UUID なので、あれば再試行の前に書けていた
        if (e.grpc !== 'ALREADY_EXISTS') throw e;
      }
    },

    /** 本体だけ（chunk は読まない） */
    async getRecordingMeta(rid) {
      return meta(await rest.get(recPath(base, rid)));
    },

    async getRecording(rid) {
      const [doc, { documents }] = await Promise.all([rest.get(recPath(base, rid)), rest.queryAll(recPath(base, rid), chunksQuery(), { pageSize: CHUNK_PAGE, maxDocs: MAX_CHUNKS, map: dataOf })]);
      return doc ? { ...meta(doc), ...mergeChunks(documents) } : null;
    },

    // 同じ番号の chunk は置き換える。録音中のときだけ（finish が先なら 409 で、軌跡も書かない）
    async putRecordingChunk(rid, chunk, track, { ifVersion } = {}) {
      const chunkWrite = updateWrite(rest.docName(chunkPath(base, rid, chunk.index)), { ...chunk, track });
      let version = ifVersion;
      for (let attempt = 0; attempt < CHUNK_TRIES; attempt++) {
        if (!version) version = await recordingVersion(rid);
        const touch = updateWrite(rest.docName(recPath(base, rid)), { lastChunkAt: new Date(now()).toISOString() }, { mask: ['lastChunkAt'], currentDocument: { updateTime: version } });
        try {
          // やり直して「変わっていた」になっても、読み直して録音中なら書き直す（同じ chunk の置き換え）
          await rest.commit([chunkWrite, touch], { retry: true });
          return;
        } catch (e) {
          if (e.grpc !== 'FAILED_PRECONDITION') throw e;
          version = null;
        }
      }
      throw httpError(409, 'recording busy');
    },

    // 状態が ifStatus で、そのあと変わっていなければ patch を書く。書けたら新しい version、書けなければ false。
    // ifVersion を渡すと読み直さない（ifStatus は呼び出し側が同じ読み込みで確かめている）。
    // dropTrack では、今ある chunk を検索して全部の軌跡を消す
    async setRecordingStatus(rid, patch, { ifStatus, ifVersion, dropTrack = false } = {}) {
      let updateTime = ifVersion;
      if (!updateTime) {
        const doc = await rest.get(recPath(base, rid));
        if (!doc || (ifStatus !== undefined && dataOf(doc).status !== ifStatus)) return false;
        updateTime = doc.updateTime;
      }
      const chunks = dropTrack ? await rest.runQuery(recPath(base, rid), chunksQuery({ limit: MAX_CHUNKS, select: { fields: [{ fieldPath: '__name__' }] } })) : [];
      const writes = [
        updateWrite(rest.docName(recPath(base, rid)), patch, { mask: Object.keys(patch), currentDocument: { updateTime } }),
        ...chunks.map((c) => updateWrite(c.name, {}, { mask: ['track'], currentDocument: { exists: true } })),
      ];
      try {
        // やり直して false（変わっていた）になったら、呼び出し側が読み直して自分の書き込みか確かめる
        const res = await rest.commit(writes, { retry: true });
        return res.writeResults[0].updateTime;
      } catch (e) {
        if (e.grpc === 'FAILED_PRECONDITION') return false;
        throw e;
      }
    },
  };
}

module.exports = { createRecordings, recPath, chunkPath };
