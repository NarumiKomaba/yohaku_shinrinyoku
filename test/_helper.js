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

function setupEnv({ key = '', extraEnv = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-test-'));
  for (const f of ['scenario.json', 'knowledge.json']) fs.copyFileSync(path.join(ROOT, 'data', f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'spots.json'), JSON.stringify(TEST_SPOTS));
  process.env.DATA_DIR = dir;
  process.env.GEMINI_API_KEY = key; // 空文字 = キー無し扱い（実 Gemini を呼ばない）
  process.env.GUIDE_PASSCODE = 'TEST-PASS';
  // 開発者のシェルの設定（公開用の設定など）でテストの結果が変わらないよう、既定値に戻す
  for (const k of ['NODE_ENV', 'DEMO_CODES', 'PURCHASE_ENABLED', 'LLM_DAILY_MAX', 'SESSIONS_PER_CODE_DAILY', 'TRUSTED_PROXY_HOPS', 'NARRATE_MAX_PER_SESSION']) delete process.env[k];
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

module.exports = { setupEnv, startServer, api, rawGet, newSession, readEvents, stubGemini, realFetch, TEST_SPOTS };
