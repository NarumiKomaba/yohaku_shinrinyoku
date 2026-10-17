'use strict';
// 1 つの接続元（IPv4 はアドレス、IPv6 は /64）で 1 日に始められる体験の数（SESSIONS_PER_IP_DAILY）
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./_helper');

h.setupEnv({ extraEnv: { DEMO_CODES: 'YK-IPLIMIT1,YK-IPLIMIT2', SESSIONS_PER_IP_DAILY: '3' } });
let srv;
before(async () => { srv = await h.startServer(); });
after(async () => { await srv.close(); });

test('session_perIpDailyLimit_countsAcrossCodes_andReturns429', async () => {
  const start = (code) => h.api(srv.base, 'POST', '/api/session', { body: { code } });
  const statuses = [];
  for (const code of ['YK-IPLIMIT1', 'YK-IPLIMIT2', 'YK-IPLIMIT1', 'YK-IPLIMIT2']) statuses.push((await start(code)).status);
  assert.deepEqual(statuses, [200, 200, 200, 429], 'コードを変えても、同じ接続元は 1 日 3 回まで');
  assert.equal((await start('YK-IPLIMIT1')).json.error, 'ip_daily_limit');
});
