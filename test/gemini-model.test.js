'use strict';
// Flash 系のモデル（新しいプロジェクトで使う gemini-3.8-flash など）は、考える時間を 0 にして送る
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./_helper');

h.setupEnv({ key: 'test-key-not-real', extraEnv: { GEMINI_MODEL: 'gemini-3.8-flash' } });
const { callGemini } = require('../lib/gemini');

test('callGemini_withNewerFlashModel_disablesThinkingAndUsesThatModel', async () => {
  const urls = [];
  const stub = h.stubGemini(() => 'はい。');
  const fetchStub = globalThis.fetch;
  globalThis.fetch = (url, opts) => { urls.push(String(url)); return fetchStub(url, opts); };
  try {
    await callGemini({ system: 's', contents: [{ role: 'user', parts: [{ text: 'q' }] }] });
  } finally {
    globalThis.fetch = h.realFetch;
  }
  assert.deepEqual(stub.bodies[0].generationConfig.thinkingConfig, { thinkingBudget: 0 });
  assert.match(urls[0], /models\/gemini-3\.8-flash:generateContent/);
});
