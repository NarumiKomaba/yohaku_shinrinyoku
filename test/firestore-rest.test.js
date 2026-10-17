'use strict';
// lib/firestore/rest.js: URL・ヘッダー、再試行するもの・しないもの、401 での取り直し、エラーとログに中身を出さないこと
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createRest } = require('../lib/firestore/rest');

const ROOT = 'projects/p1/databases/(default)/documents';
const URL_ROOT = `https://firestore.googleapis.com/v1/${ROOT}`;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fsError = (status, grpc, message = 'secret detail from server') => json({ error: { code: status, message, status: grpc } }, status);

function setup(responses, opts = {}) {
  const calls = [];
  const sleeps = [];
  let invalidated = 0;
  let tokenN = 0;
  const tokens = { get: async () => `tok-${tokenN}`, invalidate: () => { invalidated++; tokenN++; } };
  const fetch = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  };
  const rest = createRest({ projectId: 'p1', fetch, tokens, sleep: async (ms) => { sleeps.push(ms); }, ...opts });
  return { rest, calls, sleeps, invalidated: () => invalidated };
}

let logs;
const realError = console.error;
beforeEach(() => { logs = []; console.error = (...a) => logs.push(a.join(' ')); });
afterEach(() => { console.error = realError; });

test('commit_postsWritesWithAuthAndUserProject', async () => {
  const { rest, calls } = setup([json({ commitTime: 't', writeResults: [{}] })], { userProject: 'p1' });
  const writes = [{ update: { name: `${ROOT}/envs/a/purchases/KG-000001`, fields: {} }, currentDocument: { exists: false } }];
  const out = await rest.commit(writes);
  assert.equal(out.commitTime, 't');
  assert.equal(calls[0].url, `${URL_ROOT}:commit`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-0');
  assert.equal(calls[0].init.headers['x-goog-user-project'], 'p1');
  assert.ok(calls[0].init.signal, 'タイムアウトを付ける');
  assert.deepEqual(calls[0].body, { writes });
});

test('withoutUserProject_doesNotSendHeader', async () => {
  const { rest, calls } = setup([json({})]);
  await rest.commit([]);
  assert.ok(!('x-goog-user-project' in calls[0].init.headers));
});

test('docName_buildsFullName', () => {
  const { rest } = setup([]);
  assert.equal(rest.docName('envs/a/data/spots'), `${ROOT}/envs/a/data/spots`);
});

test('get_returnsDocument_orNullWhenNotFound', async () => {
  const doc = { name: `${ROOT}/envs/a/data/spots`, fields: { version: { integerValue: '2' } }, updateTime: 'u1' };
  const { rest, calls } = setup([json(doc), fsError(404, 'NOT_FOUND')]);
  assert.deepEqual(await rest.get('envs/a/data/spots'), doc);
  assert.equal(calls[0].url, `${URL_ROOT}/envs/a/data/spots`);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(await rest.get('envs/a/data/none'), null);
  assert.deepEqual(logs, [], 'ないのは想定どおりなのでログに出さない');
});

test('runQuery_postsToParentAndReturnsOnlyDocuments', async () => {
  const d1 = { name: `${ROOT}/envs/a/eventBatches/1`, fields: {} };
  const { rest, calls } = setup([json([{ document: d1, readTime: 'r' }, { readTime: 'r', skippedResults: 0 }]), json([{ readTime: 'r' }])]);
  const q = { from: [{ collectionId: 'eventBatches' }], limit: 10 };
  assert.deepEqual(await rest.runQuery('envs/a', q), [d1]);
  assert.equal(calls[0].url, `${URL_ROOT}/envs/a:runQuery`);
  assert.deepEqual(calls[0].body, { structuredQuery: q });
  assert.deepEqual(await rest.runQuery('envs/a', q), [], '結果がなければ readTime だけが返る');
});

test('retryable_errors_areRetriedTwiceWith200And600ms', async () => {
  for (const bad of [() => fsError(503, 'UNAVAILABLE'), () => fsError(500, 'INTERNAL'), () => fsError(429, 'RESOURCE_EXHAUSTED'), () => fsError(409, 'ABORTED')]) {
    const { rest, calls, sleeps } = setup([bad(), bad(), json({ ok: 1 })]);
    assert.deepEqual(await rest.commit([], { retry: true }), { ok: 1 });
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [200, 600]);
  }
});

test('retryable_afterTwoRetries_throwsStoreUnavailableWithCodeOnly', async () => {
  const { rest, calls } = setup([fsError(503, 'UNAVAILABLE'), fsError(503, 'UNAVAILABLE'), fsError(503, 'UNAVAILABLE')]);
  await assert.rejects(rest.commit([], { retry: true }), (e) => e.message === 'store_unavailable' && e.status === 503 && e.upstreamStatus === 503 && e.grpc === 'UNAVAILABLE');
  assert.equal(calls.length, 3);
  assert.deepEqual(logs, ['[store] commit 503 UNAVAILABLE']);
});

test('networkErrorsAndTimeouts_areRetried', async () => {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const { rest } = setup([new TypeError('fetch failed'), timeout, json({ ok: 2 })]);
  assert.deepEqual(await rest.commit([], { retry: true }), { ok: 2 });
  const failing = setup([new TypeError('fetch failed'), new TypeError('fetch failed'), new TypeError('fetch failed')]);
  await assert.rejects(failing.rest.commit([], { retry: true }), (e) => e.message === 'store_unavailable' && e.grpc === 'NETWORK');
});

test('nonRetryable_errors_failAtOnce', async () => {
  for (const [status, grpc] of [[400, 'FAILED_PRECONDITION'], [403, 'PERMISSION_DENIED'], [404, 'NOT_FOUND'], [409, 'ALREADY_EXISTS'], [400, 'INVALID_ARGUMENT']]) {
    const { rest, calls } = setup([fsError(status, grpc)]);
    await assert.rejects(rest.commit([], { retry: true }), (e) => e.message === 'store_unavailable' && e.grpc === grpc && e.upstreamStatus === status);
    assert.equal(calls.length, 1, grpc);
  }
  assert.deepEqual(logs, ['[store] commit 403 PERMISSION_DENIED', '[store] commit 400 INVALID_ARGUMENT'], '条件の不一致・重なり・ないものは呼び出し側が扱うのでログに出さない');
});

test('unauthenticated_refreshesTokenOnceAndRetries', async () => {
  const { rest, calls, invalidated } = setup([fsError(401, 'UNAUTHENTICATED'), json({ ok: 3 })]);
  assert.deepEqual(await rest.commit([]), { ok: 3 });
  assert.equal(invalidated(), 1);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer tok-1');
  const twice = setup([fsError(401, 'UNAUTHENTICATED'), fsError(401, 'UNAUTHENTICATED')]);
  await assert.rejects(twice.rest.commit([]), (e) => e.grpc === 'UNAUTHENTICATED');
  assert.equal(twice.calls.length, 2, '取り直すのは 1 回だけ');
});

test('errorsAndLogs_neverContainServerMessageOrToken', async () => {
  const { rest } = setup([fsError(403, 'PERMISSION_DENIED', 'detail with ya29.token')]);
  const err = await rest.commit([]).catch((e) => e);
  const dump = JSON.stringify({ ...err, message: err.message }) + logs.join('\n');
  assert.doesNotMatch(dump, /detail|ya29|tok-/);
});

test('tokenFailure_isNotRetriedAsNetworkError', async () => {
  const calls = [];
  const tokens = { get: async () => { throw Object.assign(new Error('store_unavailable'), { status: 503, grpc: 'TOKEN' }); }, invalidate() {} };
  const rest = createRest({ projectId: 'p1', fetch: async () => { calls.push(1); }, tokens, sleep: async () => {} });
  await assert.rejects(rest.get('envs/a/data/spots'), (e) => e.grpc === 'TOKEN');
  assert.equal(calls.length, 0);
});

test('queryAll_pagesWithCursorAfterLastDocument_andStopsAtMaxDocs', async () => {
  const doc = (i) => ({ name: `${ROOT}/envs/a/eventBatches/${String(i).padStart(3, '0')}`, fields: { day: { stringValue: '2026-10-17' } } });
  const pages = [[doc(1), doc(2)], [doc(3), doc(4)], [doc(5)]];
  const { rest, calls } = setup(pages.map((p) => json(p.map((d) => ({ document: d })))));
  const q = { from: [{ collectionId: 'eventBatches' }], orderBy: [{ field: { fieldPath: 'day' }, direction: 'ASCENDING' }, { field: { fieldPath: '__name__' }, direction: 'ASCENDING' }] };
  const all = await rest.queryAll('envs/a', q, { pageSize: 2 });
  assert.deepEqual(all.documents.map((d) => d.name.slice(-3)), ['001', '002', '003', '004', '005']);
  assert.equal(all.truncated, false);
  assert.equal(calls[0].body.structuredQuery.startAt, undefined);
  assert.deepEqual(calls[1].body.structuredQuery.startAt, { values: [{ stringValue: '2026-10-17' }, { referenceValue: doc(2).name }], before: false });

  const capped = setup([json([doc(1), doc(2)].map((d) => ({ document: d }))), json([doc(3), doc(4)].map((d) => ({ document: d })))]);
  const some = await capped.rest.queryAll('envs/a', q, { pageSize: 2, maxDocs: 3 });
  assert.deepEqual(some.documents.length, 3);
  assert.equal(some.truncated, true);
  assert.equal(capped.calls[1].body.structuredQuery.limit, 2, '上限の 1 つ先まで読んで、続きがあるか確かめる');
});

test('commit_withoutRetryFlag_isNotRetried_butReadsAre', async () => {
  for (const bad of [() => fsError(503, 'UNAVAILABLE'), () => new TypeError('fetch failed')]) {
    const { rest, calls } = setup([bad()]);
    await assert.rejects(rest.commit([]), (e) => e.message === 'store_unavailable');
    assert.equal(calls.length, 1, '届いたか分からない書き込みはやり直さない');
  }
  const reads = setup([fsError(503, 'UNAVAILABLE'), json({ name: 'n', fields: {} })]);
  assert.ok(await reads.rest.get('envs/a/data/spots'));
  assert.equal(reads.calls.length, 2, '読み込みはやり直す');
  const auth = setup([fsError(401, 'UNAUTHENTICATED'), json({ ok: 1 })]);
  assert.deepEqual(await auth.rest.commit([]), { ok: 1 }, '401 は届いていないので取り直してやり直す');
});

test('queryAll_mapsEachPage_andStopsWhenResponsesGetTooLarge', async () => {
  const doc = (i) => ({ name: `${ROOT}/envs/a/c/${String(i).padStart(3, '0')}`, fields: { i: { integerValue: String(i) } } });
  const page = (a, b) => json([doc(a), doc(b)].map((d) => ({ document: d })));
  const { rest, calls } = setup([page(1, 2), page(3, 4), page(5, 6)]);
  const q = { from: [{ collectionId: 'c' }], orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }] };
  const one = JSON.stringify([doc(1), doc(2)].map((d) => ({ document: d }))).length;
  const r = await rest.queryAll('envs/a', q, { pageSize: 2, maxChars: one * 1.5, map: (d) => Number(d.fields.i.integerValue) });
  assert.deepEqual(r.documents, [1, 2, 3, 4], '上限を超えたページまでで止める');
  assert.equal(r.truncated, true);
  assert.equal(calls.length, 2);
});
