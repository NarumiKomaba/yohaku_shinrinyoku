'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

let M; // motion.js (ESM)
before(async () => {
  globalThis.window = globalThis.window || {};
  M = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'motion.js')).href);
});

const LAT0 = 35.68;
const LNG0 = 139.756;
const M_PER_DEG_LAT = 111195; // 緯度 1 度あたりのおおよその m
const north = (m) => LAT0 + m / M_PER_DEG_LAT;

function makeTracker() {
  let t = 1_000_000;
  const tr = new M.MotionTracker({ now: () => t });
  return { tr, advance: (ms) => { t += ms; }, now: () => t };
}

test('distanceM_between1mNorth_isAboutOneMeter', () => {
  const d = M.distanceM({ lat: LAT0, lng: LNG0 }, { lat: north(100), lng: LNG0 });
  assert.ok(Math.abs(d - 100) < 1, String(d));
  assert.equal(M.distanceM({ lat: LAT0, lng: LNG0 }, { lat: LAT0, lng: LNG0 }), 0);
});

test('speed_withNoPoints_isZeroAndNotMoving', () => {
  const { tr } = makeTracker();
  assert.equal(tr.speedMps, 0);
  assert.equal(tr.moving, false);
});

test('speed_withSinglePoint_isZero', () => {
  const { tr } = makeTracker();
  tr.push(LAT0, LNG0, 5);
  assert.equal(tr.speedMps, 0);
});

test('speed_walking14mIn10s_isAbout1_4AndMoving', () => {
  const { tr, advance } = makeTracker();
  tr.push(LAT0, LNG0, 5);
  advance(10_000);
  tr.push(north(14), LNG0, 5);
  assert.ok(Math.abs(tr.speedMps - 1.4) < 0.05, String(tr.speedMps));
  assert.equal(tr.moving, true);
  assert.equal(tr.snapshot(null).moving, true);
});

test('speed_spanShorterThan4s_isZero', () => {
  const { tr, advance } = makeTracker();
  tr.push(LAT0, LNG0, 5);
  advance(3_000);
  tr.push(north(30), LNG0, 5);
  assert.equal(tr.speedMps, 0, '短時間の飛びを速度にしない');
});

test('speed_stationaryJitter_isNotMoving', () => {
  const { tr, advance } = makeTracker();
  tr.push(LAT0, LNG0, 5);
  advance(10_000);
  tr.push(north(2), LNG0, 5); // 10 秒で 2m = 0.2 m/s < 0.4
  assert.ok(tr.speedMps < 0.4);
  assert.equal(tr.moving, false);
});

test('speed_atThreshold_0_4mpsIsMoving', () => {
  const { tr, advance } = makeTracker();
  tr.push(LAT0, LNG0, 5);
  advance(10_000);
  tr.push(north(4.1), LNG0, 5);
  assert.equal(tr.moving, true);
});

test('speed_whenLastPointIsStale_over15s_isZero', () => {
  const { tr, advance } = makeTracker();
  tr.push(LAT0, LNG0, 5);
  advance(10_000);
  tr.push(north(15), LNG0, 5);
  assert.equal(tr.moving, true);
  advance(16_000);
  assert.equal(tr.speedMps, 0);
  assert.equal(tr.moving, false);
});

test('push_withPoorAccuracyOver30m_isExcludedFromSpeed', () => {
  const { tr, advance } = makeTracker();
  tr.push(LAT0, LNG0, 5);
  advance(10_000);
  tr.push(north(500), LNG0, 80); // 精度が悪い大きな飛び
  assert.equal(tr.speedMps, 0, '低精度点は速度に使わない');
  assert.equal(tr.moving, false);
});

test('push_withPoorAccuracy_stillUpdatesPositionForDistance', () => {
  const { tr } = makeTracker();
  tr.push(north(500), LNG0, 80);
  assert.ok(tr.pos);
  const snap = tr.snapshot({ lat: LAT0, lng: LNG0 });
  assert.ok(Math.abs(snap.distanceToSpotM - 500) < 2);
});

test('push_withAccuracyExactly30_isUsedAndNullAccuracyIsUsed', () => {
  const { tr, advance } = makeTracker();
  tr.push(LAT0, LNG0, 30);
  advance(10_000);
  tr.push(north(14), LNG0, null);
  assert.equal(tr.moving, true);
});

test('speed_usesOnlyPointsWithinLast20s', () => {
  const { tr, advance } = makeTracker();
  tr.push(LAT0, LNG0, 5);
  advance(10_000);
  tr.push(north(14), LNG0, 5);
  advance(25_000); // 古い 2 点は窓から外れる
  tr.push(north(14), LNG0, 5);
  advance(10_000);
  tr.push(north(14.5), LNG0, 5);
  assert.equal(tr.moving, false);
});

test('dwellSec_whileStopped_growsWithTime', () => {
  const { tr, advance } = makeTracker();
  tr.push(LAT0, LNG0, 5);
  assert.equal(tr.dwellSec, 0);
  advance(30_000);
  assert.equal(tr.dwellSec, 30);
});

test('dwellSec_whenStartsMoving_resetsToZero', () => {
  const { tr, advance } = makeTracker();
  tr.push(LAT0, LNG0, 5);
  advance(20_000);
  assert.equal(tr.dwellSec, 20);
  tr.push(LAT0, LNG0, 5);
  advance(5_000);
  tr.push(north(8), LNG0, 5); // 5s で 8m、moving
  assert.equal(tr.moving, true);
  assert.equal(tr.dwellSec, 0);
});

test('dwell_enterLeaveReset_andSkip', () => {
  const { tr, advance } = makeTracker();
  tr.enterSpot();
  advance(5_000);
  assert.equal(tr.dwellSec, 5);
  tr.skipDwell(40);
  assert.equal(tr.dwellSec, 45);
  tr.resetDwell();
  assert.equal(tr.dwellSec, 0);
  tr.leaveSpot();
  assert.equal(tr.dwellSec, 0, 'leaveSpot 直後の snapshot.dwellSec は update で再計測される');
});

test('snapshot_withoutPositionOrSpot_hasNullDistance', () => {
  const { tr } = makeTracker();
  assert.equal(tr.snapshot({ lat: LAT0, lng: LNG0 }).distanceToSpotM, null);
  tr.push(LAT0, LNG0, 5);
  assert.equal(tr.snapshot(null).distanceToSpotM, null);
});

test('snapshot_speed_isRoundedTo2Decimals', () => {
  const { tr, advance } = makeTracker();
  tr.push(LAT0, LNG0, 5);
  advance(7_000);
  tr.push(north(10), LNG0, 5);
  const s = tr.snapshot(null).speedMps;
  assert.equal(s, Math.round(s * 100) / 100);
});

// ---------- avgWalkMps / compassIndex ----------
function walk(tr, advance, mps, steps) {
  for (let i = 0; i <= steps; i++) {
    tr.push(north(i * 5 * mps), LNG0, 5);
    advance(5_000);
  }
}

test('avgWalkMps_withFewerThan5MovingSamples_is1_1', () => {
  const { tr, advance } = makeTracker();
  assert.equal(tr.avgWalkMps, 1.1);
  walk(tr, advance, 1.4, 4); // 5 点 → 移動中の標本は 4 つ
  assert.equal(tr.avgWalkMps, 1.1);
});

test('avgWalkMps_withEnoughSamples_isMeanMovingSpeed', () => {
  const { tr, advance } = makeTracker();
  walk(tr, advance, 1.4, 8);
  assert.ok(Math.abs(tr.avgWalkMps - 1.4) < 0.05, String(tr.avgWalkMps));
});

test('avgWalkMps_isClampedTo0_6_1_6', () => {
  const fast = makeTracker();
  walk(fast.tr, fast.advance, 3, 8);
  assert.equal(fast.tr.avgWalkMps, 1.6);
  const slow = makeTracker();
  walk(slow.tr, slow.advance, 0.45, 8); // moving ぎりぎり（>= 0.4）
  assert.equal(slow.tr.avgWalkMps, 0.6);
});

test('avgWalkMps_afterLongStop_staysWithinClampAndStopsCountingSamples', () => {
  const { tr, advance } = makeTracker();
  walk(tr, advance, 1.4, 8);
  for (let i = 0; i < 12; i++) { tr.push(north(8 * 5 * 1.4), LNG0, 5); advance(5_000); } // 1 分止まる
  assert.equal(tr.moving, false);
  const a = tr.avgWalkMps;
  for (let i = 0; i < 6; i++) { tr.push(north(8 * 5 * 1.4), LNG0, 5); advance(5_000); }
  assert.equal(tr.avgWalkMps, a, '止まっている間は平均が変わらない');
  assert.ok(a >= 0.6 && a <= 1.6);
});

const OFFS = {
  0: [100, 0], 1: [100, 100], 2: [0, 100], 3: [-100, 100], 4: [-100, 0], 5: [-100, -100], 6: [0, -100], 7: [100, -100],
};
test('compassIndex_eightDirections', () => {
  const a = { lat: LAT0, lng: LNG0 };
  const east = (m) => m / (M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180));
  for (const [idx, [n, e]] of Object.entries(OFFS)) {
    const b = { lat: LAT0 + n / M_PER_DEG_LAT, lng: LNG0 + east(e) };
    assert.equal(M.compassIndex(a, b), Number(idx), `index ${idx}`);
  }
});

test('compassIndex_northWrapAround_andBoundaries', () => {
  const a = { lat: LAT0, lng: LNG0 };
  const east = (m) => m / (M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180));
  assert.equal(M.compassIndex(a, { lat: LAT0 + 100 / M_PER_DEG_LAT, lng: LNG0 - east(10) }), 0, '北より少し西は 0（7 ではない）');
  assert.equal(M.compassIndex(a, { lat: LAT0 + 100 / M_PER_DEG_LAT, lng: LNG0 + east(10) }), 0);
  assert.equal(M.compassIndex(a, { lat: LAT0 + 100 / M_PER_DEG_LAT, lng: LNG0 - east(60) }), 7);
});
