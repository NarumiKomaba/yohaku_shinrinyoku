// Digital Nature & Wellness Instructor — 皇居外苑版 (Phase 1 prototype server)
// 依存パッケージなし (Node 18+)。ルートは routes/*.js に分割（担当ごとにファイルを分けて競合を防ぐ）。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('./lib/config');
const { send, SECURITY_HEADERS } = require('./lib/http');

// 公開（NODE_ENV=production か Cloud Run）で設定が足りなければ起動しない。
// node server.js では routes（が読み込む保存先）を作る前に確かめ、start() でももう一度確かめる（scripts/start-local.js は公開では使わない）
function refuseIfMisconfigured() {
  if (!cfg.IS_PRODUCTION) return;
  const problems = cfg.productionProblems();
  if (!problems.length) return;
  console.error(['公開用の設定が足りないため起動しません（NODE_ENV=production）:', ...problems.map((p) => `  - ${p}`)].join('\n'));
  process.exit(1);
}
if (require.main === module) refuseIfMisconfigured();

// "METHOD /path/:param" 形式のキーを正規表現に変換して登録
const routes = [];
for (const mod of ['core', 'walk', 'guide']) {
  for (const [key, handler] of Object.entries(require(`./routes/${mod}`))) {
    const [method, pattern] = key.split(' ');
    const names = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
    routes.push({ method, re, names, handler });
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch { return send(res, 400, 'bad request'); }
  const file = path.normalize(path.join(cfg.PUBLIC_DIR, decoded));
  if (!file.startsWith(cfg.PUBLIC_DIR + path.sep)) return send(res, 403, 'forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found');
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const isLocalHost = (host) => ['127.0.0.1', 'localhost', '::1'].includes(host);
// Host ヘッダーのホスト名（ポートを除く。IPv6 は [::1] の形のまま）
const hostName = (host) => String(host || '').trim().toLowerCase().replace(/:\d+$/, '');
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

async function handle(req, res) {
  // ループバックで待ち受けているときは、Host がループバックの名前でなければ断る
  // （DNS リバインディングで、ほかのサイトからこのパソコンのサーバーを操作させない）
  if (isLocalHost(cfg.HOST) && !LOOPBACK_NAMES.has(hostName(req.headers.host))) return send(res, 421, { error: 'misdirected' });
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.re);
      if (!m) continue;
      let params;
      try { params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])])); } catch { return send(res, 400, { error: 'bad request' }); }
      return send(res, 200, await r.handler(req, params));
    }
    if (req.method === 'GET' && !pathname.startsWith('/api/')) return serveStatic(res, pathname);
    send(res, 404, { error: 'not found' });
  } catch (e) {
    if (!e.status || e.status >= 500) console.error(`[${req.method} ${pathname}]`, e.message);
    // httpError で決めた短い理由だけを返す。想定外の例外（ファイルのパスなどを含みうる）は中身を返さない
    send(res, e.status || 500, { error: e.status ? e.message : 'internal_error' });
  }
}

const store = require('./lib/store');
const server = http.createServer(handle);
// 遅いクライアントに接続を握られ続けないようにする（録音のアップロードも 2 分あれば足りる）
server.requestTimeout = 120_000;
server.headersTimeout = 20_000;


// 止めるとき（Cloud Run は SIGTERM）: 受け付けをやめ、書きかけのログと持ち越したイベントを最大 5 秒待って書く
const FLUSH_WAIT_MS = 5000;
async function shutdown({ exit = process.exit } = {}) {
  server.close();
  await Promise.race([store.flush(), new Promise((r) => setTimeout(r, FLUSH_WAIT_MS).unref())]);
  exit(0);
}

// npm start（scripts/start-local.js）からも呼べるように関数にする（node -e や require では require.main が server.js にならない）
// 読むだけの Spot（お試し版と同じものなど）を、弱い合言葉のまま LAN に出さない
function refuseSharedSpotsOnLan() {
  if (isLocalHost(cfg.HOST) || !cfg.SPOTS_READ_ONLY) return;
  console.error(`Spot（envs/${cfg.SPOTS_NAMESPACE}）を、既定または短い合言葉のまま LAN に出せません。GUIDE_PASSCODE（16 文字以上）を環境変数で設定するか、SPOTS_NAMESPACE・STORE_NAMESPACE を local にしてください`);
  process.exit(1);
}

const say = (line) => process.stdout.write(`${line}\n`);

function start() {
  refuseIfMisconfigured();
  refuseSharedSpotsOnLan();
  process.once('SIGTERM', () => { shutdown(); });
  process.once('SIGINT', () => { shutdown(); });
  // 最初の体験者が gcloud やメタデータサーバーを待たないよう、先にトークンを取る（失敗しても起動は続ける）
  store.warmUp();
  server.listen(cfg.PORT, cfg.HOST, () => {
    say(`Digital Nature & Wellness Instructor — http://${cfg.HOST === '0.0.0.0' ? 'localhost' : cfg.HOST}:${cfg.PORT}`);
    say('  体験アプリ: /   ガイドさんページ: /guide.html   集計: /admin.html');
    say(`  Gemini: ${cfg.SERVICE_ACCOUNT_JSON ? `service account key found, model=${cfg.MODEL}` : cfg.API_KEY ? `key found (${cfg.KEY_SOURCE}), model=${cfg.MODEL}` : 'key NOT found → 素材・Knowledge のみで動作（フォールバック）'}`);
    say(`  記録: ${cfg.STORE_BACKEND === 'firestore' ? `Firestore ${cfg.FIRESTORE_PROJECT_ID}（envs/${cfg.STORE_NAMESPACE}、Spot は envs/${cfg.SPOTS_NAMESPACE}、認証 ${cfg.FIRESTORE_AUTH}）` : cfg.STORE_BACKEND}`);
    if (cfg.SPOTS_READ_ONLY) say(`  Spot（envs/${cfg.SPOTS_NAMESPACE}）: 合言葉が既定か短いので読むだけ（GUIDE_PASSCODE を 16 文字以上にすると保存できる）`);
    // 合言葉と非公開のデモコードは、ログ（Cloud Run ではクラウドに残る）に出さない
    say(`  デモ用購入コード: ${cfg.DEMO_PUBLIC ? cfg.DEMO_CODES.join(', ') : '(設定済み)'}${cfg.PURCHASE_ENABLED ? '' : '   購入: 停止中'}${cfg.LLM_DAILY_MAX ? `   LLM 上限: ${cfg.LLM_DAILY_MAX} 回/日` : ''}   ガイドさん合言葉: ${cfg.GUIDE_PASSCODE_IS_DEFAULT ? `${cfg.GUIDE_PASSCODE}（既定）` : '(設定済み)'}`);
    if (!isLocalHost(cfg.HOST)) {
      if (cfg.GUIDE_PASSCODE_IS_DEFAULT) console.warn('  ⚠ 外部から接続できる状態で既定の合言葉を使っています。GUIDE_PASSCODE を設定してください。');
      if (cfg.PURCHASE_ENABLED) console.warn('  ⚠ 外部から接続できる状態で購入（モック）が有効です。誰でもコードを発行できます。PURCHASE_ENABLED=0 を設定してください。');
      if (cfg.DEMO_PUBLIC) console.warn('  ⚠ 外部から接続できる状態で公開のデモコードを使っています。DEMO_CODES を設定してください。');
    }
  });
}

if (require.main === module) start();

module.exports = { server, handle, start, shutdown };
