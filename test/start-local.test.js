'use strict';
// scripts/start-local.js（npm start）: Firestore の既定値と、お試し版の合言葉（ファイル）を入れて起動する。Firestore にはつながず、gcloud は偽物
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { CLEARED_ENV, fakeGcloud } = require('./_helper');

const ROOT = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-start-'));
const { readPasscode } = require('../scripts/start-local');
const STRONG = 'preview-passcode-0123456789';
const passcodeFile = path.join(dataDir, 'preview.env');
fs.writeFileSync(passcodeFile, ['DEMO_CODES=YK-X', `GUIDE_PASSCODE="${STRONG}"`, ''].join('\n'));
const NO_FILE = path.join(dataDir, 'none.env'); // 本物の ~/.secrets は読ませない

function localEnv(extra, gcloud) {
  const base = { ...process.env };
  for (const k of [...CLEARED_ENV, 'STORE_BACKEND', 'HOST', 'GUIDE_PASSCODE']) delete base[k];
  return gcloud.envWith({ ...base, DATA_DIR: dataDir, GEMINI_API_KEY: '', PORT: '0', SHINRINYOKU_PREVIEW_ENV: NO_FILE, ...extra });
}

// 先にトークンを取るので、本物の gcloud の代わりに偽物を置く
// waitFor（ファイル）を渡すと、それができるまで止めずに待つ
function startAndReadLog(args, extra = {}, { gcloud = fakeGcloud(), waitFor } = {}) {
  const env = localEnv(extra, gcloud);
  const child = spawn(process.execPath, ['scripts/start-local.js', ...args], { cwd: ROOT, env });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`起動しない: ${out}`)); }, 10_000);
    const ready = () => !waitFor || fs.existsSync(waitFor);
    const check = () => {
      if (!/ガイドさん合言葉/.test(out)) return;
      if (!ready()) { setTimeout(check, 100); return; }
      clearTimeout(timer);
      child.kill();
      resolve(out);
    };
    child.stdout.on('data', check);
    child.on('exit', (code) => { clearTimeout(timer); if (!/ガイドさん合言葉/.test(out)) reject(new Error(`exit ${code}: ${out}`)); });
  });
}

test('npmStart_usesFirestoreLocalRecordsAndPreviewSpots', async () => {
  const out = await startAndReadLog([]);
  assert.match(out, /記録: Firestore yohaku-shinrinyoku（envs\/local、Spot は envs\/preview、認証 gcloud）/);
  assert.match(out, /127\.0\.0\.1/);
});

test('npmStart_fetchesTokenAtStartup_withFakeGcloud', async () => {
  const gcloud = fakeGcloud();
  await startAndReadLog([], {}, { gcloud, waitFor: gcloud.calledFile });
  assert.ok(fs.existsSync(gcloud.calledFile), '最初のリクエストを待たずに gcloud でトークンを取る');
});

test('npmStartLan_withExplicitPasscode_listensOnAllInterfaces', async () => {
  assert.match(await startAndReadLog(['--lan'], { GUIDE_PASSCODE: STRONG }), /http:\/\/localhost:/);
});

test('npmStartLan_doesNotLoadPreviewPasscodeFile', () => {
  const r = spawnSync(process.execPath, ['scripts/start-local.js', '--lan'], { cwd: ROOT, env: localEnv({ SHINRINYOKU_PREVIEW_ENV: passcodeFile }, fakeGcloud()), encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 1, 'LAN ではお試し版の合言葉をファイルから読まない（明示した GUIDE_PASSCODE だけ）');
  assert.match(r.stderr, /LAN に出せません/);
});

test('npmStartLan_withSharedSpotsAndWeakPasscode_refusesToStart', () => {
  const r = spawnSync(process.execPath, ['scripts/start-local.js', '--lan'], { cwd: ROOT, env: localEnv({}, fakeGcloud()), encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /LAN に出せません/);
});

test('npmStart_readsPreviewPasscodeFromFile_withoutPrintingIt', async () => {
  const out = await startAndReadLog([], { SHINRINYOKU_PREVIEW_ENV: passcodeFile });
  assert.match(out, /ガイドさん合言葉: \(設定済み\)/);
  assert.doesNotMatch(out, new RegExp(STRONG));
  assert.doesNotMatch(out, /読むだけ/, '合言葉が強ければ共有の Spot も保存できる');
});

test('npmStart_withoutPasscodeFile_makesSharedSpotsReadOnly', async () => {
  const out = await startAndReadLog([]);
  assert.match(out, /GAIEN-GUIDE（既定）/);
  assert.match(out, /Spot（envs\/preview）: 合言葉が既定か短いので読むだけ/);
});

test('npmStart_passcodeInEnvironment_winsOverFile', async () => {
  assert.match(await startAndReadLog([], { SHINRINYOKU_PREVIEW_ENV: passcodeFile, GUIDE_PASSCODE: 'short' }), /読むだけ/);
});

test('readPasscode_parsesLine_andMissingFileIsEmpty', () => {
  const f = path.join(dataDir, 'p.env');
  fs.writeFileSync(f, ['A=1', "  GUIDE_PASSCODE = 'abc def'", ''].join('\r\n'));
  assert.equal(readPasscode(f), 'abc def');
  fs.writeFileSync(f, 'A=1\n');
  assert.equal(readPasscode(f), '');
  assert.equal(readPasscode(NO_FILE), '');
});

test('npmStart_keepsValuesGivenInEnvironment', async () => {
  assert.match(await startAndReadLog([], { STORE_BACKEND: 'file' }), /記録: file/);
});
