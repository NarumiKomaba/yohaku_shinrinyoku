// 利用ログ: 1 回の appendEvents = 1 ドキュメント envs/{ns}/eventBatches/{ms13 桁}-{rand8}（{ day, ts, n, types, events }）
'use strict';

const crypto = require('crypto');
const { jstDay } = require('../../limits');
const { isEncodable } = require('../../firestore/encode');
const { createWrite, dataOf, byField, order } = require('../../firestore/writes');

/** まとめの ID（時刻順に並ぶ）。suffix は普段は乱数 8 桁、移行では内容から決まる値 */
const batchId = (ms, suffix) => `${String(ms).padStart(13, '0')}-${suffix}`;
/** まとめのドキュメント。day（日本時間）で範囲検索する */
const batchDoc = (events, ms) => ({ day: jstDay(ms), ts: new Date(ms).toISOString(), n: events.length, types: [...new Set(events.map((e) => String(e.type)))], events });

function createEvents({ rest, base, now }) {
  // ID の時刻は、同じミリ秒に 2 回書いても書いた順に並ぶよう、このインスタンスの中では必ず増やす
  let lastIdMs = 0;
  const nextId = (ms) => {
    lastIdMs = Math.max(ms, lastIdMs + 1);
    return batchId(lastIdMs, crypto.randomBytes(4).toString('hex'));
  };
  return {
    async appendEvents(events) {
      // Firestore に書けないイベント（空のキーなど）はそのイベントだけ捨てる（まとめ全体を失わない）
      const ok = events.filter(isEncodable);
      if (!ok.length) return 0;
      const ms = now();
      try {
        await rest.commit([createWrite(rest.docName(`${base}/eventBatches/${nextId(ms)}`), batchDoc(ok, ms))], { retry: true });
      } catch (e) {
        // 再試行の前に書けていた（ID はこちらで決めているので、同じものがあれば書けている）
        if (e.grpc !== 'ALREADY_EXISTS') throw e;
      }
      return ok.length;
    },

    // day の範囲を新しいものから読み（上限に届いたら古い分を読まない）、書いた順に並べ直して返す。day の単一フィールド索引で動く
    async listEvents({ fromDay, toDay, maxDocs }) {
      const query = {
        from: [{ collectionId: 'eventBatches' }],
        where: { compositeFilter: { op: 'AND', filters: [byField('day', 'GREATER_THAN_OR_EQUAL', { stringValue: fromDay }), byField('day', 'LESS_THAN_OR_EQUAL', { stringValue: toDay })] } },
        orderBy: [order('day', 'DESCENDING'), order('__name__', 'DESCENDING')],
      };
      const { documents, truncated } = await rest.queryAll(base, query, { maxDocs, map: dataOf });
      return { events: [...documents].reverse().flatMap((d) => d.events || []), truncated };
    },
  };
}

module.exports = { createEvents, batchId, batchDoc };
