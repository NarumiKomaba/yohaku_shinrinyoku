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

/**
 * 回数を数える単位。IPv4 はアドレスそのまま、IPv6 は /64（先頭 4 ブロック）にまとめる
 * （/64 の中ではアドレスを自由に変えられるため、アドレス単位だと上限を回避できる）
 */
function ipBucket(ip) {
  const s = String(ip || '').trim().toLowerCase();
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  if (!s.includes(':')) return s || 'unknown';
  const [head, tail = ''] = s.split('%')[0].split('::');
  const left = head ? head.split(':') : [];
  const right = s.includes('::') && tail ? tail.split(':') : [];
  const full = s.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${full.slice(0, 4).map((x) => (x || '0').replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * 失敗回数の制限: windowMs のあいだに、1 つの key で max 回失敗したら、窓が終わるまで 429。
 * 全体で globalMax 回失敗したあとは、この窓の中で 1 回でも失敗した key だけを止める（失敗していない人まで締め出さない）。
 * check と fail のあいだに await を挟まないこと（挟むと、同時に送ったリクエストが全部 check を通ってしまう）。
 * 調べるのに await が要るときは、先に fail で数えてから調べ、正しければ undo で取り消す
 */
function createFailureLimiter({ max = 10, globalMax = 200, windowMs = 10 * 60_000, now = Date.now } = {}) {
  const fails = new Map(); // key -> { n, until }
  let total = { n: 0, until: 0 };
  const current = (key) => {
    const f = fails.get(key);
    return f && f.until > now() ? f : null;
  };
  return {
    check(key) {
      const f = current(key);
      if (f && f.n >= max) throw httpError(429, 'too_many_attempts');
      if (f && total.until > now() && total.n >= globalMax) throw httpError(429, 'too_many_attempts');
    },
    fail(key) {
      const f = current(key);
      if (!f) capSize(fails);
      fails.set(key, f ? { n: f.n + 1, until: f.until } : { n: 1, until: now() + windowMs });
      total = total.until > now() ? { n: total.n + 1, until: total.until } : { n: 1, until: now() + windowMs };
    },
    /** 先に fail で数えてから調べ、正しかったときに 1 回分を取り消す（await の前に数えるため） */
    undo(key) {
      const f = current(key);
      if (!f) return;
      if (f.n > 1) fails.set(key, { n: f.n - 1, until: f.until });
      else fails.delete(key);
      if (total.until > now() && total.n > 0) total = { n: total.n - 1, until: total.until };
    },
  };
}

/** 一定時間あたりの回数（固定の窓）。max = 0 は無制限。take() は使えたら true */
function createWindowCounter({ max = 0, windowMs = 60_000, now = Date.now } = {}) {
  const counts = new Map(); // key -> { n, until }
  return {
    take(key = '') {
      if (!max) return true;
      const c = counts.get(key);
      const live = c && c.until > now() ? c : null;
      if (live && live.n >= max) return false;
      if (!c) capSize(counts);
      counts.set(key, live ? { n: live.n + 1, until: live.until } : { n: 1, until: now() + windowMs });
      return true;
    },
  };
}

/** 日本時間の 1 日ごとの回数。max = 0 は無制限。take() は使えたら true */
function createDailyCounter({ max = 0, now = Date.now } = {}) {
  let day = '';
  let counts = new Map();
  const roll = () => {
    const today = jstDay(now());
    if (today !== day) { day = today; counts = new Map(); }
  };
  return {
    /** まだ使えるか（数えない） */
    peek(key = '') {
      roll();
      return !max || (counts.get(key) || 0) < max;
    },
    take(key = '') {
      roll();
      const n = counts.get(key) || 0;
      if (max && n >= max) return false;
      if (!counts.has(key)) capSize(counts);
      counts.set(key, n + 1);
      return true;
    },
  };
}

module.exports = { jstDay, clientIp, ipBucket, capSize, createFailureLimiter, createWindowCounter, createDailyCounter, MAX_KEYS };
