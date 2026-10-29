'use strict';
// クライアント JS の構文エラー（例: 文字列内の未エスケープ ' ）を検出する。他のテストは一部のモジュールしか import しないため。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const JS_DIR = path.join(__dirname, '..', 'public', 'js');
const files = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));

test('clientJs_directory_hasFiles', () => {
  assert.ok(files.length >= 5);
  assert.ok(files.includes('i18n.js') && files.includes('app.js'));
});

for (const f of files) {
  test(`clientJs_${f}_passesNodeCheck`, () => {
    // public/js/package.json が "type":"module" なので ESM として検査される
    const r = spawnSync(process.execPath, ['--check', path.join(JS_DIR, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  });
}

const keyPaths = (o, prefix = '') => Object.entries(o).flatMap(([k, v]) => (
  v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${prefix}${k}.`) : [`${prefix}${k}`]));

test('i18n_jaAndEn_haveIdenticalKeys', async () => {
  const { STRINGS } = await import(pathToFileURL(path.join(JS_DIR, 'i18n.js')).href);
  assert.deepEqual(Object.keys(STRINGS).sort(), ['en', 'ja']);
  const ja = new Set(keyPaths(STRINGS.ja));
  const en = new Set(keyPaths(STRINGS.en));
  assert.deepEqual([...ja].filter((k) => !en.has(k)), [], 'en に無いキー');
  assert.deepEqual([...en].filter((k) => !ja.has(k)), [], 'ja に無いキー');
});

test('i18n_values_areNonEmptyAndSameTypeAcrossLanguages', async () => {
  const { STRINGS } = await import(pathToFileURL(path.join(JS_DIR, 'i18n.js')).href);
  const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? flat(v, `${p}${k}.`) : [[`${p}${k}`, v]]));
  const en = new Map(flat(STRINGS.en));
  for (const [k, v] of flat(STRINGS.ja)) {
    assert.equal(typeof v, typeof en.get(k), `${k} の型`);
    if (typeof v === 'string') {
      assert.ok(v.trim() !== '', `ja.${k} が空`);
      if (k !== 'times') assert.ok(String(en.get(k)).trim() !== '', `en.${k} が空`); // times は日本語の助数詞「回」で、英語は意図的に空
    }
  }
});

test('endYes_onClick_showsReflectScreenOnFinishing', () => {
  const app = fs.readFileSync(path.join(JS_DIR, 'app.js'), 'utf8');
  assert.match(app, /\$\('#end-yes'\)\.addEventListener\('click', \(\) => \{[^}]*app\.engine\?\.finish\(\)/);
  assert.match(app, /addEventListener\('finishing', goReflect\)/);
  assert.match(app, /function goReflect\(\) \{ show\('screen-reflect'\); \}/);
});

test('i18n_shortButtonLabels_areShort', async () => {
  const { STRINGS } = await import(pathToFileURL(path.join(JS_DIR, 'i18n.js')).href);
  assert.equal(STRINGS.ja.autoListenOn, '聞き取り: オン');
  assert.equal(STRINGS.en.autoListenOff, 'Listen: off');
  for (const l of ['ja', 'en']) for (const k of ['typeInstead', 'pocket', 'rateLabel']) assert.ok(STRINGS[l][k].length <= 8, `${l}.${k}`);
});
