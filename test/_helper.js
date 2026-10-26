'use strict';
// テスト共通: 一時 DATA_DIR の用意、サーバー起動、HTTP ヘルパー。
// 各テストファイルは別プロセスで実行されるため、require 前に env を設定できる。
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');

// 決定的なテスト用 Spot（素材: must/fact/sense と別言語）
const TEST_SPOTS = {
  version: 2,
  spots: [{
    id: 't1', order: 1, enabled: true, name: { ja: 'テスト', en: 'Test' }, kind: 'trees', lat: 35.68, lng: 139.756, radius: 40,
    materials: [
      { id: 't1-sense', type: 'sense', lang: 'ja', text: '風の音を聞いてみましょう。' },
      { id: 't1-fact', type: 'fact', lang: 'ja', text: '一つ目の事実です。二つ目の事実です。三つ目の事実です。四つ目の事実です。' },
      { id: 't1-must', type: 'must', lang: 'ja', text: '足元に注意してください。' },
      { id: 't1-en', type: 'must', lang: 'en', text: 'Watch your step.' },
    ],
    interactions: [],
  }],
};

// 開発者のシェルに入っていても、テストでは使わない設定（production-config.test.js でも使う）
const CLEARED_ENV = ['GEMINI_SERVICE_ACCOUNT_JSON', 'GEMINI_VERTEX_PROJECT', 'GEMINI_VERTEX_LOCATION', 'NODE_ENV', 'K_SERVICE', 'DEMO_CODES', 'PURCHASE_ENABLED', 'LLM_DAILY_MAX', 'SESSIONS_PER_CODE_DAILY', 'SESSIONS_PER_IP_DAILY', 'TRUSTED_PROXY_HOPS',
  'NARRATE_MAX_PER_SESSION', 'ASK_MAX_PER_SESSION', 'WALK_CALLS_PER_MIN', 'WALK_CALLS_PER_DAY', 'EVENTS_DAILY_BYTES', 'EVENTS_DAILY_WRITES',
  'FIRESTORE_PROJECT_ID', 'FIRESTORE_DATABASE', 'STORE_NAMESPACE', 'SPOTS_NAMESPACE', 'FIRESTORE_AUTH', 'GCLOUD_CONFIG',
  'STATS_MAX_DOCS', 'STATS_CACHE_SEC', 'SPOTS_CACHE_SEC', 'SHINRINYOKU_PREVIEW_ENV'];

function setupEnv({ key = '', extraEnv = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-test-'));
  for (const f of ['scenario.json', 'knowledge.json']) fs.copyFileSync(path.join(ROOT, 'data', f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'spots.json'), JSON.stringify(TEST_SPOTS));
  process.env.DATA_DIR = dir;
  process.env.GEMINI_API_KEY = key; // 空文字 = キー無し扱い（実 Gemini を呼ばない）
  process.env.GUIDE_PASSCODE = 'TEST-PASS';
  // テストはファイル版で記録する（Firestore にはつながない）
  process.env.STORE_BACKEND = 'file';
  // 開発者のシェルの設定（公開用の設定など）でテストの結果が変わらないよう、既定値に戻す
  for (const k of [...CLEARED_ENV, 'GEMINI_MODEL']) delete process.env[k];
  process.env.STATS_CACHE_SEC = '0'; // 集計を使い回さない（テストは直前に書いたイベントを見る）
  Object.assign(process.env, extraEnv);
  return dir;
}

async function startServer() {
  const { server } = require('../server.js');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

// fetch は globalThis.fetch を後から差し替えるテストがあるため、起動時に本物を保持する
const realFetch = globalThis.fetch;
async function api(base, method, p, { body, headers = {} } = {}) {
  const res = await realFetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, json, text };
}

// URL 正規化を避けるため生の path を送る
function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => resolve({ status: res.statusCode, text: t }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function newSession(base) {
  const r = await api(base, 'POST', '/api/session', { body: { code: 'DEMO2027' } });
  return { token: r.json.token, sessionId: r.json.sessionId, headers: { 'X-Session-Token': r.json.token } };
}

function readEvents(dir) {
  const f = path.join(dir, 'logs', 'events.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// googleapis 宛だけをスタブする。handler(callIndex, body) => text(文字列) | Error
function stubGemini(handler) {
  const state = { calls: 0, bodies: [] };
  globalThis.fetch = async (url, opts) => {
    if (!/googleapis\.com/.test(String(url))) return realFetch(url, opts);
    state.calls++;
    const body = JSON.parse(opts.body);
    state.bodies.push(body);
    const out = handler(state.calls, body);
    if (out instanceof Error) throw out;
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: out }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return state;
}

// 保存先の関数を、指定したもの（true なら全部）だけ store_unavailable で失敗させる（createStore(backend) に渡して使う）
function withFaults(backend) {
  const { storeUnavailable } = require('../lib/store/common');
  let fault = null;
  const wrap = ([name, fn]) => [name, (...args) => (fault === true || fault === name ? Promise.reject(storeUnavailable(503, 'UNAVAILABLE')) : fn(...args))];
  return { backend: Object.fromEntries(Object.entries(backend).map(wrap)), setFault: (name) => { fault = name; } };
}

// 本物の gcloud の代わりに、呼ばれた印（called.txt）を残して偽のトークンを返す gcloud だけがある PATH（起動したサーバーが先にトークンを取るため）
function fakeGcloud() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-gcloud-'));
  if (process.platform === 'win32') fs.writeFileSync(path.join(dir, 'gcloud.cmd'), ['@echo off', 'echo called> "%~dp0called.txt"', 'echo fake-token', ''].join('\r\n'));
  else fs.writeFileSync(path.join(dir, 'gcloud'), ['#!/bin/sh', 'echo called > "${0%/*}/called.txt"', 'echo fake-token', ''].join('\n'), { mode: 0o755 });
  // Windows では Path と PATH が別のキーになりうるので、どちらも消してから入れる
  const envWith = (env) => ({ ...Object.fromEntries(Object.entries(env).filter(([k]) => k.toUpperCase() !== 'PATH')), PATH: dir });
  return { envWith, calledFile: path.join(dir, 'called.txt') };
}

module.exports = { CLEARED_ENV, withFaults, fakeGcloud, setupEnv, startServer, api, rawGet, newSession, readEvents, stubGemini, realFetch, TEST_SPOTS };
