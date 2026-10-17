'use strict';
// お試し版の設定（購入停止・非公開のデモコード）。設定は require 時に読むので、別ファイル（別プロセス）で検証する
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./_helper');

h.setupEnv({ extraEnv: { PURCHASE_ENABLED: '0', DEMO_CODES: 'yk-test1, YK-TEST2' } });
let srv;
before(async () => { srv = await h.startServer(); });
after(async () => { await srv.close(); });

test('config_whenLocked_reportsPurchaseDisabledAndDemoPrivate', async () => {
  const r = await h.api(srv.base, 'GET', '/api/config');
  assert.equal(r.status, 200);
  assert.equal(r.json.purchaseEnabled, false);
  assert.equal(r.json.demoPublic, false);
});

test('purchase_whenDisabled_returns403', async () => {
  const r = await h.api(srv.base, 'POST', '/api/purchase', { body: { plan: 'ai40', lang: 'ja' } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'purchase_disabled');
});

test('session_withDefaultDemoCode_returns403WhenCodesChanged', async () => {
  const r = await h.api(srv.base, 'POST', '/api/session', { body: { code: 'DEMO2027' } });
  assert.equal(r.status, 403);
});

for (const code of ['YK-TEST1', ' yk-test2 ']) {
  test(`session_withConfiguredDemoCode_${code.trim()}_succeeds`, async () => {
    const r = await h.api(srv.base, 'POST', '/api/session', { body: { code } });
    assert.equal(r.status, 200);
    assert.ok(r.json.token);
  });
}

test('session_withEmptyCode_returns403EvenWithCommaSeparatedCodes', async () => {
  const r = await h.api(srv.base, 'POST', '/api/session', { body: { code: '' } });
  assert.equal(r.status, 403);
});
