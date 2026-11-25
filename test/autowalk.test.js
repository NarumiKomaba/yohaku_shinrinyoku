'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
let AW;
let spots;
before(async () => {
  AW = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'autowalk.js')).href);
  const all = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'spots.json'), 'utf8')).spots;
  spots = all.filter((s) => s.enabled !== false).sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
});

const startOf = () => ({ lat: spots[0].lat + 0.0012, lng: spots[0].lng + 0.0009 });

// 疑似エンジン: 着いたら contentSec 秒かけて案内し、終わったら完了
function simulate({ totalMin, contentSec, maxSec = 6 * 3600 }) {
  const visited = [];
  const finishAt = {};
  let t = 0;
  const isSpotDone = (s) => finishAt[s.id] !== undefined && t >= finishAt[s.id];
  const w = AW.createAutoWalker({ start: startOf(), spots, totalMin, isSpotDone });
  const metres = (p, s) => Math.hypot((p.lat - s.lat) * 111195, (p.lng - s.lng) * 111195 * Math.cos(s.lat * Math.PI / 180));
  let moved = 0;
  let prev = w.pos;
  const stoppedAt = {};
  const stops = [];
  while (!w.finished && t < maxSec) {
    const before = w.targetSpot;
    const p = w.tick(1);
    if (before && w.targetSpot !== before) stops.push(before.id);
    t += 1;
    moved += metres(p, prev);
    prev = p;
    for (const s of spots) {
      if (!visited.includes(s.id) && metres(p, s) <= s.radius) {
        visited.push(s.id);
        finishAt[s.id] = t + contentSec;
        stoppedAt[s.id] = t;
      }
    }
  }
  return { visited, stops, t, moved, stoppedAt, finishAt };
}

test('autowalk_noTime_visitsSpotsInOrder', () => {
  const r = simulate({ totalMin: null, contentSec: 60 });
  assert.deepEqual(r.stops, spots.map((s) => s.id));
  assert.ok(spots.every((s) => r.visited.includes(s.id)));
});

test('autowalk_noTime_walksAtNormalSpeed', () => {
  const w = AW.createAutoWalker({ start: startOf(), spots, isSpotDone: () => true });
  assert.ok(w.plan.speedMps >= 1.1 && w.plan.speedMps <= 1.3);
  const a = w.pos;
  const b = w.tick(10);
  const d = Math.hypot((b.lat - a.lat) * 111195, (b.lng - a.lng) * 111195 * Math.cos(a.lat * Math.PI / 180));
  assert.ok(Math.abs(d / 10 - w.plan.speedMps) < 0.05);
});

test('autowalk_atSpot_waitsUntilSpotIsDone', () => {
  let done = false;
  const w = AW.createAutoWalker({ start: { lat: spots[0].lat, lng: spots[0].lng }, spots, isSpotDone: () => done });
  for (let i = 0; i < 120; i++) w.tick(1);
  assert.equal(w.targetSpot.id, spots[0].id);
  assert.equal(w.pos.lat, spots[0].lat);
  done = true;
  w.tick(1);
  assert.equal(w.targetSpot.id, spots[1].id);
});

test('autowalk_twentyMinutes_finishesAboutTwentyMinutes', () => {
  const r = simulate({ totalMin: 20, contentSec: 20 });
  assert.deepEqual(r.stops, spots.map((s) => s.id));
  assert.ok(spots.every((s) => r.visited.includes(s.id)));
  assert.ok(r.t > 20 * 60 * 0.85 && r.t < 20 * 60 * 1.1, `t=${r.t}`);
});

test('autowalk_resume_headsToFirstUnfinishedSpot', () => {
  const doneIds = new Set([spots[0].id]);
  const w = AW.createAutoWalker({ start: startOf(), spots, isSpotDone: (s) => doneIds.has(s.id) });
  w.resume({ lat: spots[1].lat, lng: spots[1].lng });
  assert.equal(w.targetSpot.id, spots[1].id);
});

test('autowalk_followsEngineNext_arrivesAtAnnouncedSpot', () => {
  // 疑似エンジン: いちばん近い未訪問のスポットを「次」と案内する（order とは違う順になる）
  const visited = new Set();
  const finishAt = {};
  let t = 0;
  let w;
  const metres = (p, s) => Math.hypot((p.lat - s.lat) * 111195, (p.lng - s.lng) * 111195 * Math.cos(s.lat * Math.PI / 180));
  const nextSpot = () => {
    const rest = spots.filter((s) => !visited.has(s.id));
    return rest.sort((a, b) => metres(w.pos, a) - metres(w.pos, b))[0] || null;
  };
  const isSpotDone = (s) => finishAt[s.id] !== undefined && t >= finishAt[s.id];
  w = AW.createAutoWalker({ start: startOf(), spots, isSpotDone, nextSpot });
  const announced = [];
  const announcedFrom = new Set();
  const arrived = [];
  while (!w.finished && t < 6 * 3600) {
    const before = w.targetSpot;
    const p = w.tick(1);
    t += 1;
    for (const s of spots) {
      if (!visited.has(s.id) && metres(p, s) <= s.radius) {
        visited.add(s.id);
        arrived.push(s.id);
        finishAt[s.id] = t + 20;
      }
    }
    if (before && !announcedFrom.has(before.id) && finishAt[before.id] !== undefined && t >= finishAt[before.id]) {
      announcedFrom.add(before.id);
      const n = nextSpot();
      if (n) announced.push(n.id);
    }
  }
  assert.equal(arrived.length, spots.length);
  assert.deepEqual(arrived.slice(1), announced);
});
