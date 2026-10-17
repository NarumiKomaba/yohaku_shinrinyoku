// HTTP ヘルパー
'use strict';

function send(res, status, body, headers = {}) {
  const isText = Buffer.isBuffer(body) || typeof body === 'string';
  res.writeHead(status, {
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

module.exports = { send, readBody, httpError };
