'use strict';
// 1 日の上限（LLM_DAILY_MAX）が日本時間の 0 時（UTC 15:00）で数え直されること
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./_helper');

h.setupEnv({ key: 'test-key-not-real', extraEnv: { LLM_DAILY_MAX: '1' } });
const { _test } = require('../lib/gemini');
const { jstDay } = require('../lib/limits');

test('jstDay_aroundUtc1500_switchesToNextJapaneseDate', () => {
  assert.equal(jstDay(Date.parse('2026-10-17T14:59:59Z')), '2026-10-17');
  assert.equal(jstDay(Date.parse('2026-10-17T15:00:00Z')), '2026-10-18');
});

test('takeDailyQuota_atJstMidnight_resetsCount', () => {
  _test.resetDaily();
  const before = Date.parse('2026-10-17T14:59:58Z'); // 日本時間 23:59:58
  assert.equal(_test.takeDailyQuota(before), true);
  assert.equal(_test.takeDailyQuota(before + 1000), false, '同じ日のうちは上限で止まる');
  assert.equal(_test.takeDailyQuota(Date.parse('2026-10-17T15:00:00Z')), true, '日本時間 0 時で数え直す');
  assert.equal(_test.takeDailyQuota(Date.parse('2026-10-17T15:00:01Z')), false);
});
