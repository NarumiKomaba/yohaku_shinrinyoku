// ガイドさんページ: 地図で Spot を編集（Leaflet + 地理院タイル）と、録音ウォークの候補確認
// 担当: implementer-guide
import { $, h, state, bus, api, saveSpot, commitSpot, slugId, spotName, toast, materialsEditor, newMaterial, KINDS, INTERACTION_TYPES } from './guide-core.js';

// Leaflet の tooltip は HTML として描画されるため、地名（OSM・録音由来など）はエスケープする
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const L = window.L;
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const ATTR = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>';

let map;
let selectedId = null;
let addMode = false;
const dirty = new Set();
const layers = new Map(); // spot id -> { marker, circle }
const osmLayer = L.layerGroup();
const candLayer = L.layerGroup();
const routeLine = L.polyline([], { color: '#2f5d3a', weight: 2, dashArray: '6 6' });
let candidates = [];
let selectedCand = null;
let here = null;

const byId = (id) => state.spots.find((s) => s.id === id);
const markDirty = (id) => { dirty.add(id); renderList(); $('#save-all').disabled = false; };

export function initMap() {
  map = L.map('map', { zoomControl: true }).setView([35.6805, 139.7565], 16);
  const std = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', { attribution: ATTR, maxZoom: 18 });
  const photo = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', { attribution: ATTR, maxZoom: 18 });
  std.addTo(map);
  L.control.layers({ '標準地図': std, '航空写真': photo }, null, { position: 'topright' }).addTo(map);
  osmLayer.addTo(map); candLayer.addTo(map); routeLine.addTo(map);

  map.on('click', (e) => {
    if (!addMode) return;
    setAddMode(false);
    addSpot({ lat: e.latlng.lat, lng: e.latlng.lng });
  });
  $('#btn-add-mode').addEventListener('click', () => setAddMode(!addMode));
  $('#btn-osm').addEventListener('click', importOsm);
  $('#btn-locate').addEventListener('click', locate);
  $('#save-all').addEventListener('click', saveAll);
  bus.addEventListener('spots', () => { redrawAll(); });
  addEventListener('beforeunload', (e) => { if (dirty.size) e.preventDefault(); });
  redrawAll();
  if (state.spots.length) map.fitBounds(L.latLngBounds(state.spots.map((s) => [s.lat, s.lng])).pad(0.2));
}

export function onShow() {
  setTimeout(() => map.invalidateSize(), 50);
}

function setAddMode(on) {
  addMode = on;
  $('#btn-add-mode').classList.toggle('on', on);
  $('#btn-add-mode').textContent = on ? '地図をタップして置く…（取消）' : '＋ Spot を追加';
  map.getContainer().style.cursor = on ? 'crosshair' : '';
}

function locate() {
  if (!navigator.geolocation) return toast('位置情報が使えません', true);
  navigator.geolocation.getCurrentPosition((p) => {
    const ll = [p.coords.latitude, p.coords.longitude];
    if (here) here.remove();
    here = L.circleMarker(ll, { radius: 7, color: '#1a73e8', fillColor: '#1a73e8', fillOpacity: 0.9 }).addTo(map).bindTooltip(`現在地 ±${Math.round(p.coords.accuracy)}m`);
    map.setView(ll, 18);
  }, (e) => toast(`現在地を取得できません: ${e.message}`, true), { enableHighAccuracy: true, timeout: 15000 });
}

// ---------- 描画 ----------
function drawSpot(s) {
  let l = layers.get(s.id);
  if (!l) {
    const marker = L.marker([s.lat, s.lng], { draggable: true }).addTo(map);
    const circle = L.circle([s.lat, s.lng], { radius: s.radius, color: '#2f5d3a', weight: 1, fillOpacity: 0.12 }).addTo(map);
    marker.on('click', () => select(s.id));
    marker.on('drag', (e) => circle.setLatLng(e.latlng));
    marker.on('dragend', (e) => {
      const sp = byId(s.id);
      sp.lat = +e.target.getLatLng().lat.toFixed(6);
      sp.lng = +e.target.getLatLng().lng.toFixed(6);
      markDirty(sp.id);
      drawRoute();
      if (selectedId === sp.id) { $('#f-lat').value = sp.lat; $('#f-lng').value = sp.lng; }
    });
    l = { marker, circle };
    layers.set(s.id, l);
  }
  l.marker.setLatLng([s.lat, s.lng]).setOpacity(s.enabled === false ? 0.4 : 1);
  l.marker.unbindTooltip().bindTooltip(esc(`${s.order ?? '-'}. ${spotName(s)}`));
  l.circle.setLatLng([s.lat, s.lng]).setRadius(s.radius).setStyle({ color: s.id === selectedId ? '#c2410c' : '#2f5d3a' });
}

function drawRoute() {
  routeLine.setLatLngs(state.spots.filter((s) => s.enabled !== false).map((s) => [s.lat, s.lng]));
}

function redrawAll() {
  for (const [id, l] of layers) if (!byId(id)) { map.removeLayer(l.marker); map.removeLayer(l.circle); layers.delete(id); }
  for (const s of state.spots) drawSpot(s);
  drawRoute();
  renderList();
  renderCandidates();
}

function renderList() {
  $('#spot-count').textContent = `${state.spots.length} 件`;
  $('#spot-list').replaceChildren(...state.spots.map((s) => h('li', {
    class: [s.id === selectedId ? 'sel' : '', s.enabled === false ? 'off' : ''].join(' '),
    onclick: () => { select(s.id); map.panTo([s.lat, s.lng]); },
  }, h('span', { class: 'n', text: String(s.order ?? '-') }),
  h('span', { class: 'nm', text: spotName(s) }),
  h('small', { text: `${KINDS[s.kind] || s.kind}・素材${s.materials.length}${dirty.has(s.id) ? '・未保存' : ''}` }))));
}

// ---------- 編集フォーム ----------
function select(id) {
  selectedId = id;
  const s = id && byId(id);
  for (const sp of state.spots) drawSpot(sp);
  renderList();
  const box = $('#spot-form');
  if (!s) { box.replaceChildren(h('p', { class: 'hint', text: '地図の Spot か一覧を選ぶと編集できます。' })); return; }
  box.replaceChildren(spotForm(s));
  box.scrollIntoView({ block: 'nearest' });
}

function field(label, input) { return h('label', { class: 'field' }, h('span', { text: label }), input); }

function spotForm(s) {
  const upd = (fn) => () => { fn(); markDirty(s.id); drawSpot(s); drawRoute(); };
  const nameJa = h('input', { value: s.name.ja || '', onchange: upd(() => { s.name.ja = nameJa.value.trim(); }) });
  const nameEn = h('input', { value: s.name.en || '', onchange: upd(() => { s.name.en = nameEn.value.trim(); }) });
  const kind = h('select', { onchange: upd(() => { s.kind = kind.value; }) }, ...Object.entries(KINDS).map(([v, l]) => h('option', { value: v, selected: v === s.kind }, l)));
  const radius = h('input', { type: 'number', min: 15, max: 100, value: s.radius, onchange: upd(() => { s.radius = Math.min(100, Math.max(15, Number(radius.value) || 40)); radius.value = s.radius; range.value = s.radius; }) });
  const range = h('input', { type: 'range', min: 15, max: 100, value: s.radius, oninput: upd(() => { s.radius = Number(range.value); radius.value = s.radius; }) });
  const order = h('input', { type: 'number', step: 0.5, value: s.order ?? '', onchange: upd(() => { s.order = Number(order.value); state.spots.sort((a, b) => (a.order ?? 999) - (b.order ?? 999)); }) });
  const lat = h('input', { id: 'f-lat', type: 'number', step: 0.00001, value: s.lat, onchange: upd(() => { s.lat = Number(lat.value); }) });
  const lng = h('input', { id: 'f-lng', type: 'number', step: 0.00001, value: s.lng, onchange: upd(() => { s.lng = Number(lng.value); }) });
  const enabled = h('input', { type: 'checkbox', checked: s.enabled !== false, onchange: upd(() => { s.enabled = enabled.checked; }) });

  return h('div', { class: 'form' },
    h('h3', { text: `${spotName(s)}（${s.id}）` }),
    field('名前（日本語）', nameJa), field('Name (English)', nameEn), field('種類', kind),
    field('反応半径 (m)', h('div', { class: 'row' }, range, radius)),
    h('div', { class: 'row2' }, field('おすすめ順', order), field('緯度', lat), field('経度', lng)),
    h('label', { class: 'check' }, enabled, 'この Spot を有効にする'),
    h('h4', { text: '素材（AI が話す内容の材料）' }),
    materialsEditor(s.materials, () => markDirty(s.id)),
    h('h4', { text: 'おすすめの関わり' }),
    interactionsEditor(s),
    s.osm ? h('details', {}, h('summary', { text: 'OpenStreetMap のタグ' }), h('pre', { text: JSON.stringify(s.osm.tags || s.osm, null, 2) })) : null,
    h('div', { class: 'actions' },
      h('button', { class: 'primary', type: 'button', onclick: () => saveOne(s.id) }, 'この Spot を保存'),
      h('button', { class: 'danger', type: 'button', onclick: () => removeSpot(s.id) }, '削除')));
}

function interactionsEditor(s) {
  const box = h('div', { class: 'inters' });
  const render = () => {
    box.replaceChildren(
      ...s.interactions.map((it, idx) => {
        const sel = h('select', { onchange: () => {
          it.type = sel.value;
          if (it.type === 'SILENCE') it.seconds ||= 60; else delete it.seconds;
          markDirty(s.id); render();
        } }, ...INTERACTION_TYPES.map((t) => h('option', { selected: t === it.type }, t)));
        const sec = it.type === 'SILENCE'
          ? [h('input', { type: 'number', min: 10, step: 10, value: it.seconds || 60, onchange: (e) => { it.seconds = Number(e.target.value); markDirty(s.id); } }), '秒']
          : [];
        return h('div', { class: 'row' }, sel, ...sec,
          h('button', { type: 'button', class: 'small', onclick: () => { if (idx > 0) { [s.interactions[idx - 1], s.interactions[idx]] = [it, s.interactions[idx - 1]]; markDirty(s.id); render(); } } }, '↑'),
          h('button', { type: 'button', class: 'small danger', onclick: () => { s.interactions.splice(idx, 1); markDirty(s.id); render(); } }, '×'));
      }),
      h('button', { type: 'button', class: 'ghost', onclick: () => { s.interactions.push({ type: 'LOOK' }); markDirty(s.id); render(); } }, '＋ 関わりを追加'),
    );
  };
  s.interactions ||= [];
  render();
  return box;
}

// ---------- 保存・削除・追加 ----------
async function saveOne(id) {
  try {
    await saveSpot(byId(id));
    dirty.delete(id);
    select(id);
    $('#save-all').disabled = dirty.size === 0;
    toast('保存しました');
  } catch (e) { toast(`保存に失敗: ${e.message}`, true); }
}

async function saveAll() {
  let n = 0;
  for (const id of [...dirty]) {
    try { await saveSpot(byId(id)); dirty.delete(id); n++; } catch (e) { toast(`${id} の保存に失敗: ${e.message}`, true); }
  }
  if (selectedId) select(selectedId);
  $('#save-all').disabled = dirty.size === 0;
  if (n) toast(`${n} 件を保存しました`);
}

async function removeSpot(id) {
  const s = byId(id);
  if (!s || !confirm(`「${spotName(s)}」を削除しますか？`)) return;
  try {
    if (!s._new) await api('DELETE', `/api/guide/spots/${encodeURIComponent(id)}`);
    state.spots = state.spots.filter((x) => x.id !== id);
    dirty.delete(id);
    selectedId = null;
    redrawAll();
    select(null);
    toast('削除しました');
  } catch (e) { toast(`削除に失敗: ${e.message}`, true); }
}

function addSpot({ lat, lng, nameJa = '新しい Spot', nameEn = '', materials = [], kind = 'other', osm = null }) {
  const s = {
    id: slugId(nameEn || `spot-${state.spots.length + 1}`),
    order: Math.max(0, ...state.spots.map((x) => x.order || 0)) + 1,
    enabled: true, name: { ja: nameJa, en: nameEn }, kind,
    lat: +lat.toFixed(6), lng: +lng.toFixed(6), radius: 40,
    materials, interactions: [{ type: 'LOOK' }], osm, _new: true,
  };
  state.spots.push(s);
  redrawAll();
  markDirty(s.id);
  select(s.id);
  return s;
}

// ---------- OpenStreetMap 候補の取り込み（読み取りのみ） ----------
function osmMaterials(t) {
  const mk = (text, topics) => newMaterial({ text, topics, source: 'osm', author: '' });
  const out = [];
  const desc = t['description:ja'] || (/[぀-ヿ一-鿿]/.test(t.description || '') ? t.description : '');
  if (desc) out.push(mk(desc.slice(0, 300), ['nature']));
  if (t.start_date) out.push(mk(`開始時期は ${t.start_date} と記録されています。`, ['history']));
  if (t.inscription) out.push(mk(`「${t.inscription.replace(/\s+/g, ' ').slice(0, 120)}」という文字が記されています。`, ['history']));
  if (t.artist_name || t.architect) out.push(mk(`作者・設計者として「${t.artist_name || t.architect}」が記録されています。`, ['history', 'culture']));
  return out;
}

function osmKind(t) {
  if (t.historic === 'city_gate') return 'gate';
  if (t.historic) return 'landmark';
  if (t.bridge || t.man_made === 'bridge') return 'bridge';
  if (t.amenity === 'fountain' || t.water || t.natural === 'water') return 'water';
  if (t.tourism === 'viewpoint') return 'view';
  if (t.leisure === 'park' || t.leisure === 'garden') return 'garden';
  return t.natural === 'tree' ? 'trees' : 'other';
}

async function importOsm() {
  const b = map.getBounds();
  const bbox = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
  const q = `[out:json][timeout:25];
(
  nwr["name"]["historic"](${bbox});
  nwr["name"]["tourism"~"attraction|viewpoint|artwork|museum"](${bbox});
  nwr["name"]["leisure"~"park|garden"](${bbox});
  nwr["name"]["natural"](${bbox});
  nwr["name"]["man_made"="bridge"](${bbox});
  way["name"]["bridge"="yes"](${bbox});
  nwr["name"]["amenity"="fountain"](${bbox});
  nwr["name"]["water"](${bbox});
);
out center tags 300;`;
  toast('OpenStreetMap に問い合わせ中…');
  try {
    const res = await fetch(OVERPASS, { method: 'POST', body: new URLSearchParams({ data: q }) });
    if (!res.ok) throw new Error(`Overpass ${res.status}`);
    const { elements } = await res.json();
    osmLayer.clearLayers();
    const seen = new Set();
    for (const el of elements) {
      const lat = el.lat ?? el.center?.lat;
      const lng = el.lon ?? el.center?.lon;
      const name = el.tags?.name;
      if (lat == null || !name || seen.has(name)) continue;
      seen.add(name);
      const m = L.circleMarker([lat, lng], { radius: 7, color: '#666', weight: 1, fillColor: '#bbb', fillOpacity: 0.9 }).addTo(osmLayer);
      const btn = h('button', { type: 'button', onclick: () => {
        addSpot({ lat, lng, nameJa: el.tags['name:ja'] || name, nameEn: el.tags['name:en'] || '', materials: osmMaterials(el.tags), kind: osmKind(el.tags), osm: { type: el.type, id: el.id, tags: el.tags } });
        osmLayer.removeLayer(m);
        map.closePopup();
      } }, 'Spot に追加');
      m.bindPopup(h('div', {}, h('strong', { text: name }), h('br'), h('small', { text: el.tags['name:en'] || '' }), h('br'), btn));
      m.on('click', (ev) => L.DomEvent.stopPropagation(ev));
    }
    toast(`OSM 候補 ${seen.size} 件（灰色の点）。点をタップして追加できます`);
  } catch (e) { toast(`OSM 取り込みに失敗: ${e.message}`, true); }
}

// ---------- 録音ウォークの候補確認 ----------
export function showCandidates(list) {
  candidates = list.map((c, i) => ({ ...c, key: i, status: 'pending', target: c.nearestSpotId || '' }));
  selectedCand = null;
  candLayer.clearLayers();
  for (const c of candidates) {
    c.circle = L.circle([c.lat, c.lng], { radius: c.radius, color: '#c2410c', weight: 2, dashArray: '5 5', fillOpacity: 0.1 }).addTo(candLayer);
    c.marker = L.marker([c.lat, c.lng], { draggable: true, opacity: 0.85 }).addTo(candLayer).bindTooltip(esc(`候補 ${c.key + 1}: ${c.name.ja || ''}`));
    c.marker.on('click', () => selectCand(c.key));
    c.marker.on('drag', (e) => c.circle.setLatLng(e.latlng));
    c.marker.on('dragend', (e) => { c.lat = +e.target.getLatLng().lat.toFixed(6); c.lng = +e.target.getLatLng().lng.toFixed(6); });
  }
  if (candidates.length) map.fitBounds(L.latLngBounds(candidates.map((c) => [c.lat, c.lng])).pad(0.3));
  renderCandidates();
}

function selectCand(key) { selectedCand = key; renderCandidates(); }

function renderCandidates() {
  const panel = $('#cand-panel');
  const open = candidates.filter((c) => c.status === 'pending');
  panel.hidden = !candidates.length;
  if (!candidates.length) return;
  panel.replaceChildren(
    h('h3', { text: `録音ウォークの候補（${open.length} 件が未処理）` }),
    h('p', { class: 'hint', text: '点線の円が候補です。ドラッグで位置を直し、内容を確認して採用か却下を選んでください。' }),
    ...candidates.map((c) => {
      if (c.status !== 'pending') return h('div', { class: `cand done`, text: `候補 ${c.key + 1}: ${c.status === 'adopted' ? '採用しました' : '却下しました'}` });
      const sel = selectedCand === c.key;
      return h('div', { class: `cand ${sel ? 'sel' : ''}` },
        h('div', { class: 'head', onclick: () => { selectCand(sel ? null : c.key); map.panTo([c.lat, c.lng]); } },
          h('strong', { text: `候補 ${c.key + 1}: ${c.name.ja || '(名前なし)'}` }),
          h('small', { text: ` 素材${c.materials.length}件${c.walking ? '・歩きながら' : ''}${c.nearestSpotId ? `・近く: ${spotName(byId(c.nearestSpotId) || { name: { ja: c.nearestSpotId } })}` : ''}` })),
        sel ? candEditor(c) : null);
    }),
  );
}

function candEditor(c) {
  const target = h('select', { onchange: () => { c.target = target.value; } },
    h('option', { value: '', selected: !c.target }, '新しい Spot として登録'),
    ...state.spots.map((s) => h('option', { value: s.id, selected: s.id === c.target }, `既存に追加: ${spotName(s)}`)));
  const nameJa = h('input', { value: c.name.ja || '', onchange: () => { c.name.ja = nameJa.value.trim(); } });
  const nameEn = h('input', { value: c.name.en || '', onchange: () => { c.name.en = nameEn.value.trim(); } });
  const kind = h('select', { onchange: () => { c.kind = kind.value; } }, ...Object.entries(KINDS).map(([v, l]) => h('option', { value: v, selected: v === c.kind }, l)));
  const radius = h('input', { type: 'number', min: 15, max: 100, value: c.radius, onchange: () => { c.radius = Math.min(100, Math.max(15, Number(radius.value) || 30)); c.circle.setRadius(c.radius); } });
  for (const m of c.materials) if (m.verified === undefined) m.verified = false;
  return h('div', { class: 'form' },
    field('登録先', target), field('名前（日本語）', nameJa), field('Name (English)', nameEn), field('種類', kind), field('反応半径 (m)', radius),
    h('details', {}, h('summary', { text: '話した内容（文字起こし）' }), h('pre', { text: c.transcript || '' })),
    h('h4', { text: '素材（話した内容だけ。確認・修正してください）' }),
    materialsEditor(c.materials),
    h('div', { class: 'actions' },
      h('button', { class: 'primary', type: 'button', onclick: () => adopt(c) }, '採用して保存'),
      h('button', { class: 'danger', type: 'button', onclick: () => reject(c) }, '却下')));
}

async function adopt(c) {
  try {
    const saved = await commitSpot({ existingId: c.target || null, name: c.name, kind: c.kind, lat: c.lat, lng: c.lng, radius: c.radius, materials: c.materials, interactions: c.interactions || [] });
    c.status = 'adopted';
    candLayer.removeLayer(c.circle); candLayer.removeLayer(c.marker);
    selectedCand = null;
    renderCandidates();
    select(saved.id);
    toast(`「${spotName(saved)}」に保存しました`);
  } catch (e) { toast(`保存に失敗: ${e.message}`, true); }
}

function reject(c) {
  c.status = 'rejected';
  candLayer.removeLayer(c.circle); candLayer.removeLayer(c.marker);
  selectedCand = null;
  renderCandidates();
}


export function focusSpot(id) {
  const s = byId(id);
  if (!s) return;
  select(id);
  map.setView([s.lat, s.lng], 18);
}
