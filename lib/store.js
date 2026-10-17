// JSON ファイルとイベントログ（Phase 1 は DB を使わずファイルで十分）
'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR, LOG_DIR } = require('./config');

const EVENTS_FILE = path.join(LOG_DIR, 'events.jsonl');

function readData(name) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
}

// 上書き前に logs/ へバックアップを残す
function writeData(name, obj) {
  const file = path.join(DATA_DIR, name);
  if (fs.existsSync(file)) fs.copyFileSync(file, path.join(LOG_DIR, `${path.basename(name, '.json')}.backup-${Date.now()}.json`));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

function readLog(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(LOG_DIR, name), 'utf8')); } catch { return fallback; }
}

function writeLog(name, obj) {
  fs.writeFileSync(path.join(LOG_DIR, name), JSON.stringify(obj, null, 2), 'utf8');
}

function appendEvents(events) {
  if (!events.length) return;
  fs.appendFileSync(EVENTS_FILE, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

function readEvents() {
  if (!fs.existsSync(EVENTS_FILE)) return [];
  return fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
}

module.exports = { readData, writeData, readLog, writeLog, appendEvents, readEvents };
