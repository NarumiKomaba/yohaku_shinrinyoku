// パソコンで動かす（npm start / npm start:lan）。記録は Firestore の envs/local、Spot はお試し版と同じ envs/preview を読み書きする。
// トークンは gcloud の shinrinyoku 設定から取る（既定の設定は変えない）。環境変数で指定したものはそのまま使う。
// 合言葉（GUIDE_PASSCODE）がなければ、お試し版と同じものを SHINRINYOKU_PREVIEW_ENV（既定 ~/.secrets/shinrinyoku/preview.env）から読む。
// 読めなければ既定の合言葉のままで、共有の Spot は読むだけになる（lib/config.js の SPOTS_READ_ONLY）。合言葉は表示しない。
// --lan ではファイルから読まない（お試し版の合言葉を LAN に出さない）。LAN で Spot を保存するなら GUIDE_PASSCODE を環境変数で渡す
// Firestore を使わずに動かすときは npm run start:offline（ファイル版）
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PREVIEW_ENV = path.join(os.homedir(), '.secrets', 'shinrinyoku', 'preview.env');

/** KEY=VALUE の行から GUIDE_PASSCODE を取り出す（引用符は外す）。ファイルがなければ '' */
function readPasscode(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return ''; }
  const line = text.split(/\r?\n/).find((l) => /^\s*GUIDE_PASSCODE\s*=/.test(l));
  return line ? line.replace(/^\s*GUIDE_PASSCODE\s*=\s*/, '').trim().replace(/^(['"])(.*)\1$/, '$2') : '';
}

function main() {
  const env = process.env;
  env.STORE_BACKEND ??= 'firestore';
  env.FIRESTORE_PROJECT_ID ??= 'yohaku-shinrinyoku';
  env.GCLOUD_CONFIG ??= 'shinrinyoku';
  env.STORE_NAMESPACE ??= 'local';
  env.SPOTS_NAMESPACE ??= 'preview';
  const lan = process.argv.includes('--lan');
  if (!env.GUIDE_PASSCODE && !lan) {
    const passcode = readPasscode(env.SHINRINYOKU_PREVIEW_ENV || DEFAULT_PREVIEW_ENV);
    if (passcode) env.GUIDE_PASSCODE = passcode;
  }
  if (lan) env.HOST = '0.0.0.0';
  require('../server').start();
}

if (require.main === module) main();

module.exports = { readPasscode };
