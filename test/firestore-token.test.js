'use strict';
// lib/firestore/token.js: Cloud Run はメタデータサーバー、パソコンは gcloud からトークンを取り、使い回す（本物は呼ばない）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTokenSource, METADATA_URL } = require('../lib/firestore/token');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function metadataFetch(tokens) {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url, opts });
    const next = tokens.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'number' ? json({}, next) : json({ access_token: next, expires_in: 3600, token_type: 'Bearer' });
  };
  return { fetch, calls };
}

test('metadata_fetchesWithFlavorHeader_andReusesUntilFiveMinutesBeforeExpiry', async () => {
  let t = 0;
  const m = metadataFetch(['tok-1', 'tok-2']);
  const src = createTokenSource({ mode: 'metadata', fetch: m.fetch, now: () => t });
  assert.equal(await src.get(), 'tok-1');
  assert.equal(m.calls[0].url, METADATA_URL);
  assert.equal(m.calls[0].opts.headers['Metadata-Flavor'], 'Google');
  assert.ok(m.calls[0].opts.signal, 'タイムアウトを付ける');
  t = (3600 - 301) * 1000;
  assert.equal(await src.get(), 'tok-1');
  t = (3600 - 299) * 1000;
  assert.equal(await src.get(), 'tok-2');
  assert.equal(m.calls.length, 2);
});

test('metadata_parallelGets_shareOneRequest', async () => {
  const m = metadataFetch(['tok-1']);
  const src = createTokenSource({ mode: 'metadata', fetch: m.fetch });
  assert.deepEqual(await Promise.all([src.get(), src.get(), src.get()]), ['tok-1', 'tok-1', 'tok-1']);
  assert.equal(m.calls.length, 1);
});

test('metadata_failure_throwsStoreUnavailable_andRetriesNextTime', async () => {
  const m = metadataFetch([500, new Error('connect ECONNREFUSED'), 'tok-ok']);
  const src = createTokenSource({ mode: 'metadata', fetch: m.fetch });
  await assert.rejects(src.get(), (e) => e.message === 'store_unavailable' && e.status === 503);
  await assert.rejects(src.get(), (e) => e.message === 'store_unavailable');
  assert.equal(await src.get(), 'tok-ok');
});

test('invalidate_forcesNewToken', async () => {
  const m = metadataFetch(['tok-1', 'tok-2']);
  const src = createTokenSource({ mode: 'metadata', fetch: m.fetch });
  assert.equal(await src.get(), 'tok-1');
  src.invalidate();
  assert.equal(await src.get(), 'tok-2');
});

test('metadata_shortLivedToken_isReusedForAtMostHalfItsLife', async () => {
  let t = 0;
  const fetch = async () => new Response(JSON.stringify({ access_token: `tok-${t}`, expires_in: 400 }), { status: 200 });
  const src = createTokenSource({ mode: 'metadata', fetch, now: () => t });
  assert.equal(await src.get(), 'tok-0');
  t = 199_000;
  assert.equal(await src.get(), 'tok-0');
  t = 201_000;
  assert.equal(await src.get(), 'tok-201000', '400 秒のトークンは 200 秒まで（5 分前では 100 秒になってしまう）');
});

// run = execFile（file, args, opts）
function recorder(outputs) {
  const calls = [];
  const run = async (file, args, opts) => {
    calls.push({ file, args, opts });
    const out = outputs[calls.length - 1];
    if (out instanceof Error) throw out;
    return { stdout: out };
  };
  return { calls, run };
}

test('gcloud_runsFixedArgsWithConfig_trimsAndReusesFor50Minutes', async () => {
  let t = 0;
  const { calls, run } = recorder(['ya29.tok-1\n', 'ya29.tok-2\n']);
  const src = createTokenSource({ mode: 'gcloud', gcloudConfig: 'shinrinyoku', run, platform: 'linux', now: () => t });
  assert.equal(await src.get(), 'ya29.tok-1');
  assert.equal(calls[0].file, 'gcloud');
  assert.deepEqual(calls[0].args, ['auth', 'print-access-token'], '引数は固定値だけ（シェルを通さない）');
  assert.equal(calls[0].opts.env.CLOUDSDK_ACTIVE_CONFIG_NAME, 'shinrinyoku', '既定の設定（会社用）は変えず、この実行だけで切り替える');
  assert.ok(calls[0].opts.timeout > 0);
  t = 49 * 60_000;
  assert.equal(await src.get(), 'ya29.tok-1');
  t = 51 * 60_000;
  assert.equal(await src.get(), 'ya29.tok-2');
});

test('gcloud_onWindows_resolvesFullPathOnce_ignoringCwd_andRunsItViaCmd', async () => {
  let t = 0;
  const where = 'C:\\repo\\gcloud.cmd\r\nC:\\sdk\\bin\\gcloud.cmd\r\n';
  const { calls, run } = recorder([where, 'tok-1\r\n', 'tok-2\r\n']);
  const env = { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe', PATH: 'C:\\repo;C:\\sdk\\bin' };
  const src = createTokenSource({ mode: 'gcloud', gcloudConfig: 'shinrinyoku', run, platform: 'win32', cwd: 'C:\\repo', env, now: () => t });
  assert.equal(await src.get(), 'tok-1');
  assert.match(calls[0].file, /where\.exe$/i);
  assert.deepEqual(calls[0].args, ['gcloud']);
  assert.equal(calls[1].file, env.ComSpec);
  assert.deepEqual(calls[1].args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(calls[1].args[3], /"C:\\sdk\\bin\\gcloud\.cmd" auth print-access-token/, '作業フォルダの gcloud.cmd は使わない');
  assert.equal(calls[1].opts.windowsVerbatimArguments, true);
  t = 51 * 60_000;
  assert.equal(await src.get(), 'tok-2');
  assert.equal(calls.filter((c) => /where\.exe$/i.test(c.file)).length, 1, '場所を調べるのは 1 回');
});

test('gcloud_onWindows_onlyInCwd_fails', async () => {
  const { run } = recorder(['C:\\repo\\sub\\gcloud.cmd\r\n']);
  const src = createTokenSource({ mode: 'gcloud', gcloudConfig: 'x', run, platform: 'win32', cwd: 'C:\\repo', env: { SystemRoot: 'C:\\Windows' } });
  await assert.rejects(src.get(), (e) => e.message === 'store_unavailable');
});

test('gcloud_withoutConfigName_isRefused', () => {
  assert.throws(() => createTokenSource({ mode: 'gcloud' }), /GCLOUD_CONFIG/, '既定の gcloud の設定（会社用）は使わない');
});

test('gcloud_failureOrEmptyOutput_throwsWithoutLeakingOutput', async () => {
  const secret = 'ya29.SHOULD-NOT-LEAK';
  for (const out of [Object.assign(new Error(`Command failed: ${secret}`), { stderr: secret }), '  \n']) {
    const { run } = recorder([out]);
    const src = createTokenSource({ mode: 'gcloud', gcloudConfig: 'x', run, platform: 'linux' });
    await assert.rejects(src.get(), (e) => e.message === 'store_unavailable' && !JSON.stringify({ ...e, m: e.message }).includes(secret));
  }
});

test('createTokenSource_withUnknownMode_throws', () => {
  assert.throws(() => createTokenSource({ mode: 'adc' }), /FIRESTORE_AUTH/);
});
