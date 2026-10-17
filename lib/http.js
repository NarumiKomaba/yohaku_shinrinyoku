// HTTP ヘルパー
'use strict';

// すべての応答に付けるセキュリティ用のヘッダー。外部から読むのは Leaflet 1.9.4（unpkg。SRI 付き）、地図タイル（国土地理院）、
// OSM 候補の取得（Overpass API）だけ。unpkg は誰でもパッケージを置けるので、Leaflet のパスだけに絞る。
// admin.html の <style> と Leaflet のために style は 'unsafe-inline' を許す
const LEAFLET = 'https://unpkg.com/leaflet@1.9.4/';
const CSP = [
  "default-src 'self'",
  `script-src 'self' ${LEAFLET}`,
  `style-src 'self' 'unsafe-inline' ${LEAFLET}`,
  `img-src 'self' data: blob: https://cyberjapandata.gsi.go.jp ${LEAFLET}`,
  "connect-src 'self' https://overpass-api.de",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(self), microphone=(self), camera=()',
  'Strict-Transport-Security': 'max-age=31536000',
};

function send(res, status, body, headers = {}) {
  const isText = Buffer.isBuffer(body) || typeof body === 'string';
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isText ? body : JSON.stringify(body));
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// 録音データ（base64）を受けるため上限は呼び出し側で指定できる
function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(httpError(413, 'payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(httpError(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}

module.exports = { send, readBody, httpError, SECURITY_HEADERS };
