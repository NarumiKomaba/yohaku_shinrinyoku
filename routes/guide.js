// ガイドさんページ用 API: Spot と素材の登録・編集、文字起こし、録音ウォーク
// 担当: implementer-guide
'use strict';

const crypto = require('crypto');
const { MODEL, SPOTS_READ_ONLY } = require('../lib/config');
const { readBody, httpError } = require('../lib/http');
const { getSpots, updateSpots, appendEvents, createRecording, getRecording, getRecordingMeta, putRecordingChunk, setRecordingStatus } = require('../lib/store');
const { RECORDING_ID_RE, checkId, checkChunkIndex } = require('../lib/store/common');
const { requireGuide } = require('../lib/auth');
const { KINDS, TOPICS, str, clamp, cleanMaterial, cleanInteractions, normalizeSpot, normalizeSpotList, checkSpotId } = require('../lib/spot-validate');
const { callGemini, parseJson, costJpy } = require('../lib/gemini');

const AUDIO_LIMIT = 25_000_000;

const now = () => new Date().toISOString();

// お試し版と共有している Spot は、合言葉が弱い（既定か短い）あいだは読むだけ（lib/config.js の SPOTS_READ_ONLY）
function requireSpotEditor(req) {
  requireGuide(req);
  if (SPOTS_READ_ONLY) throw httpError(403, 'shared_spots_read_only');
}

function logUsage(purpose, usage) {
  return appendEvents([{ type: 'llm_usage', ts: now(), purpose, model: MODEL, ...usage, costJpy: costJpy(usage) }]);
}

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
  await logUsage('guide_transcribe', usage);
  return text.trim();
}

// 録音ウォーク用: 発話ごとの開始秒つきで返させる
async function transcribeSegments({ audioBase64, mimeType, lang, durationSec }) {
  const system = `You are a verbatim transcriber for a guide's field recording (expected language: ${LANG_NAME[lang] || 'Japanese'}, English words may be mixed in). Split the speech into utterances and return JSON only: {"segments":[{"start":<seconds from the start of the audio>,"end":<seconds>,"text":"<exact words>"}]}. Do not summarize, translate, correct, or add anything. Ignore wind, footsteps and silence. If there is no speech, return {"segments":[]}.`;
  const { text, usage } = await callGemini({ system, contents: [{ role: 'user', parts: [audioPart(audioBase64, mimeType), { text: 'Transcribe.' }] }], maxTokens: 8000, temperature: 0, json: true, timeoutMs: 90000, metered: false });
  await logUsage('guide_record_transcribe', usage);
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
    await logUsage('guide_extract', usage);
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
const checkRid = (rid) => checkId(RECORDING_ID_RE, rid, 'recording id');
// load は getRecording（chunk も読む）か getRecordingMeta（本体だけ）
async function loadRec(rid, load = getRecording) {
  const rec = await load(checkRid(rid));
  if (!rec) throw httpError(404, 'recording not found');
  return rec;
}

// 音声がごく短い（終了直前の切れ端など）場合は文字起こしを省き、軌跡だけ受け取る。失敗しても軌跡は残す
async function transcribeChunk(body, startedMs, durationSec) {
  if (typeof body.audioBase64 !== 'string' || body.audioBase64.length < 100) return { segments: [] };
  try {
    const segs = await transcribeSegments({ audioBase64: body.audioBase64, mimeType: body.mimeType, lang: body.lang, durationSec });
    return { segments: segs.map((s) => ({ t0: startedMs + s.s0 * 1000, t1: startedMs + s.s1 * 1000, text: s.text })) };
  } catch (e) {
    if (e.status && e.status < 500) throw e;
    console.error('[guide/recordings/chunk]', e.message);
    return { segments: [], error: 'transcribe_failed' };
  }
}

function cleanTrack(track) {
  return (Array.isArray(track) ? track : []).slice(0, 5000)
    .filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.lat) && Number.isFinite(p.lng))
    .map((p) => ({ t: p.t, lat: p.lat, lng: p.lng, acc: Number.isFinite(p.acc) ? p.acc : 30 }));
}

// 録音から候補を作る（保存は呼び出し側）
async function buildCandidates(rec) {
  const segments = rec.chunks.flatMap((c) => c.segments);
  const { spots } = await getSpots();
  const found = detectPlaces(rec.track, segments).slice(0, 15);
  let extracted = [];
  if (found.length) {
    const system = `You turn a nature guide's spoken notes, recorded while walking in Kokyo Gaien, Tokyo, into registered "materials". Each numbered place has the guide's transcript.\n${EXTRACT_RULES}\nReturn JSON only: {"places":[{"index":0,"name":{"ja":"","en":""}?,"kind"?:"","materials":[{"type":"","text":"","topics":[]}],"interactions":[{"type":""}]}]}`;
    const user = found.map((c, i) => `[${i}]\n${c.transcript}`).join('\n\n');
    try {
      const { text, usage } = await callGemini({ system, contents: [{ role: 'user', parts: [{ text: user }] }], maxTokens: 4000, temperature: 0.2, json: true, timeoutMs: 60000, metered: false });
      await logUsage('guide_record_extract', usage);
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
  return candidates;
}

// 新しい Spot の一覧を作る（今の一覧は変えない）。order は指定がなければ、既存なら元の値、新規なら最後
function upsertSpot(spots, sp) {
  const prev = spots.find((s) => s.id === sp.id);
  const order = sp.order !== undefined ? sp.order : prev ? prev.order : Math.max(0, ...spots.map((s) => s.order || 0)) + 1;
  const saved = order === undefined ? sp : { ...sp, order };
  return { saved, created: !prev, spots: prev ? spots.map((s) => (s.id === sp.id ? saved : s)) : [...spots, saved] };
}

// ---------- 録音ウォークの finish ----------
// finish を始めたのが自分かを見分ける印（同じミリ秒に 2 回押されても区別できるよう乱数にする）
const newFinishToken = () => crypto.randomBytes(8).toString('hex');

/**
 * 自分が finishing にした録音だけを recording に戻す（すぐ押し直せるように）。version があればそれを条件に書き、
 * なければ読み直して自分の印（finishToken）か確かめる。戻せなくても 5 分たてばやり直せる
 */
async function revertFinishing(rid, { token, version }) {
  try {
    let ifVersion = version;
    if (!ifVersion) {
      const r = await getRecordingMeta(rid);
      if (!r || r.status !== 'finishing' || r.finishToken !== token) return;
      ifVersion = r.version;
    }
    await setRecordingStatus(rid, { status: 'recording' }, { ifStatus: 'finishing', ifVersion });
  } catch { /* 戻せなくてもよい */ }
}

/**
 * 読んだときの状態のままなら finishing にする（同時に押されても、候補を作るのは 1 回だけ）。version を渡すので保存先は読み直さない。
 * 書けなかったら読み直す: 自分の書き込みが（再試行で）もう入っていればそのまま、読んだあとに chunk が届いていれば新しい内容でもう 1 回
 */
async function startFinishing(rec) {
  const token = newFinishToken();
  const patch = () => ({ status: 'finishing', finishingAt: now(), finishToken: token });
  const version = await setRecordingStatus(rec.id, patch(), { ifStatus: rec.status, ifVersion: rec.version });
  if (version) return { current: rec, version, token };
  const again = await loadRec(rec.id);
  if (again.status === 'finishing' && again.finishToken === token) return { current: again, version: again.version, token };
  if (again.status === 'recording') {
    const retried = await setRecordingStatus(rec.id, patch(), { ifStatus: 'recording', ifVersion: again.version });
    if (retried) return { current: again, version: retried, token };
  }
  throw httpError(409, 'finishing');
}

// 候補を保存し、軌跡を消す（保存先が chunk を検索して全部消す）。書けなければ、自分の書き込みが入っていないか確かめてから戻す
async function saveFinished(rid, { version, token }, candidates) {
  const finishedAt = now();
  let done;
  try {
    done = await setRecordingStatus(rid, { status: 'finished', finishedAt, candidates }, { ifStatus: 'finishing', ifVersion: version, dropTrack: true });
  } catch (e) {
    await revertFinishing(rid, { token });
    throw e;
  }
  if (done) return;
  const after = await getRecordingMeta(rid).catch(() => null);
  if (after && after.status === 'finished' && after.finishedAt === finishedAt) return;
  await revertFinishing(rid, { token });
  throw httpError(409, 'finish_conflict');
}

module.exports = {
  'PUT /api/spots': async (req) => {
    requireSpotEditor(req);
    const body = await readBody(req);
    const spots = normalizeSpotList(body.spots);
    await updateSpots((current) => ({ ...current, spots }));
    return { ok: true, count: spots.length };
  },

  'PUT /api/guide/spots/:id': async (req, params) => {
    requireSpotEditor(req);
    checkSpotId(params.id);
    const body = await readBody(req);
    const sp = normalizeSpot(body.spot || body, params.id);
    // 保存が重なると fn をやり直すことがあるので、返すのは最後に呼ばれたときの結果
    let result;
    await updateSpots((data) => {
      result = upsertSpot(data.spots, sp);
      return { ...data, spots: result.spots };
    });
    return { ok: true, spot: result.saved, created: result.created };
  },

  'DELETE /api/guide/spots/:id': async (req, params) => {
    requireSpotEditor(req);
    checkSpotId(params.id);
    await updateSpots((data) => {
      if (!data.spots.some((s) => s.id === params.id)) throw httpError(404, 'spot not found');
      return { ...data, spots: data.spots.filter((s) => s.id !== params.id) };
    });
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
    if (spotId) spot = (await getSpots()).spots.find((s) => s.id === spotId) || null;
    return extractMaterials({ transcript: t, lang, spot });
  },

  'POST /api/guide/recordings': async (req) => {
    requireGuide(req);
    const rec = { id: crypto.randomUUID(), createdAt: now(), status: 'recording', candidates: [] };
    await createRecording(rec);
    return { recordingId: rec.id };
  },

  'POST /api/guide/recordings/:rid/chunk': async (req, params) => {
    requireGuide(req);
    const rid = checkRid(params.rid); // body を読む前に
    const body = await readBody(req, AUDIO_LIMIT);
    const rec = await getRecordingMeta(rid);
    if (!rec) throw httpError(404, 'recording not found');
    if (rec.status !== 'recording') throw httpError(409, 'recording already finished');
    const startedMs = Date.parse(body.startedAt);
    if (!Number.isFinite(startedMs)) throw httpError(400, 'startedAt required');
    const index = checkChunkIndex(Number(body.index));
    const durationSec = Number(body.durationSec) || 0;
    const chunk = { index, startedAt: body.startedAt, durationSec, ...(await transcribeChunk(body, startedMs, durationSec)) };
    // 音声は保存しない。軌跡は同じ時刻の点を除いて足す（保存先が受け持つ）。
    // 読んだときの version を渡すので、文字起こしの間に finish されていれば 409 で、何も書かない
    await putRecordingChunk(rid, chunk, cleanTrack(body.track), { ifVersion: rec.version });
    return { ok: !chunk.error, index, segments: chunk.segments.length, ...(chunk.error ? { error: chunk.error } : {}) };
  },

  'POST /api/guide/recordings/:rid/finish': async (req, params) => {
    requireGuide(req);
    const rec = await loadRec(params.rid);
    if (rec.status === 'finished') return { candidates: rec.candidates };
    // finishing のままプロセスが落ちた場合に備え、5 分以上前なら再実行を許可する
    if (rec.status === 'finishing' && Date.now() - Date.parse(rec.finishingAt || 0) < 5 * 60_000) throw httpError(409, 'finishing');
    const started = await startFinishing(rec);
    let candidates;
    try {
      candidates = await buildCandidates(started.current);
    } catch (e) {
      await revertFinishing(rec.id, started);
      throw e;
    }
    await saveFinished(rec.id, started, candidates);
    return { candidates };
  },

  'GET /api/guide/recordings/:rid': async (req, params) => {
    requireGuide(req);
    const rec = await loadRec(params.rid);
    return {
      id: rec.id, status: rec.status, createdAt: rec.createdAt,
      chunks: rec.chunks.map((c) => ({ index: c.index, durationSec: c.durationSec, segments: c.segments.length, error: c.error || null })),
      candidates: rec.candidates,
    };
  },
};

// ルート登録（Object.entries）に混ざらないよう非列挙で公開
Object.defineProperty(module.exports, '_test', { value: { detectPlaces, normalizeSpot }, enumerable: false });
