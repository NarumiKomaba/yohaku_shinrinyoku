// 書き換えない同梱データ（knowledge.json・scenario.json）。1 回だけ読み、変えられないようにして使い回す。Spot は lib/store から読む
'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { deepFreeze } = require('./freeze');

const STATIC_FILES = new Set(['knowledge.json', 'scenario.json']);
let loaded = new Map(); // name -> 読んだ内容

function readStatic(name) {
  if (!STATIC_FILES.has(name)) throw new Error(`not static: ${name}`);
  if (!loaded.has(name)) loaded = new Map(loaded).set(name, deepFreeze(JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'))));
  return loaded.get(name);
}

module.exports = { readStatic };
