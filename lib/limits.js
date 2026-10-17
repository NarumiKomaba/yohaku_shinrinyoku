// 回数の上限（メモリ上）: 日本時間の日付、失敗回数の制限、日ごとの回数、接続元 IP の取り出し
'use strict';

const { httpError } = require('./http');

const JST_OFFSET_MS = 9 * 3600 * 1000;
const MAX_KEYS = 10_000; // Map が際限なく増えないようにする

/** 日本時間の日付（YYYY-MM-DD）。nowMs を渡せるのはテスト用 */
const jstDay = (nowMs = Date.now()) => new Date(nowMs + JST_OFFSET_MS).toISOString().slice(0, 10);

// 古いものから消す（Map は追加順を保つ）
function capSize(map, max = MAX_KEYS) {
  while (map.size >= max) map.delete(map.keys().next().value);
}

/**
 * 接続元 IP。trustedHops = 信頼するプロキシの段数（Cloud Run なら 1）。
 * X-Forwarded-For の先頭はクライアントが自由に書けるので使わず、信頼するプロキシが足した右端から数える。
 */
function clientIp(req, trustedHops = 0) {
  if (trustedHops > 0) {
    const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length >= trustedHops) return hops[hops.length - trustedHops];
  }
  return req.socket.remoteAddress || 'unknown';
}

/** 失敗回数の制限: windowMs のあいだに max 回失敗したら、窓が終わるまで 429 */
function createFailureLimiter({ max = 10, windowMs = 10 * 60_000, now = Date.now } = {}) {
  const fails = new Map(); // key -> { n, until }
  const current = (key) => {
    const f = fails.get(key);
    return f && f.until > now() ? f : null;
  };
  return {
    check(key) {
      const f = current(key);
      if (f && f.n >= max) throw httpError(429, 'too_many_attempts');
    },
    fail(key) {
      const f = current(key);
      if (!f) capSize(fails);
      fails.set(key, f ? { n: f.n + 1, until: f.until } : { n: 1, until: now() + windowMs });
    },
  };
}

/** 日本時間の 1 日ごとの回数。max = 0 は無制限。take() は使えたら true */
function createDailyCounter({ max = 0, now = Date.now } = {}) {
  let day = '';
  let counts = new Map();
  return {
    take(key = '') {
      const today = jstDay(now());
      if (today !== day) { day = today; counts = new Map(); }
      const n = counts.get(key) || 0;
      if (max && n >= max) return false;
      if (!counts.has(key)) capSize(counts);
      counts.set(key, n + 1);
      return true;
    },
  };
}

module.exports = { jstDay, clientIp, capSize, createFailureLimiter, createDailyCounter, MAX_KEYS };
