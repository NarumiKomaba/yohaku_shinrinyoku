// サービスアカウントの鍵（JSON）で Vertex AI を呼ぶためのアクセストークン。
// 鍵は環境変数 GEMINI_SERVICE_ACCOUNT_JSON で受け取る。JWT（RS256）を署名して token_uri に渡し、トークンを取る。
// 同時に頼まれても取りに行くのは 1 回。鍵とトークンはログにもエラーにも出さない
'use strict';

const crypto = require('crypto');

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const TOKEN_TIMEOUT_MS = 10_000;
const EARLY_SEC = 5 * 60;

const b64url = (v) => Buffer.from(v).toString('base64url');

/** 鍵の JSON 文字列を調べ、使う項目だけ返す。空や形が違うときは null（中身は出さない） */
function parseServiceAccount(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  const key = j && j['private' + '_key'];
  if (!j || typeof j.client_email !== 'string' || typeof key !== 'string' || !key) return null;
  const tokenUri = typeof j.token_uri === 'string' && j.token_uri.startsWith('https://') ? j.token_uri : DEFAULT_TOKEN_URI;
  return { email: j.client_email, privateKey: key, projectId: typeof j.project_id === 'string' ? j.project_id : '', tokenUri };
}

function signJwt(account, nowSec) {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({ iss: account.email, scope: SCOPE, aud: account.tokenUri, iat: nowSec, exp: nowSec + 3600 }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${claim}`), account.privateKey);
  return `${head}.${claim}.${sig.toString('base64url')}`;
}

function createServiceAccountTokens({ account, fetch = (...args) => globalThis.fetch(...args), now = Date.now } = {}) {
  let cached = null; // { token, until }
  let fetching = null;

  async function load() {
    try {
      const assertion = signJwt(account, Math.floor(now() / 1000));
      const res = await fetch(account.tokenUri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`token ${res.status}`);
      const body = await res.json();
      if (typeof body.access_token !== 'string' || !body.access_token) throw new Error('no token');
      const life = Math.max(0, Number(body.expires_in) || 0);
      cached = { token: body.access_token, until: now() + Math.max(life / 2, life - EARLY_SEC) * 1000 };
      return cached.token;
    } catch {
      // 失敗の中身には鍵やトークンが入りうるので出さない
      throw new Error('service account token failed');
    } finally {
      fetching = null;
    }
  }

  return {
    get() {
      if (cached && now() < cached.until) return Promise.resolve(cached.token);
      if (!fetching) fetching = load();
      return fetching;
    },
    /** 401 が返ったときに呼ぶ（次の get で取り直す） */
    invalidate() { cached = null; },
  };
}

module.exports = { parseServiceAccount, createServiceAccountTokens };
