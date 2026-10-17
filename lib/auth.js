// 体験者セッション（購入コード）とガイドさん（共通の合言葉）の認証。メモリ保持でよい（Phase 1）。
'use strict';

const crypto = require('crypto');
const { GUIDE_PASSCODE } = require('./config');
const { httpError } = require('./http');
const { capSize } = require('./limits');

const SESSION_TTL_MS = 24 * 3600 * 1000;
const GUIDE_TTL_MS = 8 * 3600 * 1000;

const sessions = new Map(); // token -> { sessionId, code, createdAt }
const guideTokens = new Map(); // token -> createdAt

// 期限切れを消す。件数の上限を超えそうなら古いものから消す
function prune(map, ttlMs, createdAtOf) {
  const cutoff = Date.now() - ttlMs;
  for (const [token, v] of map) {
    if (createdAtOf(v) >= cutoff) break; // 追加順なので、ここから先は新しい
    map.delete(token);
  }
  capSize(map);
}

function createSession(code) {
  prune(sessions, SESSION_TTL_MS, (s) => s.createdAt);
  const token = crypto.randomBytes(16).toString('hex');
  const session = { sessionId: crypto.randomUUID(), code, createdAt: Date.now() };
  sessions.set(token, session);
  return { token, ...session };
}

function requireSession(req) {
  const s = sessions.get(req.headers['x-session-token']);
  if (!s || Date.now() - s.createdAt > SESSION_TTL_MS) throw httpError(401, 'no_session');
  return s;
}

// 長さが違っても比べる時間が変わらないよう、ハッシュにしてから比べる
const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();

function guideLogin(passcode) {
  if (!crypto.timingSafeEqual(digest(passcode || ''), digest(GUIDE_PASSCODE))) throw httpError(403, 'invalid_passcode');
  prune(guideTokens, GUIDE_TTL_MS, (createdAt) => createdAt);
  const token = crypto.randomBytes(16).toString('hex');
  guideTokens.set(token, Date.now());
  return token;
}

function requireGuide(req) {
  const createdAt = guideTokens.get(req.headers['x-guide-token']);
  if (!createdAt || Date.now() - createdAt > GUIDE_TTL_MS) throw httpError(401, 'guide_only');
}

module.exports = { createSession, requireSession, guideLogin, requireGuide, SESSION_TTL_MS, GUIDE_TTL_MS };
