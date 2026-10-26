'use strict';
// サービスアカウントの鍵で Vertex AI の Gemini を呼ぶ（鍵はテストの中で作る。本物は呼ばない）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./_helper');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const keyJson = (extra = {}) => JSON.stringify({ client_email: 'sa@proj-x.iam.gserviceaccount.com', project_id: 'proj-x', ['private' + '_key']: pem, ...extra });

h.setupEnv({ extraEnv: { GEMINI_SERVICE_ACCOUNT_JSON: keyJson() } });
const { parseServiceAccount, createServiceAccountTokens } = require('../lib/service-account');
const { callGemini, enabled } = require('../lib/gemini');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('parseServiceAccount_invalidOrEmpty_returnsNull', () => {
  assert.equal(parseServiceAccount(''), null);
  assert.equal(parseServiceAccount('not json'), null);
  assert.equal(parseServiceAccount(JSON.stringify({ ['private' + '_key']: 'x' })), null);
  assert.equal(parseServiceAccount(keyJson()).projectId, 'proj-x');
});

test('tokens_get_signsJwtAndReusesToken', async () => {
  const calls = [];
  const fetch = async (url, opts) => { calls.push({ url, opts }); return json({ access_token: 'tok-1', expires_in: 3600 }); };
  const src = createServiceAccountTokens({ account: parseServiceAccount(keyJson()), fetch, now: () => 1_000_000 });
  assert.deepEqual(await Promise.all([src.get(), src.get()]), ['tok-1', 'tok-1']);
  assert.equal(await src.get(), 'tok-1');
  assert.equal(calls.length, 1);
  const form = new URLSearchParams(calls[0].opts.body);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [head, claim, sig] = form.get('assertion').split('.');
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${head}.${claim}`), publicKey, Buffer.from(sig, 'base64url')));
  const c = JSON.parse(Buffer.from(claim, 'base64url'));
  assert.equal(c.iss, 'sa@proj-x.iam.gserviceaccount.com');
  assert.equal(c.iat, 1000);
});

test('tokens_failure_throwsWithoutLeakingDetails', async () => {
  const fetch = async () => json({ error: 'bad' }, 400);
  const src = createServiceAccountTokens({ account: parseServiceAccount(keyJson()), fetch });
  await assert.rejects(src.get(), (e) => e.message === 'service account token failed');
});

test('callGemini_withServiceAccount_callsVertexWithBearerToken', async () => {
  assert.equal(enabled(), true);
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).startsWith('https://oauth2.googleapis.com/')) return json({ access_token: 'tok-abc', expires_in: 3600 });
    return json({ candidates: [{ content: { parts: [{ text: 'こんにちは' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
  };
  try {
    const out = await callGemini({ system: 's', contents: [{ role: 'user', parts: [{ text: 'q' }] }] });
    assert.equal(out.text, 'こんにちは');
  } finally {
    globalThis.fetch = h.realFetch;
  }
  const call = calls.find((c) => c.url.includes('/publishers/google/models/'));
  assert.match(call.url, /^https:\/\/aiplatform\.googleapis\.com\/v1\/projects\/proj-x\/locations\/global\/publishers\/google\/models\/.+:generateContent$/);
  assert.equal(call.opts.headers.Authorization, 'Bearer tok-abc');
  assert.ok(!call.url.includes('key='));
});
