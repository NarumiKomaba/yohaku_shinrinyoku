'use strict';
// lib/limits.js（接続元 IP・失敗回数の制限・1 日ごとの回数）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clientIp, createFailureLimiter, createDailyCounter, capSize } = require('../lib/limits');

const req = (xff, remote = '10.0.0.1') => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: remote } });

test('clientIp_withoutTrustedProxy_ignoresForwardedHeader', () => {
  assert.equal(clientIp(req('1.2.3.4'), 0), '10.0.0.1');
});

test('clientIp_withOneTrustedHop_usesRightmostNotSpoofableLeftmost', () => {
  assert.equal(clientIp(req('6.6.6.6, 1.2.3.4'), 1), '1.2.3.4');
  assert.equal(clientIp(req('1.2.3.4'), 1), '1.2.3.4');
  assert.equal(clientIp(req(undefined), 1), '10.0.0.1', 'ヘッダーが無ければ接続元');
});

test('failureLimiter_blocksAfterMaxAndRecoversAfterWindow', () => {
  let t = 0;
  const lim = createFailureLimiter({ max: 2, windowMs: 1000, now: () => t });
  lim.check('a');
  lim.fail('a');
  lim.fail('a');
  assert.throws(() => lim.check('a'), (e) => e.status === 429);
  lim.check('b');
  t = 1001;
  lim.check('a');
});

test('dailyCounter_capsPerKeyAndResetsAtJstMidnight', () => {
  let t = Date.parse('2026-10-17T14:59:00Z');
  const c = createDailyCounter({ max: 2, now: () => t });
  assert.equal(c.take('x'), true);
  assert.equal(c.take('x'), true);
  assert.equal(c.take('x'), false);
  assert.equal(c.take('y'), true);
  t = Date.parse('2026-10-17T15:00:00Z');
  assert.equal(c.take('x'), true);
});

test('dailyCounter_withZeroMax_isUnlimited', () => {
  const c = createDailyCounter({ max: 0 });
  for (let i = 0; i < 50; i++) assert.equal(c.take('x'), true);
});

test('capSize_dropsOldestEntries', () => {
  const m = new Map([['a', 1], ['b', 2], ['c', 3]]);
  capSize(m, 3);
  assert.deepEqual([...m.keys()], ['b', 'c']);
});
