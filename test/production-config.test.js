'use strict';
// 公開（NODE_ENV=production）の設定: 足りなければ起動しない、購入は既定で止める、合言葉をログに出さない
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { CLEARED_ENV, fakeGcloud } = require('./_helper');

const ROOT = path.join(__dirname, '..');
const PASSCODE = 'test-passcode-0123456789';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-prod-'));
const gcloud = fakeGcloud();

// 開発者のシェルの設定に左右されないよう、関係する環境変数は消してから渡す
function env(extra) {
  const base = { ...process.env, DATA_DIR: dataDir, GEMINI_API_KEY: '', PORT: '0' };
  for (const k of [...CLEARED_ENV, 'GUIDE_PASSCODE', 'STORE_BACKEND', 'HOST']) delete base[k];
  // 起動したサーバーは先にトークンを取るので、本物の gcloud の代わりに偽物を置く
  return gcloud.envWith({ ...base, ...extra });
}
const configValue = (extra, expr) => spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(${expr}))`], { cwd: ROOT, env: env(extra), encoding: 'utf8' });
// 公開で必要な設定がそろった状態（各テストはここから 1 つ抜く・変える）
const VALID = {
  NODE_ENV: 'production', GUIDE_PASSCODE: PASSCODE, DEMO_CODES: 'YK-TESTCODE1', LLM_DAILY_MAX: '200', NARRATE_MAX_PER_SESSION: '40',
  ASK_MAX_PER_SESSION: '20', SESSIONS_PER_CODE_DAILY: '30', TRUSTED_PROXY_HOPS: '1',
  STORE_BACKEND: 'firestore', FIRESTORE_PROJECT_ID: 'test-project', STORE_NAMESPACE: 'preview',
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
  // 記録は Firestore に残す（ファイルはインスタンスが止まると消える）
  ['missingStoreBackend', without('STORE_BACKEND'), /STORE_BACKEND=firestore/],
  ['fileStoreBackend', { ...VALID, STORE_BACKEND: 'file' }, /STORE_BACKEND=firestore/],
  ['missingFirestoreProject', without('FIRESTORE_PROJECT_ID'), /FIRESTORE_PROJECT_ID/],
  ['missingStoreNamespace', without('STORE_NAMESPACE'), /STORE_NAMESPACE/],
  ['localStoreNamespace', { ...VALID, STORE_NAMESPACE: 'local' }, /STORE_NAMESPACE/],
  ['malformedStoreNamespace', { ...VALID, STORE_NAMESPACE: 'Pre/view' }, /STORE_NAMESPACE/],
  ['malformedSpotsNamespace', { ...VALID, SPOTS_NAMESPACE: '../x' }, /SPOTS_NAMESPACE/],
  ['localSpotsNamespace', { ...VALID, SPOTS_NAMESPACE: 'local' }, /SPOTS_NAMESPACE/],
  ['gcloudAuth', { ...VALID, FIRESTORE_AUTH: 'gcloud' }, /FIRESTORE_AUTH/],
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

test('storeSettings_defaults', () => {
  const v = (extra) => JSON.parse(configValue(extra, "(({ STORE_BACKEND, STORE_NAMESPACE, SPOTS_NAMESPACE, FIRESTORE_DATABASE, EVENTS_DAILY_WRITES, STATS_MAX_DOCS, STATS_CACHE_SEC, SPOTS_CACHE_SEC }) => ({ STORE_BACKEND, STORE_NAMESPACE, SPOTS_NAMESPACE, FIRESTORE_DATABASE, EVENTS_DAILY_WRITES, STATS_MAX_DOCS, STATS_CACHE_SEC, SPOTS_CACHE_SEC }))(require('./lib/config'))").stdout);
  assert.deepEqual(v({}), { STORE_BACKEND: 'file', STORE_NAMESPACE: 'local', SPOTS_NAMESPACE: 'local', FIRESTORE_DATABASE: '(default)', EVENTS_DAILY_WRITES: 0, STATS_MAX_DOCS: 1000, STATS_CACHE_SEC: 300, SPOTS_CACHE_SEC: 30 });
  assert.equal(v({ NODE_ENV: 'production' }).EVENTS_DAILY_WRITES, 15_000);
  assert.equal(v({ STATS_CACHE_SEC: '0' }).STATS_CACHE_SEC, 0, '0 も設定として使う');
  assert.equal(v({ STORE_NAMESPACE: 'local', SPOTS_NAMESPACE: 'preview' }).SPOTS_NAMESPACE, 'preview');
});

test('firestoreAuth_defaultsToMetadataOnCloudRun_andGcloudElsewhere', () => {
  const v = (extra) => JSON.parse(configValue(extra, "require('./lib/config').FIRESTORE_AUTH").stdout);
  assert.equal(v({}), 'gcloud');
  assert.equal(v({ K_SERVICE: 'svc' }), 'metadata');
  assert.equal(v({ NODE_ENV: 'production' }), 'metadata', '公開の既定は実行アカウント');
  assert.equal(v({ FIRESTORE_AUTH: 'metadata' }), 'metadata');
});

test('sharedSpots_withWeakPasscode_areReadOnly', () => {
  const v = (extra) => JSON.parse(configValue(extra, "(({ SPOTS_SHARED, SPOTS_READ_ONLY }) => ({ SPOTS_SHARED, SPOTS_READ_ONLY }))(require('./lib/config'))").stdout);
  assert.deepEqual(v({}), { SPOTS_SHARED: false, SPOTS_READ_ONLY: false });
  assert.deepEqual(v({ SPOTS_NAMESPACE: 'preview' }), { SPOTS_SHARED: true, SPOTS_READ_ONLY: true }, '既定の合言葉');
  assert.deepEqual(v({ SPOTS_NAMESPACE: 'preview', GUIDE_PASSCODE: 'short' }), { SPOTS_SHARED: true, SPOTS_READ_ONLY: true }, '短い合言葉');
  assert.deepEqual(v({ SPOTS_NAMESPACE: 'preview', GUIDE_PASSCODE: PASSCODE }), { SPOTS_SHARED: true, SPOTS_READ_ONLY: false });
  assert.deepEqual(v({ STORE_NAMESPACE: 'preview' }), { SPOTS_SHARED: false, SPOTS_READ_ONLY: true }, 'パソコンからお試し版の名前空間を直接使うときも、弱い合言葉では読むだけ');
  assert.deepEqual(v({ STORE_NAMESPACE: 'preview', GUIDE_PASSCODE: PASSCODE }), { SPOTS_SHARED: false, SPOTS_READ_ONLY: false });
  assert.deepEqual(v({ NODE_ENV: 'production', STORE_NAMESPACE: 'preview' }), { SPOTS_SHARED: false, SPOTS_READ_ONLY: false }, '公開は起動時の確認で合言葉を強くさせる');
});
