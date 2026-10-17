// Spot: 1 ドキュメント envs/{spotsNs}/data/spots（{ version, spots, updatedAt }）。
// 保存は「読んだときの updateTime のままなら上書き」＋「古い内容を spotsHistory/{ms13 桁} に作る」を 1 回の commit で。
// 読み込みは SPOTS_CACHE_SEC のあいだ使い回す（自分の保存ですぐ入れ替える）。過ぎたら、最後に読めた内容（最大 1 時間前まで）を
// すぐ返して裏で読み直す（同時に来ても読むのは 1 回）。読めなかったら 30 秒（使える内容がなければ 5 秒）は読みに行かない。
// 保存より前に始まった読み直しの結果では、保存した内容を上書きしない。
// 使い回す内容は変えられないようにして（deepFreeze）そのまま返す
'use strict';

const { httpError } = require('../../http');
const { deepFreeze } = require('../../freeze');
const { MAX_BACKUPS, storeUnavailable } = require('../common');
const { updateWrite, createWrite, deleteWrite, dataOf, order } = require('../../firestore/writes');

const MAX_SPOTS_BYTES = 900_000; // 1 ドキュメントの上限（1 MiB）の手前
const STALE_MAX_MS = 3600_000;
const PRUNE_BATCH = 50;
const RETRY_AFTER_MS = 30_000; // 読めなかったあと、次に読みに行くまで（前の内容を返せるとき）
const NO_CACHE_RETRY_AFTER_MS = 5_000; // 返せる内容がないとき（503 になるので短く）
const EMPTY = { version: 2, spots: [] };

/** Spot のドキュメントのパス（spotsBase = envs/{spotsNs}） */
const spotsPath = (spotsBase) => `${spotsBase}/data/spots`;
// 外に返す形（updatedAt は保存先が付ける印なので外す）
const view = (data) => {
  const { updatedAt, ...rest } = data;
  return { ...EMPTY, ...rest };
};

function createSpots({ rest, spotsBase, now, cacheMs }) {
  let cache = null; // { at, value } 最後に読めた（書けた）内容。value は変えられない
  let reading = null;
  let failedAt = -Infinity;
  let saves = 0; // このインスタンスで保存した回数（読み直しが保存より前に始まったかを見分ける）
  let warnedMissing = false;

  async function readFresh() {
    const doc = await rest.get(spotsPath(spotsBase));
    if (!doc && !warnedMissing) {
      warnedMissing = true;
      console.warn(`[store] Spot のドキュメントがありません（${spotsBase}）。移行するまでは Spot なしで動きます`);
    }
    return { doc, value: doc ? view(dataOf(doc)) : { ...EMPTY, spots: [] } };
  }
  const remember = (value) => {
    cache = { at: now(), value: deepFreeze(value) };
    return cache.value;
  };

  function loadShared() {
    if (!reading) {
      const started = saves;
      reading = readFresh()
        .then(({ value }) => (started === saves ? remember(value) : cache.value), (e) => { failedAt = now(); throw e; })
        .finally(() => { reading = null; });
    }
    return reading;
  }

  // 新しい 20 個（MAX_BACKUPS）より古い履歴を消す。失敗しても保存は終わっている
  async function prune() {
    const old = await rest.runQuery(spotsBase, {
      from: [{ collectionId: 'spotsHistory' }], orderBy: [order('__name__', 'DESCENDING')], offset: MAX_BACKUPS, limit: PRUNE_BATCH, select: { fields: [{ fieldPath: '__name__' }] },
    });
    if (old.length) await rest.commit(old.map((d) => deleteWrite(d.name)), { retry: true }); // 消すだけなので、やり直しても同じ
  }

  function writesFor(doc, next) {
    const at = now();
    const saved = { ...next, updatedAt: new Date(at).toISOString() };
    if (Buffer.byteLength(JSON.stringify(saved), 'utf8') > MAX_SPOTS_BYTES) throw httpError(413, 'spots_too_large');
    try {
      const history = doc ? [createWrite(rest.docName(`${spotsBase}/spotsHistory/${String(at).padStart(13, '0')}`), { ...dataOf(doc), savedAt: saved.updatedAt })] : [];
      const main = updateWrite(rest.docName(spotsPath(spotsBase)), saved, { currentDocument: doc ? { updateTime: doc.updateTime } : { exists: false } });
      return [main, ...history];
    } catch (e) {
      if (e.code === 'unencodable') throw httpError(400, 'invalid spot data');
      throw e;
    }
  }

  return {
    async getSpots() {
      const age = cache ? now() - cache.at : Infinity;
      if (age < cacheMs) return cache.value;
      // 使い回さない設定（SPOTS_CACHE_SEC=0）では毎回読み、読めなかったときだけ最後の内容を使う
      if (!cacheMs) return loadShared().catch((e) => { if (age < STALE_MAX_MS) return cache.value; throw e; });
      const sinceFailure = now() - failedAt;
      if (age < STALE_MAX_MS) {
        if (sinceFailure >= RETRY_AFTER_MS) loadShared().catch(() => {}); // 裏で読み直す（失敗は rest.js がログに出す）
        return cache.value;
      }
      if (sinceFailure < NO_CACHE_RETRY_AFTER_MS) throw storeUnavailable(0, 'BACKOFF');
      return loadShared();
    },

    // fn(今の内容) => 新しい内容。fn には読み直したばかりの（変えてよい）内容を渡す。
    // ほかの保存と重なったら 1 回だけやり直し、だめなら 409
    async updateSpots(fn) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const { doc, value } = await readFresh();
        const next = fn(value);
        try {
          // やり直さない（届いたかどうか分からないまま書き直すと、削除などの結果が変わる）
          await rest.commit(writesFor(doc, next));
        } catch (e) {
          if (e.grpc === 'FAILED_PRECONDITION' || e.grpc === 'ALREADY_EXISTS') continue;
          throw e;
        }
        saves++;
        remember(view(structuredClone(next)));
        failedAt = -Infinity;
        await prune().catch(() => {});
        return next;
      }
      throw httpError(409, 'spots_conflict');
    },
  };
}

module.exports = { createSpots, spotsPath };
