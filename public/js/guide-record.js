// ガイドさんページ: A「ここで登録」と B「録音ウォーク」
// 担当: implementer-guide
import { $, h, state, api, commitSpot, nearbySpots, spotName, toast, materialsEditor, KINDS, pickMime, openMic, recordSegment, blobToBase64, stopStream, keepAwake } from './guide-core.js';

const GPS_MS = 10_000;
const CHUNK_MS = (Number(new URLSearchParams(location.search).get('chunkSec')) || 300) * 1000; // 約 5 分（確認用に ?chunkSec= で変更可）
let hooks = { goMap: () => {}, showCandidates: () => {} };

export function initRecord(h2) {
  hooks = h2;
  renderHere();
  renderWalk();
}

const langSelect = (cur, onchange) => h('select', { onchange: (e) => onchange(e.target.value) },
  h('option', { value: 'ja', selected: cur === 'ja' }, '日本語で話す'), h('option', { value: 'en', selected: cur === 'en' }, 'English'));

const PRIVACY = '録音は文字起こしのあとすぐ破棄し、保存しません。周りの人の声が入らないよう、少し離れて小声でなく普通に話してください。';

// =====================================================================
// A. ここで登録
// =====================================================================
const A = { step: 'start', pos: null, target: '', lang: 'ja', transcript: '', ext: null, busy: '', gps: null, rec: null, stream: null, recTimer: null, recSec: 0 };

function measureGps(onTick) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('位置情報が使えません'));
    const samples = [];
    const t0 = Date.now();
    let err = null;
    const id = navigator.geolocation.watchPosition(
      (p) => { samples.push({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy || 50 }); onTick(samples, Date.now() - t0); },
      (e) => { err = e; },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
    const tick = setInterval(() => onTick(samples, Date.now() - t0), 500);
    A.gps = { cancel: () => { clearInterval(tick); clearTimeout(end); navigator.geolocation.clearWatch(id); reject(new Error('cancel')); } };
    const end = setTimeout(() => {
      clearInterval(tick);
      navigator.geolocation.clearWatch(id);
      if (!samples.length) return reject(new Error(err ? `位置を取得できません: ${err.message}` : '位置を取得できませんでした'));
      resolve(averagePos(samples));
    }, GPS_MS);
  });
}

// 精度の悪い点（50m 超）は除き、精度の逆二乗で重み付け平均
function averagePos(samples) {
  const good = samples.filter((s) => s.acc <= 50);
  const use = good.length ? good : [samples.reduce((a, b) => (a.acc < b.acc ? a : b))];
  let w = 0, la = 0, ln = 0;
  for (const s of use) { const k = 1 / (Math.max(s.acc, 3) ** 2); w += k; la += s.lat * k; ln += s.lng * k; }
  return { lat: la / w, lng: ln / w, acc: Math.sqrt(1 / w), n: use.length, total: samples.length };
}

function setA(patch) { Object.assign(A, patch); renderHere(); }

function renderHere() {
  const root = $('#here-body');
  const steps = {
    start: () => [
      h('p', { text: 'いま立っている場所に、お話しした内容を素材として登録します。' }),
      h('button', { class: 'primary big', onclick: startGps }, 'ここで登録（位置を約10秒測る）'),
    ],
    gps: () => [
      h('p', { id: 'gps-status', text: '位置を測っています…その場で動かずにお待ちください' }),
      h('div', { class: 'bar' }, h('div', { id: 'gps-bar' })),
      h('button', { class: 'ghost', onclick: () => { if (A.gps) A.gps.cancel(); } }, 'やめる'),
    ],
    target: () => {
      const near = nearbySpots(A.pos, 30);
      return [
        h('p', { class: 'ok', text: `位置: 精度 ±${Math.round(A.pos.acc)}m（${A.pos.n} サンプル）` }),
        A.pos.acc > 25 ? h('p', { class: 'warn', text: '精度がやや低めです。木の下や建物の近くでは ±15m 前後になります。必要なら測り直してください。' }) : null,
        near.length ? h('p', { text: '近くに登録済みの Spot があります:' }) : h('p', { class: 'hint', text: '30m 以内に登録済みの Spot はありません。' }),
        ...near.map(({ spot, d }) => h('button', { class: 'choice', onclick: () => setA({ step: 'input', target: spot.id }) }, `「${spotName(spot)}」に素材を追加（${Math.round(d)}m）`)),
        h('button', { class: 'choice', onclick: () => setA({ step: 'input', target: '' }) }, '新しい Spot として登録'),
        h('button', { class: 'ghost', onclick: startGps }, '測り直す'),
      ];
    },
    input: () => [
      h('p', { class: 'ok', text: A.target ? `追加先: 「${spotName(state.spots.find((s) => s.id === A.target))}」` : '新しい Spot として登録' }),
      h('p', { class: 'hint', text: `ここで気づいたこと・伝えたいことを話してください（話したこと以外は素材になりません）。${PRIVACY}` }),
      h('div', { class: 'row' }, langSelect(A.lang, (v) => { A.lang = v; })),
      A.rec
        ? h('button', { class: 'rec on big', onclick: stopHereRec }, `■ 録音を止める（${A.recSec}秒）`)
        : h('button', { class: 'rec big', onclick: startHereRec, disabled: !!A.busy }, '● 録音して話す'),
      A.busy ? h('p', { class: 'hint', text: A.busy }) : null,
      h('textarea', { id: 'here-text', rows: 6, placeholder: '録音すると文字起こしがここに入ります。直接入力・修正もできます。', value: A.transcript, oninput: (e) => { A.transcript = e.target.value; } }),
      h('div', { class: 'actions' },
        h('button', { class: 'primary', disabled: !!A.busy, onclick: extract }, '素材に分解する'),
        h('button', { class: 'ghost', onclick: () => setA({ step: 'target' }) }, '戻る')),
    ],
    review: () => reviewView(),
    done: () => [
      h('p', { class: 'ok', text: `保存しました: ${A.savedName}` }),
      h('div', { class: 'actions' },
        h('button', { class: 'primary', onclick: () => hooks.goMap(A.savedId) }, '地図で見る'),
        h('button', { class: 'ghost', onclick: () => setA({ step: 'start', transcript: '', ext: null, target: '', pos: null }) }, '続けて登録')),
    ],
  };
  root.replaceChildren(...steps[A.step]().filter(Boolean));
}

async function startGps() {
  setA({ step: 'gps' });
  try {
    const pos = await measureGps((samples, ms) => {
      const bar = $('#gps-bar'); const st = $('#gps-status');
      if (!bar || !st) return;
      bar.style.width = `${Math.min(100, (ms / GPS_MS) * 100)}%`;
      const best = samples.length ? Math.min(...samples.map((s) => s.acc)) : null;
      st.textContent = `位置を測っています… ${Math.ceil((GPS_MS - ms) / 1000)}秒 ／ ${samples.length} サンプル${best ? ` ／ 最良 ±${Math.round(best)}m` : ''}`;
    });
    setA({ step: 'target', pos });
  } catch (e) {
    if (e.message !== 'cancel') toast(e.message, true);
    setA({ step: 'start' });
  }
}

async function startHereRec() {
  try {
    A.stream = await openMic();
    A.rec = recordSegment(A.stream);
    A.recSec = 0;
    A.recTimer = setInterval(() => { A.recSec++; const b = $('#here-body .rec'); if (b) b.textContent = `■ 録音を止める（${A.recSec}秒）`; }, 1000);
    renderHere();
  } catch (e) { toast(`マイクを使えません: ${e.message}`, true); }
}

async function stopHereRec() {
  clearInterval(A.recTimer);
  const rec = A.rec;
  A.rec = null;
  setA({ busy: '文字起こし中…' });
  try {
    const blob = await rec.stop();
    stopStream(A.stream);
    if (blob.size < 1000) throw new Error('録音が短すぎます');
    const { text } = await api('POST', '/api/guide/transcribe', { audioBase64: await blobToBase64(blob), mimeType: blob.type, lang: A.lang });
    setA({ busy: '', transcript: [A.transcript, text].filter(Boolean).join('\n') });
    if (!text) toast('話し声が聞き取れませんでした', true);
  } catch (e) {
    setA({ busy: '' });
    toast(`文字起こしに失敗: ${e.message}`, true);
  }
}

async function extract() {
  const t = A.transcript.trim();
  if (!t) return toast('話した内容（または入力）がありません', true);
  setA({ busy: '素材に分解しています…' });
  try {
    const ext = await api('POST', '/api/guide/extract', { transcript: t, lat: A.pos.lat, lng: A.pos.lng, spotId: A.target || undefined, lang: A.lang });
    for (const m of ext.materials) m.verified = true; // この確認画面でガイドさんが確認する
    if (ext.fallback) toast('自動の分解ができなかったため、全文を 1 つの素材にしました。分けて直してください', true);
    setA({ busy: '', step: 'review', ext: { ...ext, kind: ext.kind || 'other', name: ext.name || { ja: '', en: '' }, radius: 30 } });
  } catch (e) {
    setA({ busy: '' });
    toast(`分解に失敗: ${e.message}`, true);
  }
}

function reviewView() {
  const e = A.ext;
  const isNew = !A.target;
  const nameJa = h('input', { value: e.name.ja || '', placeholder: '例: 大きな松のところ', oninput: (ev) => { e.name.ja = ev.target.value; } });
  const nameEn = h('input', { value: e.name.en || '', placeholder: 'English name (optional)', oninput: (ev) => { e.name.en = ev.target.value; } });
  const kind = h('select', { onchange: (ev) => { e.kind = ev.target.value; } }, ...Object.entries(KINDS).map(([v, l]) => h('option', { value: v, selected: v === e.kind }, l)));
  const radius = h('input', { type: 'number', min: 15, max: 100, value: e.radius, onchange: (ev) => { e.radius = Number(ev.target.value) || 30; } });
  const lab = (t, i) => h('label', { class: 'field' }, h('span', { text: t }), i);
  return [
    h('p', { class: 'hint', text: '話した内容だけが素材になっています。内容を確認・修正して保存してください。' }),
    ...(isNew ? [lab('Spot の名前（日本語）', nameJa), lab('Name (English)', nameEn), lab('種類', kind), lab('反応半径 (m)', radius)] : [h('p', { class: 'ok', text: `追加先: 「${spotName(state.spots.find((s) => s.id === A.target))}」` })]),
    materialsEditor(e.materials),
    e.interactions.length ? h('p', { class: 'hint', text: `おすすめの関わり: ${e.interactions.map((i) => i.type).join(' → ')}` }) : null,
    h('div', { class: 'actions' },
      h('button', { class: 'primary', disabled: !!A.busy, onclick: saveHere }, '保存する'),
      h('button', { class: 'ghost', onclick: () => setA({ step: 'input' }) }, '戻る')),
  ];
}

async function saveHere() {
  const e = A.ext;
  if (!A.target && !(e.name.ja || e.name.en).trim()) return toast('Spot の名前を入力してください', true);
  if (!e.materials.some((m) => m.text.trim())) return toast('素材が空です', true);
  setA({ busy: '保存中…' });
  try {
    const saved = await commitSpot({ existingId: A.target || null, name: e.name, kind: e.kind, lat: +A.pos.lat.toFixed(6), lng: +A.pos.lng.toFixed(6), radius: e.radius, materials: e.materials, interactions: e.interactions });
    setA({ busy: '', step: 'done', savedId: saved.id, savedName: spotName(saved) });
  } catch (err) {
    setA({ busy: '' });
    toast(`保存に失敗: ${err.message}`, true);
  }
}

// =====================================================================
// B. 録音ウォーク
// =====================================================================
const W = { active: false, lang: 'ja', rid: null, stream: null, seg: null, items: [], track: [], sentIdx: 0, index: 0, queue: Promise.resolve(), watchId: null, rotTimer: null, clock: null, startMs: 0, release: null, lastPt: 0, finishing: false };

function renderWalk() {
  const root = $('#walk-body');
  if (!W.active) {
    root.replaceChildren(
      h('p', { text: 'ガイドしながら歩くだけで、立ち止まって話した場所を自動で見つけ、Spot の候補にします。' }),
      h('ul', { class: 'notes' },
        h('li', { text: '開始するとマイクと位置情報を使います。画面は点けたままにします（スリープすると録音が止まる端末があります）。' }),
        h('li', { text: `約 ${Math.round(CHUNK_MS / 60000)} 分ごとに区切って文字起こしします。${PRIVACY}` }),
        h('li', { text: '歩きながら話した内容も拾いますが、立ち止まって話した場所のほうが正確です。' }),
      ),
      h('div', { class: 'row' }, langSelect(W.lang, (v) => { W.lang = v; })),
      h('button', { class: 'primary big', onclick: startWalk }, '録音ウォークを開始'),
    );
    return;
  }
  root.replaceChildren(
    h('p', { class: 'ok big', id: 'walk-clock', text: '録音中 00:00' }),
    h('p', { id: 'walk-gps', class: 'hint', text: '位置を待っています…' }),
    h('div', { class: 'chunks' }, ...W.items.map((it) => h('div', { class: `chunk ${it.status}` },
      h('span', { text: `区間 ${it.index + 1}（${Math.round(it.durationSec)}秒）: ${{ queued: '送信待ち', sending: '文字起こし中…', done: `完了（発話 ${it.segments}）`, error: `失敗: ${it.error || ''}` }[it.status]}` }),
      it.status === 'error' ? h('button', { class: 'small', onclick: () => retry(it) }, '再送') : null))),
    h('div', { class: 'actions' },
      h('button', { class: 'primary big', disabled: W.finishing, onclick: () => finishWalk(false) }, W.finishing ? '処理中…' : '終了して候補を作る'),
      h('button', { class: 'ghost', disabled: W.finishing, onclick: cancelWalk }, '破棄してやめる')),
  );
}

async function startWalk() {
  if (!navigator.geolocation) return toast('位置情報が使えません', true);
  try {
    W.stream = await openMic();
    const { recordingId } = await api('POST', '/api/guide/recordings', {});
    Object.assign(W, { rid: recordingId, items: [], track: [], sentIdx: 0, index: 0, queue: Promise.resolve(), active: true, finishing: false, startMs: Date.now(), lastPt: 0 });
    W.release = await keepAwake();
    W.seg = recordSegment(W.stream, pickMime());
    W.watchId = navigator.geolocation.watchPosition((p) => {
      const now = Date.now();
      const g = $('#walk-gps');
      if (g) g.textContent = `位置 ±${Math.round(p.coords.accuracy)}m ／ 軌跡 ${W.track.length} 点`;
      if (now - W.lastPt < 3000) return;
      W.lastPt = now;
      W.track.push({ t: now, lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy || 30 });
    }, (e) => toast(`位置情報: ${e.message}`, true), { enableHighAccuracy: true, maximumAge: 0 });
    W.rotTimer = setInterval(() => rotate(false), CHUNK_MS);
    W.clock = setInterval(() => {
      const s = Math.floor((Date.now() - W.startMs) / 1000);
      const c = $('#walk-clock');
      if (c) c.textContent = `録音中 ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }, 1000);
    addEventListener('beforeunload', warnLeave);
    renderWalk();
  } catch (e) {
    stopStream(W.stream);
    toast(`開始できません: ${e.message}`, true);
  }
}

const warnLeave = (e) => { if (W.active) e.preventDefault(); };

// 区間を区切って送信キューへ。次の区間は先に始めて、途切れを防ぐ
async function rotate(final) {
  const seg = W.seg;
  W.seg = final ? null : recordSegment(W.stream, pickMime());
  const blob = await seg.stop();
  const track = W.track.slice(W.sentIdx);
  W.sentIdx = W.track.length;
  const item = { index: W.index++, startedAt: seg.startedAt.toISOString(), durationSec: (Date.now() - seg.startedAt.getTime()) / 1000, blob, track, status: 'queued', segments: 0 };
  W.items.push(item);
  W.queue = W.queue.then(() => send(item));
  renderWalk();
}

async function send(item) {
  item.status = 'sending'; item.error = '';
  renderWalk();
  try {
    const audioBase64 = item.blob && item.blob.size > 1500 ? await blobToBase64(item.blob) : '';
    const r = await api('POST', `/api/guide/recordings/${W.rid}/chunk`, { index: item.index, startedAt: item.startedAt, durationSec: item.durationSec, audioBase64, mimeType: item.blob.type, lang: W.lang, track: item.track });
    if (!r.ok) throw new Error(r.error || '文字起こしに失敗');
    item.status = 'done'; item.segments = r.segments;
    item.blob = new Blob([], { type: item.blob.type }); // 音声は文字起こしが済んだら破棄
  } catch (e) {
    item.status = 'error'; item.error = e.message;
  }
  renderWalk();
}

function retry(item) { W.queue = W.queue.then(() => send(item)); }

function teardown() {
  clearInterval(W.rotTimer); clearInterval(W.clock);
  if (W.watchId != null) navigator.geolocation.clearWatch(W.watchId);
  stopStream(W.stream);
  if (W.release) W.release();
  removeEventListener('beforeunload', warnLeave);
  W.active = false; W.watchId = null; W.seg = null; W.finishing = false;
}

function cancelWalk() {
  if (!confirm('録音を破棄して終了しますか？（候補は作られません）')) return;
  if (W.seg) W.seg.stop();
  teardown();
  W.items = [];
  renderWalk();
}

async function finishWalk(force) {
  if (W.finishing) return;
  W.finishing = true;
  clearInterval(W.rotTimer);
  if (W.watchId != null) { navigator.geolocation.clearWatch(W.watchId); W.watchId = null; }
  renderWalk();
  try {
    if (W.seg) await rotate(true);
    await W.queue;
    if (!force && W.items.some((i) => i.status === 'error')) {
      W.finishing = false;
      renderWalk();
      $('#walk-body').append(h('p', { class: 'warn', text: '送れなかった区間があります。「再送」を押してから、もう一度「終了して候補を作る」を押してください。' }),
        h('button', { class: 'ghost', onclick: () => finishWalk(true) }, '送れなかった区間をあきらめて続ける'));
      return;
    }
    const { candidates } = await api('POST', `/api/guide/recordings/${W.rid}/finish`, {});
    teardown();
    W.items = [];
    renderWalk();
    if (!candidates.length) return toast('立ち止まって話した場所は見つかりませんでした');
    toast(`${candidates.length} 件の候補ができました。地図で確認してください`);
    hooks.showCandidates(candidates);
  } catch (e) {
    W.finishing = false;
    renderWalk();
    toast(`終了処理に失敗: ${e.message}`, true);
  }
}
