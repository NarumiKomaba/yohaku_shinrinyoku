'use strict';
// 公開に向けた守り: 総当たりの制限、デモコードの 1 日の上限、セッションの期限、イベントの受け付け、エラーの中身、ヘッダー
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./_helper');

const dir = h.setupEnv({ extraEnv: { DEMO_CODES: 'YK-HARDEN1', SESSIONS_PER_CODE_DAILY: '3' } });
let srv;
before(async () => { srv = await h.startServer(); });
after(async () => { await srv.close(); });

const session = (code) => h.api(srv.base, 'POST', '/api/session', { body: { code } });
const login = (passcode) => h.api(srv.base, 'POST', '/api/guide/login', { body: { passcode } });
const { createSession } = require('../lib/auth');
const sessionHeaders = () => ({ 'X-Session-Token': createSession('YK-HARDEN1').token });

test('securityHeaders_onPagesAndApi_areSet', async () => {
  for (const p of ['/', '/api/config']) {
    const res = await h.realFetch(srv.base + p);
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /default-src 'self'/, p);
    assert.match(csp, /frame-ancestors 'none'/, p);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', p);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', p);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer', p);
  }
});

test('htmlPages_haveNoInlineScript', () => {
  for (const f of ['index.html', 'guide.html', 'admin.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, `${f}: CSP でインラインのスクリプトは動かない`);
  }
});

test('demoCode_overDailyLimit_returns429', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await session('YK-HARDEN1')).status, 200);
  const r = await session('YK-HARDEN1');
  assert.equal(r.status, 429);
  assert.equal(r.json.error, 'code_daily_limit');
});

test('guideToken_afterTtl_isRejected', async () => {
  const realNow = Date.now;
  const s = await login('TEST-PASS');
  const guide = { 'X-Guide-Token': s.json.token };
  assert.equal((await h.api(srv.base, 'GET', '/api/stats', { headers: guide })).status, 200);
  try {
    Date.now = () => realNow() + 9 * 3600 * 1000; // ガイドの期限（8 時間）を過ぎた
    assert.equal((await h.api(srv.base, 'GET', '/api/stats', { headers: guide })).status, 401);
  } finally {
    Date.now = realNow;
  }
});

test('session_afterTtl_isRejected', async () => {
  const realNow = Date.now;
  const headers = sessionHeaders();
  const ev = () => h.api(srv.base, 'POST', '/api/events', { headers, body: { events: [] } });
  assert.equal((await ev()).status, 200);
  try {
    Date.now = () => realNow() + 25 * 3600 * 1000; // 体験者の期限（24 時間）を過ぎた
    assert.equal((await ev()).status, 401);
  } finally {
    Date.now = realNow;
  }
});

test('events_fromClient_onlyAllowedTypesAndCleanedFields', async () => {
  const { token, sessionId } = createSession('YK-HARDEN1');
  const long = 'x'.repeat(1000);
  const r = await h.api(srv.base, 'POST', '/api/events', { headers: { 'X-Session-Token': token }, body: { events: [
    { type: 'llm_usage', costJpy: 1e9 }, { type: 'purchase', demoCode: true }, { type: 'made_up' }, 'not-an-object',
    { type: 'reflection', noticed: long, nested: { a: 1 }, next: ['a', { b: 1 }, 'c'] },
  ] } });
  assert.equal(r.status, 200);
  assert.equal(r.json.accepted, 1);
  const mine = h.readEvents(dir).filter((e) => e.sessionId === sessionId);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].type, 'reflection');
  assert.equal(mine[0].noticed.length, 200, '文字列は 200 字まで');
  assert.ok(!('nested' in mine[0]), '入れ子のオブジェクトは捨てる');
  assert.deepEqual(mine[0].next, ['a', 'c']);
});

test('events_overSessionCap_areNotAccepted', async () => {
  const headers = sessionHeaders();
  const batch = Array.from({ length: 200 }, () => ({ type: 'tts', chars: 1 }));
  let total = 0;
  for (let i = 0; i < 3; i++) total += (await h.api(srv.base, 'POST', '/api/events', { headers, body: { events: batch } })).json.accepted;
  assert.equal(total, 300, '1 セッションで受け付けるのは 300 件まで');
});

test('events_withHugeBody_isRejected', async () => {
  // 上限を超えた時点で接続を切るので、413 が届く前に切断されることもある
  const r = await h.api(srv.base, 'POST', '/api/events', { headers: sessionHeaders(), body: { events: [{ type: 'tts', pad: 'x'.repeat(70_000) }] } })
    .catch((e) => ({ status: 'reset', error: e }));
  assert.ok(r.status === 413 || r.status === 'reset', String(r.status));
  assert.equal(h.readEvents(dir).filter((e) => e.pad).length, 0);
});

test('unexpectedError_returnsGenericInternalError', async () => {
  const file = path.join(dir, 'spots.json');
  const saved = fs.readFileSync(file);
  fs.unlinkSync(file);
  try {
    const r = await h.api(srv.base, 'GET', '/api/data/spots');
    assert.equal(r.status, 500);
    assert.deepEqual(r.json, { error: 'internal_error' }, 'ファイルのパスなどを返さない');
  } finally {
    fs.writeFileSync(file, saved);
  }
});

// 総当たりの制限は最後に試す（同じ IP からの失敗が数えられ、以後のログインが止まるため）
test('session_afterTenFailures_returns429EvenForValidCode', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await session(`WRONG-${i}`)).status, 403);
  const r = await session('YK-HARDEN1');
  assert.equal(r.status, 429);
  assert.equal(r.json.error, 'too_many_attempts');
});

test('guideLogin_afterTenFailures_returns429EvenForCorrectPasscode', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await login(`WRONG-${i}`)).status, 403);
  const r = await login('TEST-PASS');
  assert.equal(r.status, 429);
});

test('csp_allowsOnlyTheLeafletPathOnUnpkg', async () => {
  const csp = (await h.realFetch(srv.base + '/')).headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' https:\/\/unpkg\.com\/leaflet@1\.9\.4\//);
  assert.doesNotMatch(csp, /https:\/\/unpkg\.com(?!\/leaflet@1\.9\.4\/)/, 'unpkg 全体は許さない');
});

test('leafletTags_haveSubresourceIntegrity', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
  for (const tag of read('guide.html').match(/<(?:link|script)[^>]*unpkg\.com[^>]*>/g)) {
    assert.match(tag, /integrity="sha256-[A-Za-z0-9+/=]+"/, tag);
    assert.match(tag, /crossorigin="anonymous"/, tag);
  }
  const sim = read('js/sim.js');
  assert.match(sim, /css\.integrity = LEAFLET_SRI\.css/);
  assert.match(sim, /js\.integrity = LEAFLET_SRI\.js/);
});
