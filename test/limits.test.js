'use strict';
// lib/limits.js（接続元 IP・失敗回数の制限・1 日ごとの回数）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clientIp, ipBucket, createFailureLimiter, createWindowCounter, createDailyCounter, capSize } = require('../lib/limits');

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

test('ipBucket_groupsIpv6By64_andKeepsIpv4', () => {
  assert.equal(ipBucket('1.2.3.4'), '1.2.3.4');
  assert.equal(ipBucket('::ffff:1.2.3.4'), '1.2.3.4', 'IPv4 射影アドレスは IPv4 として数える');
  assert.equal(ipBucket('2001:db8:abcd:12::1'), ipBucket('2001:0db8:abcd:0012:ffff::9'), '同じ /64 は同じ単位');
  assert.notEqual(ipBucket('2001:db8:abcd:12::1'), ipBucket('2001:db8:abcd:13::1'));
  assert.equal(ipBucket('2001:db8::'), '2001:db8:0:0::/64');
});

test('failureLimiter_globalCap_blocksEveryoneAfterManyFailures', () => {
  let t = 0;
  const lim = createFailureLimiter({ max: 100, globalMax: 3, windowMs: 1000, now: () => t });
  for (const k of ['a', 'b', 'c']) lim.fail(k);
  assert.throws(() => lim.check('d'), (e) => e.status === 429, '全体の上限で、別の接続元も止まる');
  t = 1001;
  lim.check('d');
});

test('windowCounter_limitsPerWindow_andZeroMeansUnlimited', () => {
  let t = 0;
  const c = createWindowCounter({ max: 2, windowMs: 1000, now: () => t });
  assert.equal(c.take('s'), true);
  assert.equal(c.take('s'), true);
  assert.equal(c.take('s'), false);
  assert.equal(c.take('other'), true);
  t = 1001;
  assert.equal(c.take('s'), true);
  const free = createWindowCounter({ max: 0 });
  for (let i = 0; i < 100; i++) assert.equal(free.take('s'), true);
});
