// 購入（モック）: envs/{ns}/purchases/{code}。getPurchase は version（updateTime）も返し、markPurchaseUsed で読み直さずに使える
'use strict';

const { PURCHASE_CODE_RE, purchaseExists, checkId } = require('../common');
const { updateWrite, createWrite, dataOf, order } = require('../../firestore/writes');

const MAX_PURCHASES = 5000; // 集計で読む上限

function createPurchases({ rest, base }) {
  const path = (code) => `${base}/purchases/${checkId(PURCHASE_CODE_RE, code, 'purchase code')}`;
  const markWrite = (code, at, updateTime) => updateWrite(rest.docName(path(code)), { usedAt: at }, { mask: ['usedAt'], currentDocument: { updateTime } });

  // 書けたら true。読んだときから変わっていれば false
  async function tryMark(code, at, updateTime) {
    try {
      // やり直して「変わっていた」になっても、呼び出し側が読み直して確かめる
      await rest.commit([markWrite(code, at, updateTime)], { retry: true });
      return true;
    } catch (e) {
      if (e.grpc !== 'FAILED_PRECONDITION') throw e;
      return false;
    }
  }

  return {
    async listPurchases() {
      const { documents, truncated } = await rest.queryAll(base, { from: [{ collectionId: 'purchases' }], orderBy: [order('__name__')] }, { maxDocs: MAX_PURCHASES, map: dataOf });
      return { purchases: documents, truncated };
    },

    async createPurchase(p) {
      try {
        // やり直して ALREADY_EXISTS になったら、コードを作り直す（呼び出し側）。使われない購入が 1 つ残るだけ
        await rest.commit([createWrite(rest.docName(path(p.code)), p)], { retry: true });
      } catch (e) {
        if (e.grpc === 'ALREADY_EXISTS') throw purchaseExists();
        throw e;
      }
    },

    async getPurchase(code) {
      if (!PURCHASE_CODE_RE.test(String(code))) return null;
      const doc = await rest.get(path(code));
      return doc ? { ...dataOf(doc), version: doc.updateTime } : null;
    },

    // usedAt を最初の 1 回だけ書く。ifVersion（getPurchase の version）があれば読み直さずに書く。
    // 重なったら読み直し、もう書かれていれば成功
    async markPurchaseUsed(code, at, { ifVersion } = {}) {
      if (!PURCHASE_CODE_RE.test(String(code))) return false;
      if (ifVersion && await tryMark(code, at, ifVersion)) return true;
      for (let attempt = 0; attempt < 2; attempt++) {
        const doc = await rest.get(path(code));
        if (!doc) return false;
        if (dataOf(doc).usedAt) return true;
        if (await tryMark(code, at, doc.updateTime)) return true;
      }
      return false;
    },
  };
}

module.exports = { createPurchases };
