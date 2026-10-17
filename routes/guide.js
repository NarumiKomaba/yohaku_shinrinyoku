// ガイドさんページ用 API: Spot と素材の登録・編集、文字起こし、録音ウォーク
// 担当: implementer-guide
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MODEL, LOG_DIR } = require('../lib/config');
const { readBody, httpError } = require('../lib/http');
const { readData, writeData, appendEvents } = require('../lib/store');
const { requireGuide } = require('../lib/auth');
const { callGemini, parseJson, costJpy } = require('../lib/gemini');

const AUDIO_LIMIT = 25_000_000;
const REC_DIR = path.join(LOG_DIR, 'recordings');
const KINDS = ['landmark', 'gate', 'bridge', 'trees', 'water', 'view', 'garden', 'rest', 'other'];
const TYPES = ['fact', 'story', 'sense', 'notice', 'must'];
const TOPICS = ['plant', 'history', 'culture', 'nature', 'birds', 'water', 'view', 'senses', 'safety'];
const INTERACTIONS = ['LOOK', 'LISTEN', 'WALK', 'STOP', 'REST', 'SILENCE'];

const now = () => new Date().toISOString();
const str = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function logUsage(purpose, usage) {
  appendEvents([{ type: 'llm_usage', ts: now(), purpose, model: MODEL, ...usage, costJpy: costJpy(usage) }]);
}

// ---------- 検証・整形 ----------
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
  for (const sp of spots) {
    if (!sp.id || !Number.isFinite(sp.lat) || !Number.isFinite(sp.lng) || !sp.name) throw httpError(400, `invalid spot: ${sp.id || '(no id)'}`);
  }
}

const checkSpotId = (id) => { if (!/^[a-z0-9-]{1,60}$/.test(id)) throw httpError(400, 'invalid id'); };

// ---------- 音声 → 文字 ----------
function audioPart(audioBase64, mimeType) {
  const mime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (!/^audio\/[a-z0-9.+-]+$/.test(mime)) throw httpError(400, 'invalid mimeType');
  if (typeof audioBase64 !== 'string' || audioBase64.length < 100) throw httpError(400, 'audio too short');
  return { inlineData: { mimeType: mime, data: audioBase64 } };
}

const LANG_NAME = { ja: 'Japanese', en: 'English' };

async function transcribeAudio({ audioBase64, mimeType, lang }) {
  const system = `You are a verbatim transcriber. Transcribe the speech in the audio exactly as spoken (expected language: ${LANG_NAME[lang] || 'Japanese'}, English words may be mixed in). Do not summarize, translate, correct facts, or add anything. Output the plain transcript only. If there is no speech, output an empty string.`;
  const { text, usage } = await callGemini({ system, contents: [{ role: 'user', parts: [audioPart(audioBase64, mimeType), { text: 'Transcribe.' }] }], maxTokens: 4000, temperature: 0, timeoutMs: 60000, metered: false });
  logUsage('guide_transcribe', usage);
  return text.trim();
}

// 録音ウォーク用: 発話ごとの開始秒つきで返させる
async function transcribeSegments({ audioBase64, mimeType, lang, durationSec }) {
  const system = `You are a verbatim transcriber for a guide's field recording (expected language: ${LANG_NAME[lang] || 'Japanese'}, English words may be mixed in). Split the speech into utterances and return JSON only: {"segments":[{"start":<seconds from the start of the audio>,"end":<seconds>,"text":"<exact words>"}]}. Do not summarize, translate, correct, or add anything. Ignore wind, footsteps and silence. If there is no speech, return {"segments":[]}.`;
  const { text, usage } = await callGemini({ system, contents: [{ role: 'user', parts: [audioPart(audioBase64, mimeType), { text: 'Transcribe.' }] }], maxTokens: 8000, temperature: 0, json: true, timeoutMs: 90000, metered: false });
  logUsage('guide_record_transcribe', usage);
  const list = (parseJson(text).segments || []).filter((s) => s && str(s.text));
  const total = Number(durationSec) || 0;
  // 時刻が信頼できない（全部 0 や範囲外）場合は、文字数に比例して全体へ配分する
  const starts = list.map((s) => Number(s.start));
  const reliable = list.length > 0 && starts.every((v) => Number.isFinite(v) && v >= 0 && (!total || v <= total + 5)) && new Set(starts).size > 1 || list.length === 1;
  if (reliable) return list.map((s, i) => ({ s0: Number(s.start), s1: Number.isFinite(Number(s.end)) ? Number(s.end) : (starts[i + 1] ?? Number(s.start) + 5), text: str(s.text) }));
  const sum = list.reduce((a, s) => a + str(s.text).length, 0) || 1;
  let acc = 0;
  return list.map((s) => {
    const t = str(s.text);
    const seg = { s0: (acc / sum) * total, s1: ((acc + t.length) / sum) * total, text: t };
    acc += t.length;
    return seg;
  });
}

// ---------- 話した内容 → 素材 ----------
const EXTRACT_RULES = `Rules:
- Use ONLY what the guide actually said. Never add facts, numbers, dates, names or explanations that are not in the transcript.
- Split into short materials (1-3 sentences each, keep the guide's wording, light cleanup of fillers only). Keep the language the guide spoke.
- type: fact (a fact), story (an anecdote), sense (an invitation to use the senses), notice (a caution), must (something the guide says must be told). Use "must" only if the guide clearly says so.
- topics: any of ${TOPICS.join('|')}.
- "name" and "kind" (${KINDS.join('|')}) only if clearly implied by what was said; otherwise omit them.
- interactions: any of LOOK|LISTEN|WALK|STOP|REST|SILENCE only if the guide suggested such an action; otherwise [].`;

function sanitizeExtract(d, source = 'recording') {
  const out = {
    materials: (Array.isArray(d.materials) ? d.materials : []).map((m) => cleanMaterial({ ...m, source, verified: false, id: undefined })).filter(Boolean),
    interactions: cleanInteractions(d.interactions),
  };
  const ja = str(d.name && typeof d.name === 'object' ? d.name.ja : d.name, 100);
  const en = str(d.name && typeof d.name === 'object' ? d.name.en : '', 100);
  if (ja || en) out.name = { ja, en };
  if (KINDS.includes(d.kind)) out.kind = d.kind;
  return out;
}

async function extractMaterials({ transcript, lang, spot }) {
  const system = `You turn a nature guide's spoken notes into registered "materials" for one spot of a walk in Kokyo Gaien, Tokyo.\n${EXTRACT_RULES}\nReturn JSON only: {"name":{"ja":"","en":""}?,"kind"?:"","materials":[{"type":"","text":"","topics":[]}],"interactions":[{"type":""}]}`;
  const user = `${spot ? `Existing spot: ${spot.name.ja || spot.name.en}\nExisting materials (do not duplicate):\n${spot.materials.map((m) => `- ${m.text}`).join('\n') || '(none)'}\n` : ''}Transcript:\n${transcript}`;
  try {
    const { text, usage } = await callGemini({ system, contents: [{ role: 'user', parts: [{ text: user }] }], maxTokens: 1500, temperature: 0.2, json: true, timeoutMs: 40000, metered: false });
    logUsage('guide_extract', usage);
    const out = sanitizeExtract(parseJson(text));
    if (!out.materials.length) throw new Error('no materials');
    return { ...out, fallback: false };
  } catch (e) {
    // LLM 失敗時は文字起こし全文を 1 件の素材にする（ガイドさんが画面で直せる）
    return { materials: [cleanMaterial({ type: 'fact', text: transcript, lang: lang === 'en' ? 'en' : 'ja', source: 'recording' })], interactions: [], fallback: true };
  }
}

// ---------- 地理 ----------
const M_LAT = 111_320;
const mLng = (lat) => 111_320 * Math.cos((lat * Math.PI) / 180);
function dist(a, b) {
  const dy = (a.lat - b.lat) * M_LAT;
  const dx = (a.lng - b.lng) * mLng((a.lat + b.lat) / 2);
  return Math.hypot(dx, dy);
}
const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
function wmean(points) {
  let w = 0, la = 0, ln = 0;
  for (const p of points) {
    const a = Math.max(p.acc || 20, 5);
    const k = 1 / (a * a);
    w += k; la += p.lat * k; ln += p.lng * k;
  }
  return { lat: la / w, lng: ln / w };
}

/**
 * 軌跡と発話から「立ち止まって話した場所」を検出する。
 * 1) 直近 3 点の中央値で平滑化 → 中心から 20m 以内にとどまる区間のうち 20 秒以上を滞在とする
 * 2) 25m 以内・60 秒以内に連続する滞在は統合
 * 3) 発話を滞在（前後 10 秒の余裕）へ割り当て。外れた発話は 60 秒以内・40m 以内なら吸収、それ以外は歩きながらの候補
 * 4) 15 文字未満の候補は捨てる
 */
// 区間の前 1/3 と後ろ 1/3 の重心の移動速度。GPS のばらつきで止まっていても動いて見えるので、
// 累積距離ではなく重心の変位で見る。歩行（約 1.4 m/s）は弾き、立ち止まり・ゆっくり見回す程度を通す
const STAY_MAX_MPS = 0.6;
function slowEnough(pts) {
  const k = Math.max(1, Math.floor(pts.length / 3));
  const a = pts.slice(0, k), b = pts.slice(-k);
  const mid = (arr) => arr.reduce((x, p) => x + p.t, 0) / arr.length;
  const dt = (mid(b) - mid(a)) / 1000;
  if (dt <= 0) return true;
  return dist(wmean(a), wmean(b)) / dt < STAY_MAX_MPS;
}

function detectPlaces(track, segments) {
  const pts = track.filter((p) => !(p.acc > 60)).sort((a, b) => a.t - b.t);
  const sm = pts.map((p, i) => {
    const w = pts.slice(Math.max(0, i - 1), i + 2);
    return { t: p.t, acc: p.acc, lat: median(w.map((x) => x.lat)), lng: median(w.map((x) => x.lng)) };
  });
  let stays = [];
  let cur = [];
  const close = () => {
    if (cur.length >= 2 && cur[cur.length - 1].t - cur[0].t >= 20_000 && slowEnough(cur)) stays.push({ t0: cur[0].t, t1: cur[cur.length - 1].t, pts: cur });
    cur = [];
  };
  for (const p of sm) {
    if (cur.length && dist(p, wmean(cur)) > 20) close();
    cur.push(p);
  }
  close();
  const merged = [];
  for (const s of stays) {
    const last = merged[merged.length - 1];
    if (last && s.t0 - last.t1 <= 60_000 && dist(wmean(last.pts), wmean(s.pts)) <= 25) { last.t1 = s.t1; last.pts = last.pts.concat(s.pts); } else merged.push({ ...s });
  }
  stays = merged.map((s) => ({ ...s, center: wmean(s.pts), segs: [] }));

  const posAt = (t) => sm.reduce((best, p) => (!best || Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best), null);
  const walking = [];
  for (const sg of segments) {
    const tm = (sg.t0 + sg.t1) / 2;
    let st = stays.find((s) => tm >= s.t0 - 10_000 && tm <= s.t1 + 10_000);
    if (!st) {
      const p = posAt(tm);
      const gap = (s) => Math.min(Math.abs(tm - s.t0), Math.abs(tm - s.t1));
      const near = stays.filter((s) => gap(s) <= 60_000 && p && dist(p, s.center) <= 40).sort((a, b) => gap(a) - gap(b))[0];
      st = near;
    }
    if (st) { st.segs.push(sg); continue; }
    const p = posAt(tm);
    if (!p) continue;
    const last = walking[walking.length - 1];
    if (last && sg.t0 - last.t1 <= 30_000 && dist(last.pos, p) <= 25) { last.segs.push(sg); last.t1 = sg.t1; } else walking.push({ pos: p, t0: sg.t0, t1: sg.t1, segs: [sg] });
  }

  const cands = [];
  for (const s of stays) {
    const c = s.center;
    const sigma = Math.sqrt(s.pts.reduce((a, p) => a + dist(p, c) ** 2, 0) / s.pts.length);
    cands.push({ lat: c.lat, lng: c.lng, radius: Math.round(clamp(25 + sigma, 20, 50)), t0: s.t0, t1: s.t1, walking: false, segs: s.segs });
  }
  for (const w of walking) cands.push({ lat: w.pos.lat, lng: w.pos.lng, radius: 30, t0: w.t0, t1: w.t1, walking: true, segs: w.segs });
  return cands
    .map((c) => ({ ...c, transcript: c.segs.map((s) => s.text).join('\n') }))
    .filter((c) => c.transcript.replace(/\s/g, '').length >= 15)
    .sort((a, b) => a.t0 - b.t0);
}

function nearestSpot(spots, c, within = 30) {
  let best = null;
  for (const s of spots) {
    const d = dist(s, c);
    if (d <= within && (!best || d < best.d)) best = { id: s.id, d };
  }
  return best ? best.id : null;
}

// ---------- 録音ウォーク ----------
const recPath = (rid) => {
  if (!/^[0-9a-f-]{36}$/.test(rid)) throw httpError(400, 'invalid recording id');
  return path.join(REC_DIR, `${rid}.json`);
};
function loadRec(rid) {
  try { return JSON.parse(fs.readFileSync(recPath(rid), 'utf8')); } catch (e) { if (e.status) throw e; throw httpError(404, 'recording not found'); }
}
const saveRec = (rec) => fs.writeFileSync(recPath(rec.id), JSON.stringify(rec), 'utf8');

function cleanTrack(track) {
  return (Array.isArray(track) ? track : []).slice(0, 5000)
    .filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.lat) && Number.isFinite(p.lng))
    .map((p) => ({ t: p.t, lat: p.lat, lng: p.lng, acc: Number.isFinite(p.acc) ? p.acc : 30 }));
}

async function finishRecording(rec) {
  const segments = rec.chunks.flatMap((c) => c.segments);
  const spots = readData('spots.json').spots;
  const found = detectPlaces(rec.track, segments).slice(0, 15);
  let extracted = [];
  if (found.length) {
    const system = `You turn a nature guide's spoken notes, recorded while walking in Kokyo Gaien, Tokyo, into registered "materials". Each numbered place has the guide's transcript.\n${EXTRACT_RULES}\nReturn JSON only: {"places":[{"index":0,"name":{"ja":"","en":""}?,"kind"?:"","materials":[{"type":"","text":"","topics":[]}],"interactions":[{"type":""}]}]}`;
    const user = found.map((c, i) => `[${i}]\n${c.transcript}`).join('\n\n');
    try {
      const { text, usage } = await callGemini({ system, contents: [{ role: 'user', parts: [{ text: user }] }], maxTokens: 4000, temperature: 0.2, json: true, timeoutMs: 60000, metered: false });
      logUsage('guide_record_extract', usage);
      extracted = parseJson(text).places || [];
    } catch { /* フォールバックは下で */ }
  }
  const candidates = found.map((c, i) => {
    const ex = sanitizeExtract(extracted.find((p) => p && p.index === i) || {});
    const materials = ex.materials.length ? ex.materials : [cleanMaterial({ type: 'fact', text: c.transcript, source: 'recording' })];
    return {
      lat: +c.lat.toFixed(6), lng: +c.lng.toFixed(6), radius: c.radius,
      name: ex.name || { ja: `録音地点 ${i + 1}`, en: '' },
      kind: ex.kind || 'other',
      materials, interactions: ex.interactions,
      nearestSpotId: nearestSpot(spots, c),
      walking: c.walking, startedAt: new Date(c.t0).toISOString(), transcript: c.transcript,
    };
  });
  rec.status = 'finished';
  rec.finishedAt = now();
  rec.candidates = candidates;
  delete rec.track; // 軌跡の点列は残さず、候補だけ保存する
  saveRec(rec);
  return candidates;
}

module.exports = {
  'PUT /api/spots': async (req) => {
    requireGuide(req);
    const body = await readBody(req);
    validateSpots(body.spots);
    // 1 件ずつ PUT /api/guide/spots/:id と同じ検査・整形を通す（体験者の画面や LLM のプロンプトに入るため）
    const spots = body.spots.map((sp) => { checkSpotId(String(sp.id)); return normalizeSpot(sp, sp.id); });
    const current = readData('spots.json');
    writeData('spots.json', { ...current, spots });
    return { ok: true, count: spots.length };
  },

  'PUT /api/guide/spots/:id': async (req, params) => {
    requireGuide(req);
    checkSpotId(params.id);
    const body = await readBody(req);
    const sp = normalizeSpot(body.spot || body, params.id);
    const data = readData('spots.json');
    const i = data.spots.findIndex((s) => s.id === sp.id);
    if (i >= 0) {
      if (sp.order === undefined && data.spots[i].order !== undefined) sp.order = data.spots[i].order;
      data.spots[i] = sp;
    } else {
      if (sp.order === undefined) sp.order = Math.max(0, ...data.spots.map((s) => s.order || 0)) + 1;
      data.spots.push(sp);
    }
    writeData('spots.json', data);
    return { ok: true, spot: sp, created: i < 0 };
  },

  'DELETE /api/guide/spots/:id': (req, params) => {
    requireGuide(req);
    checkSpotId(params.id);
    const data = readData('spots.json');
    if (!data.spots.some((s) => s.id === params.id)) throw httpError(404, 'spot not found');
    writeData('spots.json', { ...data, spots: data.spots.filter((s) => s.id !== params.id) });
    return { ok: true };
  },

  'POST /api/guide/transcribe': async (req) => {
    requireGuide(req);
    const { audioBase64, mimeType, lang } = await readBody(req, AUDIO_LIMIT);
    try {
      return { text: await transcribeAudio({ audioBase64, mimeType, lang }) };
    } catch (e) {
      if (e.status) throw e;
      // 上流のエラー文（API の応答など）は画面に返さず、サーバーのログにだけ残す
      console.error('[guide/transcribe]', e.message);
      throw httpError(e.code === 'llm_daily_limit' ? 503 : 502, 'transcribe_failed');
    }
  },

  'POST /api/guide/extract': async (req) => {
    requireGuide(req);
    const { transcript, spotId, lang } = await readBody(req);
    const t = str(transcript, 8000);
    if (!t) throw httpError(400, 'transcript required');
    let spot = null;
    if (spotId) spot = readData('spots.json').spots.find((s) => s.id === spotId) || null;
    return extractMaterials({ transcript: t, lang, spot });
  },

  'POST /api/guide/recordings': (req) => {
    requireGuide(req);
    fs.mkdirSync(REC_DIR, { recursive: true });
    const rec = { id: crypto.randomUUID(), createdAt: now(), status: 'recording', chunks: [], track: [], candidates: [] };
    saveRec(rec);
    return { recordingId: rec.id };
  },

  'POST /api/guide/recordings/:rid/chunk': async (req, params) => {
    requireGuide(req);
    const body = await readBody(req, AUDIO_LIMIT);
    if (loadRec(params.rid).status !== 'recording') throw httpError(409, 'recording already finished');
    const startedMs = Date.parse(body.startedAt);
    if (!Number.isFinite(startedMs)) throw httpError(400, 'startedAt required');
    const index = Number(body.index);
    if (!Number.isInteger(index) || index < 0) throw httpError(400, 'index required');
    const durationSec = Number(body.durationSec) || 0;
    const chunk = { index, startedAt: body.startedAt, durationSec, segments: [] };
    // 音声がごく短い（終了直前の切れ端など）場合は文字起こしを省き、軌跡だけ受け取る
    if (typeof body.audioBase64 === 'string' && body.audioBase64.length >= 100) {
      try {
        const segs = await transcribeSegments({ audioBase64: body.audioBase64, mimeType: body.mimeType, lang: body.lang, durationSec });
        chunk.segments = segs.map((s) => ({ t0: startedMs + s.s0 * 1000, t1: startedMs + s.s1 * 1000, text: s.text }));
      } catch (e) {
        if (e.status && e.status < 500) throw e;
        console.error('[guide/recordings/chunk]', e.message);
        chunk.error = 'transcribe_failed';
      }
    }
    // 音声は保存しない。文字起こしの間に状態が変わりうるので再読込して追記する
    const rec = loadRec(params.rid);
    rec.chunks = rec.chunks.filter((c) => c.index !== index).concat(chunk).sort((a, b) => a.index - b.index);
    const have = new Set(rec.track.map((p) => p.t));
    rec.track = rec.track.concat(cleanTrack(body.track).filter((p) => !have.has(p.t)));
    saveRec(rec);
    return { ok: !chunk.error, index, segments: chunk.segments.length, ...(chunk.error ? { error: chunk.error } : {}) };
  },

  'POST /api/guide/recordings/:rid/finish': async (req, params) => {
    requireGuide(req);
    const rec = loadRec(params.rid);
    if (rec.status === 'finished') return { candidates: rec.candidates };
    // finishing のままプロセスが落ちた場合に備え、5 分以上前なら再実行を許可する
    if (rec.status === 'finishing' && Date.now() - Date.parse(rec.finishingAt || 0) < 5 * 60_000) throw httpError(409, 'finishing');
    rec.status = 'finishing';
    rec.finishingAt = now();
    saveRec(rec);
    try {
      return { candidates: await finishRecording(rec) };
    } catch (e) {
      rec.status = 'recording';
      saveRec(rec);
      throw e;
    }
  },

  'GET /api/guide/recordings/:rid': (req, params) => {
    requireGuide(req);
    const rec = loadRec(params.rid);
    return {
      id: rec.id, status: rec.status, createdAt: rec.createdAt,
      chunks: rec.chunks.map((c) => ({ index: c.index, durationSec: c.durationSec, segments: c.segments.length, error: c.error || null })),
      candidates: rec.candidates,
    };
  },
};

// ルート登録（Object.entries）に混ざらないよう非列挙で公開
Object.defineProperty(module.exports, '_test', { value: { detectPlaces, normalizeSpot }, enumerable: false });
