// ガイドさんページ共通: API、状態、DOM ヘルパー、素材エディタ、録音ヘルパー
// 担当: implementer-guide

export const $ = (s, root = document) => root.querySelector(s);

export const KINDS = { landmark: '名所・像', gate: '門', bridge: '橋', trees: '木々', water: '水辺', view: '眺め', garden: '庭・広場', rest: '休憩', other: 'その他' };
export const TYPES = { fact: '事実', story: '小話', sense: '五感の促し', notice: '注意', must: '必ず伝える' };
export const TOPICS = { plant: '植物', history: '歴史', culture: '文化', nature: '自然', birds: '鳥', water: '水', view: '眺め', senses: '五感', safety: '安全' };
export const INTERACTION_TYPES = ['LOOK', 'LISTEN', 'WALK', 'STOP', 'REST', 'SILENCE'];

export function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'value' || k === 'checked' || k === 'disabled') e[k] = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...kids.flat().filter((x) => x != null && x !== false));
  return e;
}

// ---------- 状態・認証 ----------
export const state = {
  spots: [],
  token: sessionStorage.getItem('guideToken') || '',
  name: localStorage.getItem('guideName') || '',
};

export const bus = new EventTarget(); // 'logout' / 'spots'
export const emit = (type) => bus.dispatchEvent(new Event(type));

export function setSession(token, name) {
  state.token = token;
  state.name = name || '';
  sessionStorage.setItem('guideToken', token);
  localStorage.setItem('guideName', state.name);
}

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(state.token ? { 'X-Guide-Token': state.token } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/guide/login') {
    state.token = '';
    sessionStorage.removeItem('guideToken');
    emit('logout');
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

export async function loadSpots() {
  state.spots = (await fetch('/api/data/spots').then((r) => r.json())).spots;
  state.spots.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  emit('spots');
}

// 1 件保存して state に反映（サーバーが整形した内容で置き換える）
export async function saveSpot(spot) {
  const { spot: saved } = await api('PUT', `/api/guide/spots/${encodeURIComponent(spot.id)}`, { spot });
  const i = state.spots.findIndex((s) => s.id === saved.id);
  if (i >= 0) state.spots[i] = saved; else state.spots.push(saved);
  state.spots.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  emit('spots');
  return saved;
}

export function slugId(name) {
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '') || 'spot';
  let id = base;
  for (let i = 2; state.spots.some((s) => s.id === id); i++) id = `${base}-${i}`;
  return id;
}

export function distanceM(a, b) {
  const dy = (a.lat - b.lat) * 111320;
  const dx = (a.lng - b.lng) * 111320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

export function nearbySpots(pos, within = 30) {
  return state.spots
    .map((s) => ({ spot: s, d: distanceM(s, pos) }))
    .filter((x) => x.d <= within)
    .sort((a, b) => a.d - b.d);
}

export const spotName = (s) => s.name.ja || s.name.en || s.id;

let toastTimer;
export function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isError ? 'show error' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, isError ? 6000 : 3000);
}

export function newMaterial(over = {}) {
  return { type: 'fact', text: '', lang: 'ja', topics: [], source: 'guide', author: state.name, verified: false, createdAt: new Date().toISOString(), ...over };
}

// ---------- 素材エディタ（A・地図・録音ウォーク候補で共通） ----------
export function materialsEditor(materials, onChange = () => {}) {
  const root = h('div', { class: 'materials' });
  const render = () => {
    root.replaceChildren(
      ...materials.map((m, idx) => {
        const type = h('select', { onchange: () => { m.type = type.value; onChange(); } },
          ...Object.entries(TYPES).map(([v, l]) => h('option', { value: v, selected: v === m.type }, l)));
        const lang = h('select', { onchange: () => { m.lang = lang.value; onChange(); } },
          h('option', { value: 'ja', selected: m.lang !== 'en' }, '日本語'), h('option', { value: 'en', selected: m.lang === 'en' }, 'English'));
        const text = h('textarea', { rows: 3, value: m.text, oninput: () => { m.text = text.value; onChange(); } });
        const topics = h('div', { class: 'chips' }, ...Object.entries(TOPICS).map(([v, l]) => {
          const cb = h('input', { type: 'checkbox', checked: (m.topics || []).includes(v), onchange: () => {
            m.topics = (m.topics || []).filter((x) => x !== v).concat(cb.checked ? [v] : []);
            onChange();
          } });
          return h('label', { class: 'chip' }, cb, l);
        }));
        const verified = h('input', { type: 'checkbox', checked: m.verified === true, onchange: () => { m.verified = verified.checked; onChange(); } });
        const source = { osm: 'OSM由来', seed: '初期データ', recording: '録音', guide: '手入力' }[m.source] || m.source || '';
        return h('div', { class: `material t-${m.type}` },
          h('div', { class: 'row' }, type, lang, h('span', { class: 'src', text: source }),
            h('button', { type: 'button', class: 'danger small', onclick: () => { materials.splice(idx, 1); onChange(); render(); } }, '削除')),
          text, topics,
          h('label', { class: 'verify' }, verified, 'ガイドさん確認済み'));
      }),
      h('button', { type: 'button', class: 'ghost', onclick: () => { materials.push(newMaterial()); onChange(); render(); } }, '＋ 素材を追加'),
    );
  };
  render();
  return root;
}

// ---------- 録音 ----------
export function pickMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  // iOS Safari は audio/mp4
  return ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

export async function openMic() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('このブラウザでは録音できません（https または localhost で開いてください）');
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true } });
}

// 1 つの録音区間。stop() で完結した 1 ファイルの Blob を返す（区切りごとに作り直せる）
export function recordSegment(stream, mime = pickMime()) {
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
  const done = new Promise((resolve) => { rec.onstop = () => resolve(new Blob(parts, { type: rec.mimeType || mime || 'audio/webm' })); });
  rec.start(1000);
  const startedAt = new Date();
  return { startedAt, stop: () => { if (rec.state !== 'inactive') rec.stop(); return done; } };
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export function stopStream(stream) { if (stream) stream.getTracks().forEach((t) => t.stop()); }

export async function keepAwake() {
  let lock = null;
  const acquire = async () => { try { lock = await navigator.wakeLock.request('screen'); } catch { /* 非対応・拒否は無視 */ } };
  const onVis = () => { if (document.visibilityState === 'visible') acquire(); };
  if ('wakeLock' in navigator) { await acquire(); document.addEventListener('visibilitychange', onVis); }
  return () => { document.removeEventListener('visibilitychange', onVis); if (lock) lock.release().catch(() => {}); };
}

// 新しい Spot として、または既存 Spot への素材追加として保存する（A・録音ウォーク候補で共通）
export async function commitSpot({ existingId, name, kind, lat, lng, radius, materials, interactions = [] }) {
  const mats = materials.filter((m) => m.text.trim()).map((m) => ({ ...m, author: m.author || state.name }));
  if (existingId) {
    const sp = structuredClone(state.spots.find((s) => s.id === existingId));
    sp.materials.push(...mats);
    for (const it of interactions) if (!sp.interactions.some((x) => x.type === it.type)) sp.interactions.push(it);
    return saveSpot(sp);
  }
  const id = slugId(name.en || 'rec');
  return saveSpot({ id, enabled: true, name, kind, lat, lng, radius, materials: mats, interactions: interactions.length ? interactions : [{ type: 'LOOK' }], osm: null });
}
