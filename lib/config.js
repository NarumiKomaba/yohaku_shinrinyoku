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
// NODE_ENV=production か、Cloud Run（K_SERVICE を自動で設定する）で動いているときは公開とみなす
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || Boolean(process.env.K_SERVICE);
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
// 未設定（or 0）なら、公開では prodDefault、ローカルでは 0（無制限）
const limit = (value, prodDefault) => count(value) || (IS_PRODUCTION ? prodDefault : 0);

const DEMO_CODES = (process.env.DEMO_CODES || DEFAULT_DEMO_CODE).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const GUIDE_PASSCODE = process.env.GUIDE_PASSCODE || DEFAULT_GUIDE_PASSCODE;

// 公開（NODE_ENV=production か Cloud Run）で起動してはいけない設定。server.js が起動時に確かめ、1 つでもあれば起動しない
function productionProblems() {
  const problems = [];
  const passcode = String(process.env.GUIDE_PASSCODE || '').trim();
  if (passcode.length < MIN_PASSCODE_LENGTH) problems.push(`GUIDE_PASSCODE（${MIN_PASSCODE_LENGTH} 文字以上）を設定してください`);
  const codes = String(process.env.DEMO_CODES || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!codes.length) problems.push('DEMO_CODES を設定してください');
  if (codes.includes(DEFAULT_DEMO_CODE)) problems.push(`DEMO_CODES に ${DEFAULT_DEMO_CODE} は使えません`);
  if (codes.some((c) => c.length < MIN_DEMO_CODE_LENGTH)) problems.push(`DEMO_CODES は ${MIN_DEMO_CODE_LENGTH} 文字以上にしてください`);
  // 費用と負荷の上限（無制限のままでは公開しない）
  for (const name of ['LLM_DAILY_MAX', 'NARRATE_MAX_PER_SESSION', 'ASK_MAX_PER_SESSION', 'SESSIONS_PER_CODE_DAILY']) {
    if (!count(process.env[name])) problems.push(`${name}（1 以上）を設定してください`);
  }
  if (!count(process.env.TRUSTED_PROXY_HOPS)) problems.push('TRUSTED_PROXY_HOPS（Cloud Run は 1）を設定してください');
  // 購入（モック）は誰でもコードを発行でき、デモコードの上限も効かないので、公開では使えない
  if (flag(process.env.PURCHASE_ENABLED, false)) problems.push('公開では PURCHASE_ENABLED=1 にできません');
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
  // 1 回の体験で案内（/api/narrate）・質問（/api/ask）に Gemini を使える回数。超えたら素材だけの案内。未設定 or 0 = 無制限
  NARRATE_MAX_PER_SESSION: count(process.env.NARRATE_MAX_PER_SESSION),
  ASK_MAX_PER_SESSION: count(process.env.ASK_MAX_PER_SESSION),
  // 1 つのデモコードで 1 日（日本時間）に始められる体験の数。未設定 or 0 = 無制限
  SESSIONS_PER_CODE_DAILY: count(process.env.SESSIONS_PER_CODE_DAILY),
  // 1 つの接続元（IPv4 はアドレス、IPv6 は /64）で 1 日に始められる体験の数。ローカルの既定は無制限、公開の既定は 20
  SESSIONS_PER_IP_DAILY: limit(process.env.SESSIONS_PER_IP_DAILY, 20),
  // 体験中の API（質問・案内・チェックイン）を 1 回の体験で呼べる回数。ローカルの既定は無制限、公開の既定は 1 分 30 回・1 日 300 回
  WALK_CALLS_PER_MIN: limit(process.env.WALK_CALLS_PER_MIN, 30),
  WALK_CALLS_PER_DAY: limit(process.env.WALK_CALLS_PER_DAY, 300),
  // 利用ログ（events.jsonl）に 1 日に書き込む量の上限（バイト）。超えた分は捨てる。ローカルの既定は無制限、公開の既定は 20MB
  EVENTS_DAILY_BYTES: limit(process.env.EVENTS_DAILY_BYTES, 20_000_000),
  // X-Forwarded-For を足す、信頼できるプロキシの段数（Cloud Run は 1）。0 = 接続元のアドレスをそのまま使う
  TRUSTED_PROXY_HOPS: count(process.env.TRUSTED_PROXY_HOPS),
  LOG_QUESTION_TEXT: process.env.LOG_QUESTION_TEXT === '1',
  // 1M トークンあたり USD（概算。モデル変更時は環境変数で上書き）
  PRICE_IN: Number(process.env.GEMINI_PRICE_IN_PER_M) || 0.3,
  PRICE_OUT: Number(process.env.GEMINI_PRICE_OUT_PER_M) || 2.5,
  USD_JPY: Number(process.env.USD_JPY) || 150,
  productionProblems,
};
