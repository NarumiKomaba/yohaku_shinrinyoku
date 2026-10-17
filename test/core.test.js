'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./_helper');

const dir = h.setupEnv();
let srv;
before(async () => { srv = await h.startServer(); });
after(async () => { await srv.close(); });

test('config_withoutKey_reportsLlmFalse', async () => {
  const r = await h.api(srv.base, 'GET', '/api/config');
  assert.equal(r.status, 200);
  assert.equal(r.json.llm, false);
});

test('config_byDefault_allowsPurchaseAndPublicDemo', async () => {
  const r = await h.api(srv.base, 'GET', '/api/config');
  assert.equal(r.json.purchaseEnabled, true);
  assert.equal(r.json.demoPublic, true);
});

test('purchase_thenSession_issuesTokenAndMarksUsed', async () => {
  const p = await h.api(srv.base, 'POST', '/api/purchase', { body: { plan: 'ai40', lang: 'en' } });
  assert.equal(p.status, 200);
  assert.match(p.json.code, /^KG-[0-9A-F]{6}$/);
  const s = await h.api(srv.base, 'POST', '/api/session', { body: { code: p.json.code.toLowerCase() } }); // 大文字小文字を問わない
  assert.equal(s.status, 200);
  assert.ok(s.json.token && s.json.sessionId);
  const purchases = JSON.parse(fs.readFileSync(path.join(dir, 'logs', 'purchases.json'), 'utf8'));
  assert.ok(purchases[p.json.code].usedAt);
  assert.equal(purchases[p.json.code].lang, 'en');
});

test('session_withDemoCode_succeeds', async () => {
  const s = await h.api(srv.base, 'POST', '/api/session', { body: { code: ' demo2027 ' } });
  assert.equal(s.status, 200);
});

for (const [name, body] of [['unknownCode', { code: 'NOPE' }], ['emptyCode', { code: '' }], ['missingCode', {}], ['nonStringCode', { code: 123 }]]) {
  test(`session_with_${name}_returns403`, async () => {
    const s = await h.api(srv.base, 'POST', '/api/session', { body });
    assert.equal(s.status, 403);
    assert.equal(s.json.error, 'invalid_code');
  });
}

test('session_withInvalidJson_returns400', async () => {
  const res = await h.realFetch(srv.base + '/api/session', { method: 'POST', body: '{bad' });
  assert.equal(res.status, 400);
});

test('events_withoutSession_returns401', async () => {
  const r = await h.api(srv.base, 'POST', '/api/events', { body: { events: [{ type: 'x' }] } });
  assert.equal(r.status, 401);
});

test('events_withSession_appendsWithSessionIdAndCapsAt200', async () => {
  const s = await h.newSession(srv.base);
  const events = Array.from({ length: 250 }, (_, i) => ({ type: 'tts', chars: i, sessionId: 'spoofed' }));
  const r = await h.api(srv.base, 'POST', '/api/events', { body: { events }, headers: s.headers });
  assert.equal(r.status, 200);
  const mine = h.readEvents(dir).filter((e) => e.type === 'tts' && e.sessionId === s.sessionId);
  assert.equal(mine.length, 200);
  assert.ok(mine.every((e) => e.sessionId === s.sessionId), 'クライアントが sessionId を偽装できない');
  assert.ok(mine.every((e) => e.ts));
});

test('guideLogin_withCorrectPasscode_returnsToken', async () => {
  const r = await h.api(srv.base, 'POST', '/api/guide/login', { body: { passcode: 'TEST-PASS' } });
  assert.equal(r.status, 200);
  assert.ok(r.json.token);
});

for (const [name, body] of [['wrong', { passcode: 'WRONG-PASS' }], ['empty', { passcode: '' }], ['missing', {}], ['shorter', { passcode: 'TEST' }]]) {
  test(`guideLogin_with_${name}Passcode_returns403`, async () => {
    const r = await h.api(srv.base, 'POST', '/api/guide/login', { body });
    assert.equal(r.status, 403);
  });
}

test('stats_withoutGuideToken_returns401', async () => {
  assert.equal((await h.api(srv.base, 'GET', '/api/stats')).status, 401);
  assert.equal((await h.api(srv.base, 'GET', '/api/stats', { headers: { 'X-Guide-Token': 'bogus' } })).status, 401);
});

test('stats_withSessionTokenAsGuideToken_returns401', async () => {
  const s = await h.newSession(srv.base);
  assert.equal((await h.api(srv.base, 'GET', '/api/stats', { headers: { 'X-Guide-Token': s.token } })).status, 401);
});

test('stats_withGuideToken_returnsAggregates', async () => {
  const s = await h.newSession(srv.base);
  await h.api(srv.base, 'POST', '/api/events', { headers: s.headers, body: { events: [
    { type: 'session_start', lang: 'ja', mode: 'ai' }, { type: 'session_complete', durationSec: 600 },
    { type: 'llm_usage', purpose: 'narrate', inputTokens: 10, outputTokens: 5, costJpy: 1e9 },
  ] } });
  const { json: { token } } = await h.api(srv.base, 'POST', '/api/guide/login', { body: { passcode: 'TEST-PASS' } });
  const r = await h.api(srv.base, 'GET', '/api/stats', { headers: { 'X-Guide-Token': token } });
  assert.equal(r.status, 200);
  assert.ok(r.json.funnel.started >= 1);
  assert.ok(r.json.funnel.completed >= 1);
  assert.ok(r.json.usage.totalCostJpy < 1e9, 'クライアントが送った llm_usage は集計に入らない');
});

test('data_withWhitelistedNames_returnsJson', async () => {
  for (const n of ['spots', 'scenario', 'knowledge']) {
    const r = await h.api(srv.base, 'GET', `/api/data/${n}`);
    assert.equal(r.status, 200, n);
    assert.equal(typeof r.json, 'object');
  }
  const spots = (await h.api(srv.base, 'GET', '/api/data/spots')).json;
  assert.equal(spots.spots[0].id, 't1', 'DATA_DIR の一時コピーを読んでいる');
});

test('data_withNonWhitelistedNames_returns404', async () => {
  for (const n of ['purchases', 'events', 'spots.json', '..%2Fserver.js']) {
    const r = await h.api(srv.base, 'GET', `/api/data/${n}`);
    assert.equal(r.status, 404, `${n} -> ${r.status}`);
  }
});

// 本体バグ(再現中): DATA_FILES[params.name] が Object.prototype を拾い 500 になる
test('data_withPrototypePropertyNames_returns404', async () => {
  for (const n of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const r = await h.api(srv.base, 'GET', `/api/data/${n}`);
    assert.equal(r.status, 404, `${n} -> ${r.status}`);
  }
});

test('static_root_servesIndexHtml', async () => {
  const r = await h.rawGet(srv.port, '/');
  assert.equal(r.status, 200);
  assert.match(r.text, /<html/i);
});

test('static_missingFile_returns404', async () => {
  assert.equal((await h.rawGet(srv.port, '/nope.html')).status, 404);
});

test('static_pathTraversal_isRejected', async () => {
  for (const p of ['/..%2Fserver.js', '/..%2flib%2fconfig.js', '/..%2Fdata%2Fspots.json', '/%2e%2e%2fserver.js', '/..%5Cserver.js', '/js/..%2F..%2Fserver.js']) {
    const r = await h.rawGet(srv.port, p);
    assert.ok([403, 404].includes(r.status), `${p} -> ${r.status}`);
    assert.doesNotMatch(r.text, /require\(|GUIDE_PASSCODE/, `${p} leaked source`);
  }
  const r = await h.rawGet(srv.port, '/../server.js');
  assert.doesNotMatch(r.text, /require\(/);
});

test('static_malformedPercentEncoding_doesNotCrashServer', async () => {
  const r = await h.rawGet(srv.port, '/%E0%A4%A');
  assert.ok(r.status >= 400 && r.status < 600);
  assert.equal((await h.api(srv.base, 'GET', '/api/config')).status, 200, 'サーバーは生きている');
});

test('unknownApi_returns404Json', async () => {
  const r = await h.api(srv.base, 'GET', '/api/nothing');
  assert.equal(r.status, 404);
});
