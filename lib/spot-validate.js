// Spot と素材の検査・整形（ガイドさんページの保存と移行スクリプトで共通）。体験者の画面や LLM のプロンプトに入るので、知らない項目は残さない
'use strict';

const { httpError } = require('./http');

const KINDS = ['landmark', 'gate', 'bridge', 'trees', 'water', 'view', 'garden', 'rest', 'other'];
const TYPES = ['fact', 'story', 'sense', 'notice', 'must'];
const TOPICS = ['plant', 'history', 'culture', 'nature', 'birds', 'water', 'view', 'senses', 'safety'];
const INTERACTIONS = ['LOOK', 'LISTEN', 'WALK', 'STOP', 'REST', 'SILENCE'];

const now = () => new Date().toISOString();
const str = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function cleanMaterial(m, fallbackSource = 'guide') {
  const text = str(m && m.text);
  if (!text) return null;
  return {
    ...(str(m.id, 80) ? { id: str(m.id, 80) } : {}),
    type: TYPES.includes(m.type) ? m.type : 'fact',
    text,
    lang: m.lang === 'en' ? 'en' : 'ja',
    topics: (Array.isArray(m.topics) ? m.topics : []).filter((t) => TOPICS.includes(t)),
    source: ['seed', 'osm', 'guide', 'recording'].includes(m.source) ? m.source : fallbackSource,
    author: str(m.author, 60),
    verified: m.verified === true,
    createdAt: typeof m.createdAt === 'string' ? m.createdAt : now(),
  };
}

function cleanInteractions(list) {
  return (Array.isArray(list) ? list : [])
    .filter((i) => i && INTERACTIONS.includes(i.type))
    .map((i) => {
      const o = { type: i.type };
      if (i.type === 'SILENCE') o.seconds = clamp(Number(i.seconds) || 60, 10, 600);
      if (i.text && (str(i.text.ja) || str(i.text.en))) o.text = { ja: str(i.text.ja, 300), en: str(i.text.en, 300) };
      return o;
    });
}

function normalizeSpot(sp, id) {
  if (!sp || typeof sp !== 'object') throw httpError(400, 'invalid spot');
  if (!Number.isFinite(sp.lat) || !Number.isFinite(sp.lng) || Math.abs(sp.lat) > 90 || Math.abs(sp.lng) > 180) throw httpError(400, 'invalid position');
  const name = { ja: str(sp.name && sp.name.ja, 100), en: str(sp.name && sp.name.en, 100) };
  if (!name.ja && !name.en) throw httpError(400, 'name required');
  const used = new Set();
  const materials = (Array.isArray(sp.materials) ? sp.materials : []).map((m) => cleanMaterial(m)).filter(Boolean);
  for (const m of materials) {
    if (m.id && !used.has(m.id)) { used.add(m.id); continue; }
    let n = materials.length;
    do { n++; m.id = `${id}-m${n}`; } while (used.has(m.id));
    used.add(m.id);
  }
  const out = {
    id,
    ...(Number.isFinite(sp.order) ? { order: sp.order } : {}),
    enabled: sp.enabled !== false,
    name,
    kind: KINDS.includes(sp.kind) ? sp.kind : 'other',
    lat: +sp.lat.toFixed(6),
    lng: +sp.lng.toFixed(6),
    radius: clamp(Math.round(Number(sp.radius) || 40), 15, 100),
    materials,
    interactions: cleanInteractions(sp.interactions),
    osm: sp.osm && typeof sp.osm === 'object' ? sp.osm : null,
  };
  return out;
}

function validateSpots(spots) {
  if (!Array.isArray(spots)) throw httpError(400, 'spots must be an array');
  const ids = new Set();
  for (const sp of spots) {
    if (!sp || typeof sp !== 'object' || Array.isArray(sp)) throw httpError(400, 'invalid spot');
    if (!sp.id || !Number.isFinite(sp.lat) || !Number.isFinite(sp.lng) || !sp.name) throw httpError(400, 'invalid spot');
    const id = String(sp.id);
    if (ids.has(id)) throw httpError(400, 'duplicate id');
    ids.add(id);
  }
}

const checkSpotId = (id) => { if (!/^[a-z0-9-]{1,60}$/.test(id)) throw httpError(400, 'invalid id'); };

/** Spot の一覧をまとめて保存するとき: 1 件ずつ PUT /api/guide/spots/:id と同じ検査・整形を通す */
function normalizeSpotList(list) {
  validateSpots(list);
  return list.map((sp) => {
    const id = String(sp.id);
    checkSpotId(id);
    return normalizeSpot({ ...sp, id }, id);
  });
}

module.exports = { KINDS, TYPES, TOPICS, INTERACTIONS, str, clamp, cleanMaterial, cleanInteractions, normalizeSpot, validateSpots, checkSpotId, normalizeSpotList };
