// Digital Nature & Wellness Instructor — 皇居外苑版 (Phase 1 prototype server)
// 依存パッケージなし (Node 18+)。ルートは routes/*.js に分割（担当ごとにファイルを分けて競合を防ぐ）。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('./lib/config');
const { send } = require('./lib/http');

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
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

async function handle(req, res) {
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
    send(res, e.status || 500, { error: e.message });
  }
}

const server = http.createServer(handle);

if (require.main === module) {
  server.listen(cfg.PORT, cfg.HOST, () => {
    console.log(`Digital Nature & Wellness Instructor — http://${cfg.HOST === '0.0.0.0' ? 'localhost' : cfg.HOST}:${cfg.PORT}`);
    console.log('  体験アプリ: /   ガイドさんページ: /guide.html   集計: /admin.html');
    console.log(`  Gemini: ${cfg.API_KEY ? `key found (${cfg.KEY_SOURCE}), model=${cfg.MODEL}` : 'key NOT found → 素材・Knowledge のみで動作（フォールバック）'}`);
    console.log(`  デモ用購入コード: ${cfg.DEMO_PUBLIC ? cfg.DEMO_CODES.join(', ') : '(環境変数で設定済み)'}${cfg.PURCHASE_ENABLED ? '' : '   購入: 停止中'}${cfg.LLM_DAILY_MAX ? `   LLM 上限: ${cfg.LLM_DAILY_MAX} 回/日` : ''}   ガイドさん合言葉: ${process.env.GUIDE_PASSCODE ? '(環境変数で設定済み)' : cfg.GUIDE_PASSCODE}`);
    if (!['127.0.0.1', 'localhost', '::1'].includes(cfg.HOST) && !process.env.GUIDE_PASSCODE) {
      console.warn('  ⚠ 外部から接続できる状態で既定の合言葉を使っています。GUIDE_PASSCODE を設定してください。');
    }
  });
}

module.exports = { server, handle };
