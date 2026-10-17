// Firestore REST（v1）の最小限: commit・batchWrite・get・runQuery。外部ライブラリなし（fetch だけ）。
// 失敗はすべて Error('store_unavailable')（status 503、upstreamStatus と gRPC のコード名だけを持つ）。
// ログは `[store] commit 503 UNAVAILABLE` 程度にして、応答の本文・書いた中身・トークンは出さない。
// 読み込み（get・runQuery）は失敗したらやり直す。書き込み（commit・batchWrite）は、届いたかどうか分からないまま
// やり直すと結果が変わりうるので、呼び出し側が「やり直しても大丈夫」（{ retry: true }）と言ったときだけやり直す
'use strict';

const { storeUnavailable } = require('../store/common');

const API = 'https://firestore.googleapis.com/v1/';
const TIMEOUT_MS = 5000;
const RETRY_DELAYS_MS = [200, 600];
const RETRY_STATUS = new Set([429, 500, 503]);
const RETRY_GRPC = new Set(['ABORTED', 'UNAVAILABLE']);
// 呼び出し側が結果として扱う（条件の不一致・重なり・ないもの）ので、ログに出さない
const EXPECTED_GRPC = new Set(['FAILED_PRECONDITION', 'ALREADY_EXISTS', 'NOT_FOUND']);
const PAGE_SIZE = 100;
const MAX_QUERY_CHARS = 50_000_000; // queryAll で読む応答の合計の文字数（メモリを使い切らない）

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// エラー応答（{ error: { status } } か、runQuery ではその配列）から gRPC のコード名だけを取り出す
async function grpcOf(res) {
  try {
    const body = await res.json();
    const err = (Array.isArray(body) ? body[0] : body).error;
    return typeof err.status === 'string' ? err.status : '';
  } catch {
    return '';
  }
}

function createRest({ projectId, database = '(default)', fetch = globalThis.fetch, tokens, userProject = '', timeoutMs = TIMEOUT_MS, retryDelays = RETRY_DELAYS_MS, sleep = wait }) {
  const root = `projects/${projectId}/databases/${database}/documents`;
  const docName = (path) => `${root}/${path}`;

  async function send(method, url, body, token) {
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(userProject ? { 'x-goog-user-project': userProject } : {}) };
    return fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  }

  // 応答の本文（JSON）とその文字数。retry: false なら、通信エラー・5xx でもやり直さない（401 の取り直しは届いていないのでやり直す）
  async function callRaw(op, method, url, body, { retry = true } = {}) {
    let refreshed = false;
    let retries = 0;
    for (;;) {
      const token = await tokens.get(); // 取れなければ store_unavailable（token.js がログを出す）
      let res;
      try {
        res = await send(method, url, body, token);
      } catch {
        // 通信エラー・タイムアウト
        if (retry && retries < retryDelays.length) { await sleep(retryDelays[retries++]); continue; }
        console.error(`[store] ${op} network error`);
        throw storeUnavailable(0, 'NETWORK');
      }
      if (res.ok) {
        const text = await res.text();
        return { body: JSON.parse(text), chars: text.length };
      }
      const grpc = await grpcOf(res);
      if (res.status === 401 && !refreshed) { refreshed = true; tokens.invalidate(); continue; }
      if (retry && (RETRY_STATUS.has(res.status) || RETRY_GRPC.has(grpc)) && retries < retryDelays.length) { await sleep(retryDelays[retries++]); continue; }
      if (!EXPECTED_GRPC.has(grpc)) console.error(`[store] ${op} ${res.status} ${grpc}`);
      throw storeUnavailable(res.status, grpc);
    }
  }

  const call = async (...args) => (await callRaw(...args)).body;

  /**
   * 書き込みをまとめて 1 回で（全部成功か全部失敗）。条件（currentDocument）が合わなければ FAILED_PRECONDITION・ALREADY_EXISTS など。
   * retry: true は、やり直して「もう書けていた」結果（ALREADY_EXISTS・FAILED_PRECONDITION）になっても呼び出し側が扱えるときだけ
   */
  const commit = (writes, { retry = false } = {}) => call('commit', 'POST', `${API}${root}:commit`, { writes }, { retry });

  /** 書き込みを 1 つずつ（移行用）。結果の status[i].code が 0 以外なら、その書き込みは失敗 */
  const batchWrite = (writes, { retry = false } = {}) => call('batchWrite', 'POST', `${API}${root}:batchWrite`, { writes }, { retry });

  /** ドキュメント 1 つ。なければ null */
  async function get(path) {
    try {
      return await call('get', 'GET', `${API}${docName(path)}`);
    } catch (e) {
      if (e.grpc === 'NOT_FOUND') return null;
      throw e;
    }
  }

  async function runQueryRaw(parentPath, structuredQuery) {
    const parent = parentPath ? docName(parentPath) : root;
    const { body, chars } = await callRaw('runQuery', 'POST', `${API}${parent}:runQuery`, { structuredQuery });
    return { documents: (Array.isArray(body) ? body : []).filter((r) => r && r.document).map((r) => r.document), chars };
  }

  /** parentPath の下のコレクションを検索する（'' は一番上）。返すのはドキュメントだけ */
  const runQuery = async (parentPath, structuredQuery) => (await runQueryRaw(parentPath, structuredQuery)).documents;

  /**
   * pageSize 件ずつ、最後のドキュメントの次から読む（orderBy の最後は __name__ にしておく）。読んだページはすぐ map で変換する（dataOf など）。
   * maxDocs を超える分・応答の合計が maxChars 文字を超えたあとは読まず truncated: true（続きがあるかは 1 件先まで読んで確かめる）
   */
  async function queryAll(parentPath, structuredQuery, { pageSize = PAGE_SIZE, maxDocs = Infinity, maxChars = MAX_QUERY_CHARS, map = (d) => d } = {}) {
    const orderBy = structuredQuery.orderBy || [];
    let documents = [];
    let chars = 0;
    let startAt;
    for (;;) {
      const limit = Math.min(pageSize, maxDocs - documents.length + 1);
      const res = await runQueryRaw(parentPath, { ...structuredQuery, limit, ...(startAt ? { startAt } : {}) });
      const page = res.documents;
      chars += res.chars;
      documents = [...documents, ...page.map(map)];
      if (documents.length > maxDocs) return { documents: documents.slice(0, maxDocs), truncated: true };
      if (page.length < limit) return { documents, truncated: false };
      if (chars > maxChars) return { documents, truncated: true };
      const last = page[page.length - 1];
      const at = (o) => (o.field.fieldPath === '__name__' ? { referenceValue: last.name } : (last.fields || {})[o.field.fieldPath] || { nullValue: 'NULL_VALUE' });
      startAt = { values: orderBy.map(at), before: false };
    }
  }

  /** 先にトークンを取っておく */
  const warmUp = () => tokens.get();

  return { docName, commit, batchWrite, get, runQuery, queryAll, warmUp };
}

module.exports = { createRest };
