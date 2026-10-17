// 記録の保存先。STORE_BACKEND（file・memory・firestore。既定 file）で選び、どれにも同じ守りをかける:
// 利用ログの 1 日の量（EVENTS_DAILY_BYTES）と回数（EVENTS_DAILY_WRITES）、書けなかったイベントの持ち越し、終了時の書き出し。
// 保存先が止まったら 30 秒は呼ばずに持ち越す（ログを書くのを待って、体験の応答が遅くならないように）
'use strict';

const cfg = require('../config');
const { jstDay } = require('../limits');

const PENDING_MAX = 500; // 書けなかったイベントをメモリに残す数（新しいものから）
const DOC_BYTES = 200_000; // 1 ドキュメントに入れる量（Firestore の 1 ドキュメントの上限 1 MiB より十分小さく）
const DOC_EVENTS = 500;
const PAUSE_MS = 30_000; // 一時的に書けなかったあと、保存先を呼ばない時間
const lineBytes = (e) => Buffer.byteLength(JSON.stringify(e), 'utf8') + 1; // JSON 1 行ずつで数える
const sizeOf = (events) => events.reduce((a, e) => a + lineBytes(e), 0);
// 保存先が受け付けない（400: INVALID_ARGUMENT など）ものは、やり直しても書けないので持ち越さない
const isPermanent = (e) => e.upstreamStatus === 400;

/** 1 ドキュメントずつに分ける（docBytes・docEvents まで。1 件で docBytes を超えるものはそれだけで 1 つ） */
function splitDocs(events, docBytes, docEvents) {
  const docs = events.reduce((acc, e) => {
    const last = acc[acc.length - 1];
    const bytes = lineBytes(e);
    if (last && last.events.length < docEvents && last.bytes + bytes <= docBytes) return [...acc.slice(0, -1), { events: [...last.events, e], bytes: last.bytes + bytes }];
    return [...acc, { events: [e], bytes }];
  }, []);
  return docs.map((d) => d.events);
}

function createStore(backend, { dailyBytes = 0, dailyWrites = 0, pendingMax = PENDING_MAX, docBytes = DOC_BYTES, docEvents = DOC_EVENTS, now = Date.now } = {}) {
  let used = { day: '', bytes: 0, writes: 0 };
  let pending = [];
  let pausedUntil = 0;
  const inflight = new Set();
  const paused = () => now() < pausedUntil;

  // await の前に枠を取る（同時に来た書き込みが全部上限の確認を通らないように）。書けなければ release で戻す
  function reserve(bytes) {
    const day = jstDay(now());
    const cur = used.day === day ? used : { day, bytes: 0, writes: 0 };
    if (dailyBytes && cur.bytes + bytes > dailyBytes) return null;
    if (dailyWrites && cur.writes + 1 > dailyWrites) return null;
    used = { day, bytes: cur.bytes + bytes, writes: cur.writes + 1 };
    return { day, bytes };
  }
  function release(r) {
    if (used.day === r.day) used = { ...used, bytes: used.bytes - r.bytes, writes: used.writes - 1 };
  }

  // 1 ドキュメント分を書く。上限を超えたら 0（捨てる）。書けなければ例外
  async function write(events) {
    const r = reserve(sizeOf(events));
    if (!r) return 0;
    try {
      return await backend.appendEvents(events);
    } catch (e) {
      release(r);
      throw e;
    }
  }
  function tracked(promise) {
    inflight.add(promise);
    promise.then(() => inflight.delete(promise), () => inflight.delete(promise));
    return promise;
  }

  // ドキュメントに分けて書く。書けた件数と、あとで書き直す分（failed）を返す。
  // 一時的に書けなかったら、残りは試さずに持ち越し、しばらく保存先を呼ばない
  async function writeDocs(events) {
    const docs = splitDocs(events, docBytes, docEvents);
    let written = 0;
    for (let i = 0; i < docs.length; i++) {
      try {
        written += await tracked(write(docs[i]));
      } catch (e) {
        if (isPermanent(e)) {
          console.error(`[store] appendEvents dropped ${docs[i].length} events (${e.upstreamStatus} ${e.grpc || ''})`);
          continue;
        }
        if (e.message !== 'store_unavailable') console.error('[store] appendEvents failed:', e.message);
        pausedUntil = now() + PAUSE_MS;
        return { written, failed: docs.slice(i).flat() };
      }
    }
    return { written, failed: [] };
  }

  // 古いものから順に並べ、新しいものから pendingMax 件だけ残す
  const keep = (older, newer) => { pending = [...older, ...newer].slice(-pendingMax); };
  async function retryPending() {
    const batch = pending;
    pending = [];
    const { failed } = await writeDocs(batch);
    if (failed.length) keep(failed, pending);
  }

  /** 書けた件数。例外は投げない（ログが書けなくても体験は止めない）。書けなかった分は次に書けたときと終了時に書き直す */
  async function appendEvents(events) {
    if (!events.length) return 0;
    if (paused()) {
      keep(pending, events);
      return 0;
    }
    const { written, failed } = await writeDocs(events);
    if (failed.length) keep(pending, failed);
    else if (written && pending.length) await retryPending();
    return written;
  }

  /** 書きかけを待ち、持ち越したイベントを書く（SIGTERM で呼ぶ。止まっている途中でも最後に 1 回は試す） */
  async function flush() {
    await Promise.allSettled([...inflight]);
    if (pending.length) await retryPending();
  }

  /** 先にトークンなどを用意する（Firestore 版だけ）。失敗しても何もしない（token.js がログを出す） */
  const warmUp = () => Promise.resolve(backend.warmUp && backend.warmUp()).then(() => {}, () => {});

  return { ...backend, appendEvents, flush, warmUp };
}

function createBackend() {
  if (cfg.STORE_BACKEND === 'file') return require('./file').createFileStore({ dataDir: cfg.DATA_DIR });
  if (cfg.STORE_BACKEND === 'memory') return require('./memory').createMemoryStore({ dataDir: cfg.DATA_DIR });
  if (cfg.STORE_BACKEND === 'firestore') return require('./firestore').fromConfig(cfg);
  throw new Error(`STORE_BACKEND は file・memory・firestore のどれかにしてください（${cfg.STORE_BACKEND}）`);
}

const store = createStore(createBackend(), { dailyBytes: cfg.EVENTS_DAILY_BYTES, dailyWrites: cfg.EVENTS_DAILY_WRITES });

module.exports = { ...store, createStore };
