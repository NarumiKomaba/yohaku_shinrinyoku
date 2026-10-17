'use strict';
// ループバック（127.0.0.1）で待ち受けているときは、Host がループバックの名前でないリクエストを 421 で断る（DNS リバインディング・LAN 対策）
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const h = require('./_helper');

h.setupEnv();
let srv;
before(async () => { srv = await h.startServer(); });
after(async () => { await srv.close(); });

function getWithHost(host, p = '/api/config') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: p, method: 'GET', headers: { Host: host } }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: t }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('hostHeader_loopbackNames_areAccepted', async () => {
  for (const host of [`127.0.0.1:${srv.port}`, `localhost:${srv.port}`, 'localhost', `[::1]:${srv.port}`, 'LOCALHOST']) {
    assert.equal((await getWithHost(host)).status, 200, host);
  }
});

test('hostHeader_otherNames_areRejectedWith421', async () => {
  for (const host of ['evil.example', `evil.example:${srv.port}`, '192.168.1.10:3000', 'localhost.evil.example', '127.0.0.1.nip.io']) {
    const r = await getWithHost(host);
    assert.equal(r.status, 421, host);
    assert.deepEqual(JSON.parse(r.text), { error: 'misdirected' });
  }
  assert.equal((await getWithHost('evil.example', '/')).status, 421, 'ページも断る');
});
