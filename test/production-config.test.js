'use strict';
// 公開（NODE_ENV=production）の設定: 足りなければ起動しない、購入は既定で止める、合言葉をログに出さない
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PASSCODE = 'test-passcode-0123456789';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-prod-'));

// 開発者のシェルの設定に左右されないよう、関係する環境変数は消してから渡す
function env(extra) {
  const base = { ...process.env, DATA_DIR: dataDir, GEMINI_API_KEY: '', PORT: '0' };
  for (const k of ['NODE_ENV', 'GUIDE_PASSCODE', 'DEMO_CODES', 'PURCHASE_ENABLED', 'LLM_DAILY_MAX', 'SESSIONS_PER_CODE_DAILY', 'TRUSTED_PROXY_HOPS', 'HOST']) delete base[k];
  return { ...base, ...extra };
}
const configValue = (extra, expr) => spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(${expr}))`], { cwd: ROOT, env: env(extra), encoding: 'utf8' });
const runServer = (extra) => spawnSync(process.execPath, ['server.js'], { cwd: ROOT, env: env(extra), encoding: 'utf8', timeout: 10_000 });

for (const [name, extra, pattern] of [
  ['missingPasscode', { DEMO_CODES: 'YK-TESTCODE1' }, /GUIDE_PASSCODE/],
  ['shortPasscode', { DEMO_CODES: 'YK-TESTCODE1', GUIDE_PASSCODE: 'short' }, /GUIDE_PASSCODE/],
  ['missingDemoCodes', { GUIDE_PASSCODE: PASSCODE }, /DEMO_CODES を設定/],
  ['defaultDemoCode', { GUIDE_PASSCODE: PASSCODE, DEMO_CODES: 'YK-TESTCODE1,DEMO2027' }, /DEMO2027/],
  ['shortDemoCode', { GUIDE_PASSCODE: PASSCODE, DEMO_CODES: 'ABC' }, /8 文字以上/],
]) {
  test(`production_with_${name}_refusesToStart`, () => {
    const r = runServer({ NODE_ENV: 'production', ...extra });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, pattern);
    assert.doesNotMatch(r.stderr + r.stdout, /short|test-passcode/, '合言葉の値はログに出さない');
  });
}

test('production_withValidConfig_startsWithoutPrintingSecrets', async () => {
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: env({ NODE_ENV: 'production', GUIDE_PASSCODE: PASSCODE, DEMO_CODES: 'YK-TESTCODE1' }) });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`起動しない: ${out}`)), 10_000);
      child.stdout.on('data', () => { if (/ガイドさん合言葉/.test(out)) { clearTimeout(timer); resolve(); } });
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`exit ${code}: ${out}`)); });
    });
  } finally {
    child.kill();
  }
  assert.doesNotMatch(out, /test-passcode|YK-TESTCODE1/, '合言葉と非公開のデモコードはログに出さない');
  assert.match(out, /購入: 停止中/, '公開では購入が既定で止まる');
});

test('purchaseEnabled_defaults_dependOnEnvironment', () => {
  const v = (extra) => JSON.parse(configValue(extra, "require('./lib/config').PURCHASE_ENABLED").stdout);
  assert.equal(v({}), true, 'ローカルの既定は有効（今までどおり）');
  assert.equal(v({ PURCHASE_ENABLED: '0' }), false);
  assert.equal(v({ PURCHASE_ENABLED: 'false' }), false);
  assert.equal(v({ NODE_ENV: 'production' }), false, '公開の既定は停止');
  assert.equal(v({ NODE_ENV: 'production', PURCHASE_ENABLED: '1' }), true);
});

test('demoPublic_isTrueOnlyForTheDefaultCodeAlone', () => {
  const v = (extra) => JSON.parse(configValue(extra, "require('./lib/config').DEMO_PUBLIC").stdout);
  assert.equal(v({}), true);
  assert.equal(v({ DEMO_CODES: 'DEMO2027,' }), true, '空の要素は無視する');
  assert.equal(v({ DEMO_CODES: 'DEMO2027,YK-OTHER01' }), false);
  assert.equal(v({ DEMO_CODES: 'YK-OTHER01' }), false);
});
