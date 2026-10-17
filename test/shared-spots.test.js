'use strict';
// Spot をお試し版と共有していて（SPOTS_NAMESPACE が STORE_NAMESPACE と違う）、合言葉が既定か短いときは、Spot は読むだけ
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./_helper');

h.setupEnv({ extraEnv: { STORE_BACKEND: 'memory', SPOTS_NAMESPACE: 'preview' } }); // 合言葉は TEST-PASS（短い）
let srv;
let G;
before(async () => {
  srv = await h.startServer();
  G = { 'X-Guide-Token': (await h.api(srv.base, 'POST', '/api/guide/login', { body: { passcode: 'TEST-PASS' } })).json.token };
});
after(async () => { await srv.close(); });

const GOOD = { name: { ja: '新しい場所' }, lat: 35.69, lng: 139.75 };

test('sharedSpots_withWeakPasscode_rejectAllSpotWrites', async () => {
  for (const [method, p, body] of [['PUT', '/api/spots', { spots: [{ ...GOOD, id: 'a' }] }], ['PUT', '/api/guide/spots/new-one', GOOD], ['DELETE', '/api/guide/spots/t1', undefined]]) {
    const r = await h.api(srv.base, method, p, { headers: G, body });
    assert.equal(r.status, 403, `${method} ${p}`);
    assert.deepEqual(r.json, { error: 'shared_spots_read_only' });
  }
  assert.deepEqual((await h.api(srv.base, 'GET', '/api/data/spots')).json.spots.map((s) => s.id), ['t1'], '変わっていない');
});

test('sharedSpots_writes_stillRequireGuideLogin', async () => {
  assert.equal((await h.api(srv.base, 'PUT', '/api/guide/spots/x', { body: GOOD })).status, 401);
});

test('sharedSpots_canStillBeRead', async () => {
  assert.equal((await h.api(srv.base, 'GET', '/api/data/spots')).status, 200);
});
