// 体験者セッション（購入コード）とガイドさん（共通の合言葉）の認証。メモリ保持でよい（Phase 1）。
'use strict';

const crypto = require('crypto');
const { GUIDE_PASSCODE } = require('./config');
const { httpError } = require('./http');

const sessions = new Map(); // token -> { sessionId, code, createdAt }
const guideTokens = new Set();

function createSession(code) {
  const token = crypto.randomBytes(16).toString('hex');
  const session = { sessionId: crypto.randomUUID(), code, createdAt: Date.now() };
  sessions.set(token, session);
  return { token, ...session };
}

function requireSession(req) {
  const s = sessions.get(req.headers['x-session-token']);
  if (!s) throw httpError(401, 'no_session');
  return s;
}

function guideLogin(passcode) {
  const a = Buffer.from(String(passcode || ''));
  const b = Buffer.from(GUIDE_PASSCODE);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw httpError(403, 'invalid_passcode');
  const token = crypto.randomBytes(16).toString('hex');
  guideTokens.add(token);
  return token;
}

function requireGuide(req) {
  if (!guideTokens.has(req.headers['x-guide-token'])) throw httpError(401, 'guide_only');
}

module.exports = { createSession, requireSession, guideLogin, requireGuide };
