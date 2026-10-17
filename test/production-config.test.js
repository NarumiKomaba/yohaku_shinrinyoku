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
  for (const k of ['NODE_ENV', 'K_SERVICE', 'GUIDE_PASSCODE', 'DEMO_CODES', 'PURCHASE_ENABLED', 'LLM_DAILY_MAX', 'NARRATE_MAX_PER_SESSION', 'ASK_MAX_PER_SESSION',
    'SESSIONS_PER_CODE_DAILY', 'SESSIONS_PER_IP_DAILY', 'WALK_CALLS_PER_MIN', 'WALK_CALLS_PER_DAY', 'EVENTS_DAILY_BYTES', 'TRUSTED_PROXY_HOPS', 'HOST']) delete base[k];
  return { ...base, ...extra };
}
const configValue = (extra, expr) => spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(${expr}))`], { cwd: ROOT, env: env(extra), encoding: 'utf8' });
// 公開で必要な設定がそろった状態（各テストはここから 1 つ抜く・変える）
const VALID = {
  NODE_ENV: 'production', GUIDE_PASSCODE: PASSCODE, DEMO_CODES: 'YK-TESTCODE1', LLM_DAILY_MAX: '200', NARRATE_MAX_PER_SESSION: '40',
  ASK_MAX_PER_SESSION: '20', SESSIONS_PER_CODE_DAILY: '30', TRUSTED_PROXY_HOPS: '1',
};
const without = (key) => Object.fromEntries(Object.entries(VALID).filter(([k]) => k !== key));
const runServer = (extra) => spawnSync(process.execPath, ['server.js'], { cwd: ROOT, env: env(extra), encoding: 'utf8', timeout: 10_000 });

for (const [name, extra, pattern] of [
  ['missingPasscode', without('GUIDE_PASSCODE'), /GUIDE_PASSCODE/],
  ['shortPasscode', { ...VALID, GUIDE_PASSCODE: 'short' }, /GUIDE_PASSCODE/],
  ['blankPaddedPasscode', { ...VALID, GUIDE_PASSCODE: `  short${' '.repeat(20)}` }, /GUIDE_PASSCODE/],
  ['missingDemoCodes', without('DEMO_CODES'), /DEMO_CODES を設定/],
  ['defaultDemoCode', { ...VALID, DEMO_CODES: 'YK-TESTCODE1,DEMO2027' }, /DEMO2027/],
  ['shortDemoCode', { ...VALID, DEMO_CODES: 'ABC' }, /8 文字以上/],
  ['missingLlmDailyMax', without('LLM_DAILY_MAX'), /LLM_DAILY_MAX/],
  ['missingNarrateMax', without('NARRATE_MAX_PER_SESSION'), /NARRATE_MAX_PER_SESSION/],
  ['missingAskMax', without('ASK_MAX_PER_SESSION'), /ASK_MAX_PER_SESSION/],
  ['missingSessionsPerCode', without('SESSIONS_PER_CODE_DAILY'), /SESSIONS_PER_CODE_DAILY/],
  ['missingProxyHops', without('TRUSTED_PROXY_HOPS'), /TRUSTED_PROXY_HOPS/],
  ['purchaseEnabled', { ...VALID, PURCHASE_ENABLED: '1' }, /PURCHASE_ENABLED/],
  ['cloudRunWithoutNodeEnv', { ...without('NODE_ENV'), K_SERVICE: 'svc', LLM_DAILY_MAX: '' }, /LLM_DAILY_MAX/],
]) {
  test(`production_with_${name}_refusesToStart`, () => {
    const r = runServer(extra);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, pattern);
    assert.doesNotMatch(r.stderr + r.stdout, /short|test-passcode/, '合言葉の値はログに出さない');
  });
}

test('production_withValidConfig_startsWithoutPrintingSecrets', async () => {
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: env(VALID) });
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
  assert.equal(v({ NODE_ENV: 'production', PURCHASE_ENABLED: '1' }), true, '値は読める（ただし起動時の確認で止まる）');
  assert.equal(v({ K_SERVICE: 'svc' }), false, 'Cloud Run（K_SERVICE）も公開とみなす');
});

test('demoPublic_isTrueOnlyForTheDefaultCodeAlone', () => {
  const v = (extra) => JSON.parse(configValue(extra, "require('./lib/config').DEMO_PUBLIC").stdout);
  assert.equal(v({}), true);
  assert.equal(v({ DEMO_CODES: 'DEMO2027,' }), true, '空の要素は無視する');
  assert.equal(v({ DEMO_CODES: 'DEMO2027,YK-OTHER01' }), false);
  assert.equal(v({ DEMO_CODES: 'YK-OTHER01' }), false);
});

test('productionDefaults_turnOnLoadLimits_butLocalStaysUnlimited', () => {
  const v = (extra) => JSON.parse(configValue(extra, "(({ SESSIONS_PER_IP_DAILY, WALK_CALLS_PER_MIN, WALK_CALLS_PER_DAY, EVENTS_DAILY_BYTES }) => ({ SESSIONS_PER_IP_DAILY, WALK_CALLS_PER_MIN, WALK_CALLS_PER_DAY, EVENTS_DAILY_BYTES }))(require('./lib/config'))").stdout);
  assert.deepEqual(v({}), { SESSIONS_PER_IP_DAILY: 0, WALK_CALLS_PER_MIN: 0, WALK_CALLS_PER_DAY: 0, EVENTS_DAILY_BYTES: 0 }, 'ローカルは今までどおり無制限');
  assert.deepEqual(v({ NODE_ENV: 'production' }), { SESSIONS_PER_IP_DAILY: 20, WALK_CALLS_PER_MIN: 30, WALK_CALLS_PER_DAY: 300, EVENTS_DAILY_BYTES: 20_000_000 });
  assert.equal(v({ NODE_ENV: 'production', SESSIONS_PER_IP_DAILY: '5' }).SESSIONS_PER_IP_DAILY, 5);
});
