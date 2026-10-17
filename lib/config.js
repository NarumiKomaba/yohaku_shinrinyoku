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
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DEFAULT_DEMO_CODE = 'DEMO2027';
const DEFAULT_GUIDE_PASSCODE = 'GAIEN-GUIDE';
const MIN_PASSCODE_LENGTH = 16;
const MIN_DEMO_CODE_LENGTH = 8;

// '1'/'true'/'on'/'yes' → true、'0'/'false'/'off'/'no' → false、それ以外（未設定を含む）→ 既定値
function flag(value, fallback) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(v)) return true;
  if (['0', 'false', 'off', 'no'].includes(v)) return false;
  return fallback;
}
const count = (value) => Math.max(0, Math.floor(Number(value) || 0));

const DEMO_CODES = (process.env.DEMO_CODES || DEFAULT_DEMO_CODE).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const GUIDE_PASSCODE = process.env.GUIDE_PASSCODE || DEFAULT_GUIDE_PASSCODE;

// 公開（NODE_ENV=production）で起動してはいけない設定。server.js が起動時に確かめ、1 つでもあれば起動しない
function productionProblems() {
  const problems = [];
  if (!process.env.GUIDE_PASSCODE || process.env.GUIDE_PASSCODE.length < MIN_PASSCODE_LENGTH) problems.push(`GUIDE_PASSCODE（${MIN_PASSCODE_LENGTH} 文字以上）を設定してください`);
  const codes = String(process.env.DEMO_CODES || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!codes.length) problems.push('DEMO_CODES を設定してください');
  if (codes.includes(DEFAULT_DEMO_CODE)) problems.push(`DEMO_CODES に ${DEFAULT_DEMO_CODE} は使えません`);
  if (codes.some((c) => c.length < MIN_DEMO_CODE_LENGTH)) problems.push(`DEMO_CODES は ${MIN_DEMO_CODE_LENGTH} 文字以上にしてください`);
  return problems;
}

module.exports = {
  ROOT,
  PUBLIC_DIR: path.join(ROOT, 'public'),
  DATA_DIR,
  LOG_DIR,
  IS_PRODUCTION,
  PORT: Number(process.env.PORT) || 3000,
  HOST: process.env.HOST || '127.0.0.1',
  MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  API_KEY: apiKey.key,
  KEY_SOURCE: apiKey.source,
  // ガイドさんページ・集計・エディタ用の合言葉（Phase 1 は共通の合言葉で十分という方針）
  GUIDE_PASSCODE,
  GUIDE_PASSCODE_IS_DEFAULT: !process.env.GUIDE_PASSCODE,
  DEFAULT_DEMO_CODE,
  DEMO_CODES,
  // デモコードが初期値だけなら公開してよい（画面に表示する）。お試し版など、別のコードにしたときは画面に出さない
  DEMO_PUBLIC: DEMO_CODES.length === 1 && DEMO_CODES[0] === DEFAULT_DEMO_CODE,
  // 購入（モック）を受け付けるか。ローカルの既定は有効（'0' で止める）、公開（production）の既定は停止（'1' で有効）
  PURCHASE_ENABLED: flag(process.env.PURCHASE_ENABLED, !IS_PRODUCTION),
  // サーバー全体での 1 日（日本時間）の Gemini 呼び出し上限（体験者向けの呼び出しだけを数える）。未設定 or 0 = 無制限
  LLM_DAILY_MAX: count(process.env.LLM_DAILY_MAX),
  // 1 つのデモコードで 1 日（日本時間）に始められる体験の数。未設定 or 0 = 無制限
  SESSIONS_PER_CODE_DAILY: count(process.env.SESSIONS_PER_CODE_DAILY),
  // X-Forwarded-For を足す、信頼できるプロキシの段数（Cloud Run は 1）。0 = 接続元のアドレスをそのまま使う
  TRUSTED_PROXY_HOPS: count(process.env.TRUSTED_PROXY_HOPS),
  LOG_QUESTION_TEXT: process.env.LOG_QUESTION_TEXT === '1',
  // 1M トークンあたり USD（概算。モデル変更時は環境変数で上書き）
  PRICE_IN: Number(process.env.GEMINI_PRICE_IN_PER_M) || 0.3,
  PRICE_OUT: Number(process.env.GEMINI_PRICE_OUT_PER_M) || 2.5,
  USD_JPY: Number(process.env.USD_JPY) || 150,
  productionProblems,
};
