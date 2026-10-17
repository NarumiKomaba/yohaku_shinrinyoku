// JSON ファイルとイベントログ（Phase 1 は DB を使わずファイルで十分）
'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR, LOG_DIR, EVENTS_DAILY_BYTES } = require('./config');
const { jstDay } = require('./limits');

const EVENTS_FILE = path.join(LOG_DIR, 'events.jsonl');
const MAX_BACKUPS = 20; // 1 つのデータファイルについて残すバックアップの数

function readData(name) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
}

// 上書き前に logs/ へバックアップを残す（新しいものから MAX_BACKUPS 個まで。Cloud Run ではファイルがメモリを使うため）
function writeData(name, obj) {
  const file = path.join(DATA_DIR, name);
  if (fs.existsSync(file)) {
    const base = path.basename(name, '.json');
    fs.copyFileSync(file, path.join(LOG_DIR, `${base}.backup-${Date.now()}.json`));
    pruneBackups(base);
  }
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

function pruneBackups(base) {
  const prefix = `${base}.backup-`;
  const stamp = (f) => Number(f.slice(prefix.length, -'.json'.length)) || 0;
  const backups = fs.readdirSync(LOG_DIR).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).sort((a, b) => stamp(b) - stamp(a));
  for (const f of backups.slice(MAX_BACKUPS)) fs.rmSync(path.join(LOG_DIR, f), { force: true });
}

function readLog(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(LOG_DIR, name), 'utf8')); } catch { return fallback; }
}

function writeLog(name, obj) {
  fs.writeFileSync(path.join(LOG_DIR, name), JSON.stringify(obj, null, 2), 'utf8');
}

// 1 日（日本時間）に書き込んだ量。EVENTS_DAILY_BYTES を超える分は捨てる（ログでメモリを使い切られないように）。書いた件数を返す
let written = { day: '', bytes: 0 };
function appendEvents(events) {
  if (!events.length) return 0;
  const text = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const bytes = Buffer.byteLength(text, 'utf8');
  const day = jstDay();
  const used = written.day === day ? written.bytes : 0;
  if (EVENTS_DAILY_BYTES && used + bytes > EVENTS_DAILY_BYTES) return 0;
  fs.appendFileSync(EVENTS_FILE, text, 'utf8');
  written = { day, bytes: used + bytes };
  return events.length;
}

function readEvents() {
  if (!fs.existsSync(EVENTS_FILE)) return [];
  return fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
}

module.exports = { readData, writeData, readLog, writeLog, appendEvents, readEvents, MAX_BACKUPS };
