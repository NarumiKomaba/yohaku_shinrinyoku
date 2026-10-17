'use strict';
// テスト用の Firestore（REST v1 の commit・batchWrite・get・runQuery を、使う範囲だけメモリで再現する）。fetch として渡す。
// 条件付きの書き込み（currentDocument の exists・updateTime）、updateMask、where（範囲・等号・AND）、orderBy、startAt、offset、limit、select
const { fromValue } = require('../lib/firestore/encode');

const API = 'https://firestore.googleapis.com/v1/';

function createFakeFirestore({ projectId = 'p1', database = '(default)' } = {}) {
  const root = `projects/${projectId}/databases/${database}/documents`;
  let docs = new Map(); // name -> { name, fields, createTime, updateTime }
  let clock = 0;
  let faults = []; // 次の呼び出しから順に返すエラー { status, grpc }
  let commitHooks = []; // 次の commit の直前に 1 回ずつ呼ぶ（ほかのインスタンスの書き込みを割り込ませる）
  const calls = [];
  const stamp = () => `2026-01-01T00:00:00.${String(++clock).padStart(6, '0')}Z`;
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fail = (status, grpc) => reply({ error: { code: status, message: `fake ${grpc}`, status: grpc } }, status);

  // 1 つの書き込みを確かめる。だめならエラー（{ status, grpc }）
  function checkWrite(w, state) {
    const name = w.update ? w.update.name : w.delete;
    if (!name || !name.startsWith(`${root}/`)) return { status: 400, grpc: 'INVALID_ARGUMENT' };
    const cur = state.get(name);
    const pre = w.currentDocument;
    if (pre && pre.exists === false && cur) return { status: 409, grpc: 'ALREADY_EXISTS' };
    if (pre && pre.exists === true && !cur) return { status: 404, grpc: 'NOT_FOUND' };
    if (pre && pre.updateTime && (!cur || cur.updateTime !== pre.updateTime)) return { status: 400, grpc: 'FAILED_PRECONDITION' };
    return null;
  }

  function applyWrite(w, state, time) {
    if (w.delete) { state.delete(w.delete); return state; }
    const { name, fields = {} } = w.update;
    const cur = state.get(name);
    let next = fields;
    if (w.updateMask && cur) {
      const masked = Object.fromEntries(Object.entries(cur.fields).filter(([k]) => !w.updateMask.fieldPaths.includes(k)));
      next = { ...masked, ...Object.fromEntries(Object.entries(fields).filter(([k]) => w.updateMask.fieldPaths.includes(k))) };
    }
    return state.set(name, { name, fields: next, createTime: cur ? cur.createTime : time, updateTime: time });
  }

  function commit(body) {
    if (commitHooks.length) commitHooks.shift()();
    const writes = body.writes || [];
    for (const w of writes) {
      const err = checkWrite(w, docs);
      if (err) return fail(err.status, err.grpc);
    }
    const time = stamp();
    docs = writes.reduce((state, w) => applyWrite(w, state, time), new Map(docs));
    return reply({ commitTime: time, writeResults: writes.map(() => ({ updateTime: time })) });
  }

  function batchWrite(body) {
    const status = (body.writes || []).map((w) => {
      const err = checkWrite(w, docs);
      if (err) return { code: err.grpc === 'ALREADY_EXISTS' ? 6 : 9, message: err.grpc };
      docs = applyWrite(w, new Map(docs), stamp());
      return { code: 0 };
    });
    return reply({ writeResults: status.map(() => ({})), status });
  }

  // 値の比較（文字列・数・参照）。null は一番前
  const plain = (v) => ('referenceValue' in v ? v.referenceValue : fromValue(v));
  const cmp = (a, b) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1);
  const fieldOf = (doc, path) => (path === '__name__' ? { referenceValue: doc.name } : doc.fields[path] || { nullValue: 'NULL_VALUE' });
  const OPS = {
    EQUAL: (c) => c === 0, LESS_THAN: (c) => c < 0, LESS_THAN_OR_EQUAL: (c) => c <= 0,
    GREATER_THAN: (c) => c > 0, GREATER_THAN_OR_EQUAL: (c) => c >= 0,
  };
  function matches(doc, filter) {
    if (!filter) return true;
    if (filter.compositeFilter) return filter.compositeFilter.filters.every((f) => matches(doc, f));
    const { field, op, value } = filter.fieldFilter;
    if (!field.fieldPath || !(field.fieldPath === '__name__' || field.fieldPath in doc.fields)) return false;
    return OPS[op](cmp(plain(fieldOf(doc, field.fieldPath)), plain(value)));
  }

  function runQuery(parent, body) {
    const q = body.structuredQuery;
    const prefix = `${parent}/${q.from[0].collectionId}/`;
    const orderBy = [...(q.orderBy || [])];
    if (!orderBy.some((o) => o.field.fieldPath === '__name__')) orderBy.push({ field: { fieldPath: '__name__' }, direction: (orderBy[orderBy.length - 1] || {}).direction || 'ASCENDING' });
    const key = (doc) => orderBy.map((o) => plain(fieldOf(doc, o.field.fieldPath)));
    const compare = (ka, kb) => {
      for (let i = 0; i < orderBy.length; i++) {
        const c = cmp(ka[i], kb[i]) * (orderBy[i].direction === 'DESCENDING' ? -1 : 1);
        if (c) return c;
      }
      return 0;
    };
    let hits = [...docs.values()].filter((d) => d.name.startsWith(prefix) && !d.name.slice(prefix.length).includes('/') && matches(d, q.where));
    hits = hits.sort((a, b) => compare(key(a), key(b)));
    if (q.startAt) {
      const at = q.startAt.values.map(plain);
      hits = hits.filter((d) => { const c = compare(key(d), at); return q.startAt.before ? c >= 0 : c > 0; });
    }
    hits = hits.slice(q.offset || 0, q.limit === undefined ? undefined : (q.offset || 0) + q.limit);
    const pick = (d) => (q.select ? { ...d, fields: Object.fromEntries(Object.entries(d.fields).filter(([k]) => q.select.fields.some((f) => f.fieldPath === k))) } : d);
    const time = stamp();
    return reply(hits.length ? hits.map((d) => ({ document: pick(d), readTime: time })) : [{ readTime: time }]);
  }

  async function fetch(url, init = {}) {
    const u = String(url);
    calls.push({ url: u, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    if (faults.length) {
      const f = faults.shift();
      if (f.network) throw new TypeError('fetch failed');
      return fail(f.status, f.grpc);
    }
    if (!u.startsWith(API)) throw new Error(`fake firestore: unexpected url ${u}`);
    const path = u.slice(API.length);
    const body = init.body ? JSON.parse(init.body) : {};
    if (path === `${root}:commit`) return commit(body);
    if (path === `${root}:batchWrite`) return batchWrite(body);
    if (path.endsWith(':runQuery')) return runQuery(path.slice(0, -':runQuery'.length), body);
    if (init.method === 'GET') return docs.has(path) ? reply(docs.get(path)) : fail(404, 'NOT_FOUND');
    throw new Error(`fake firestore: unsupported ${init.method} ${u}`);
  }

  return {
    fetch,
    calls,
    root,
    /** 次の n 回の呼び出しを失敗させる */
    failNext(n = 1, status = 503, grpc = 'UNAVAILABLE') { faults = [...faults, ...Array.from({ length: n }, () => ({ status, grpc }))]; },
    failNetwork(n = 1) { faults = [...faults, ...Array.from({ length: n }, () => ({ network: true }))]; },
    clearFaults() { faults = []; },
    beforeCommit(fn) { commitHooks = [...commitHooks, fn]; },
    /** path（envs/...）の下にあるドキュメント（名前の一覧） */
    list(prefix) { return [...docs.keys()].filter((n) => n.startsWith(`${root}/${prefix}`)).map((n) => n.slice(root.length + 1)).sort(); },
    getFields(path) { const d = docs.get(`${root}/${path}`); return d ? d.fields : null; },
    /** 外から書き換える（ほかのインスタンスの保存を再現する） */
    touch(path, fields) { const name = `${root}/${path}`; docs = applyWrite({ update: { name, fields } }, new Map(docs), stamp()); },
  };
}

const fakeTokens = () => ({ get: async () => 'fake-token', invalidate() {} });

module.exports = { createFakeFirestore, fakeTokens };
