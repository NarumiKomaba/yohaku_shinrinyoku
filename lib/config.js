// 設定値と API キーの読み込み
'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const LOG_DIR = path.join(DATA_DIR, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

// プロセス環境変数 → (Windows) レジストリのユーザー環境変数 の順に探す。値はログに出さない。
function loadApiKey() {
  if (process.env.GEMINI_API_KEY !== undefined) return { key: process.env.GEMINI_API_KEY.trim(), source: 'process env' };
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'GEMINI_API_KEY'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.match(/GEMINI_API_KEY\s+REG_\w+\s+(\S+)/);
      if (m) return { key: m[1].trim(), source: 'Windows user environment' };
    } catch { /* 未設定 */ }
  }
  return { key: '', source: 'none' };
}
const apiKey = loadApiKey();
const DEFAULT_DEMO_CODE = 'DEMO2027';

module.exports = {
  ROOT,
  PUBLIC_DIR: path.join(ROOT, 'public'),
  DATA_DIR,
  LOG_DIR,
  PORT: Number(process.env.PORT) || 3000,
  HOST: process.env.HOST || '127.0.0.1',
  MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  API_KEY: apiKey.key,
  KEY_SOURCE: apiKey.source,
  // ガイドさんページ・集計・エディタ用の合言葉（Phase 1 は共通の合言葉で十分という方針）
  GUIDE_PASSCODE: process.env.GUIDE_PASSCODE || 'GAIEN-GUIDE',
  DEMO_CODES: (process.env.DEMO_CODES || DEFAULT_DEMO_CODE).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  // デモコードが初期値のままなら公開してよい（画面に表示する）。お試し版など、別のコードにしたときは画面に出さない
  DEMO_PUBLIC: !process.env.DEMO_CODES || process.env.DEMO_CODES.trim().toUpperCase() === DEFAULT_DEMO_CODE,
  // 購入（モック）を受け付けるか。'0' で止める（お試し版など、コードを配る人だけに使わせたいとき）
  PURCHASE_ENABLED: process.env.PURCHASE_ENABLED !== '0',
  // サーバー全体での 1 日（日本時間）の Gemini 呼び出し上限。未設定 or 0 = 無制限
  LLM_DAILY_MAX: Math.max(0, Math.floor(Number(process.env.LLM_DAILY_MAX) || 0)),
  LOG_QUESTION_TEXT: process.env.LOG_QUESTION_TEXT === '1',
  // 1M トークンあたり USD（概算。モデル変更時は環境変数で上書き）
  PRICE_IN: Number(process.env.GEMINI_PRICE_IN_PER_M) || 0.3,
  PRICE_OUT: Number(process.env.GEMINI_PRICE_OUT_PER_M) || 2.5,
  USD_JPY: Number(process.env.USD_JPY) || 150,
};
