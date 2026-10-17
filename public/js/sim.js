// 机上確認用の歩行シミュレーション（Leaflet + 地理院タイル）
export const GSI_TILE = {
  url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',
  attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>',
  maxZoom: 18,
};

export function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  return new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.append(css);
    const js = document.createElement('script');
    js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    js.onload = () => resolve(window.L);
    js.onerror = () => reject(new Error('Leaflet を読み込めませんでした（ネットワークを確認してください）'));
    document.head.append(js);
  });
}

// 現在地の丸をドラッグすると、その軌跡どおりに歩いているものとして位置を送る。
// 速さはドラッグの実際の移動距離 ÷ 実時間でそのまま motion に反映される（早送りしない）。
// 離したらその場で止まっている扱いで、1 秒ごとに同じ位置を送り続ける。
const DRAG_THROTTLE_MS = 250;

// Leaflet の tooltip は HTML として描画されるため、地名（OSM 由来など）はエスケープする
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function initSim({ container, spots, lang, onMove }) {
  const L = await loadLeaflet();
  const ordered = spots.filter((s) => s.enabled !== false).sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  const start = { lat: ordered[0].lat + 0.0012, lng: ordered[0].lng + 0.0009 };

  const map = L.map(container, { zoomControl: false, attributionControl: true }).setView([start.lat, start.lng], 16);
  L.tileLayer(GSI_TILE.url, { attribution: GSI_TILE.attribution, maxZoom: GSI_TILE.maxZoom }).addTo(map);
  for (const s of ordered) {
    L.circle([s.lat, s.lng], { radius: s.radius, color: '#2f5d3a', weight: 1, fillOpacity: 0.15 }).addTo(map);
    L.marker([s.lat, s.lng], { title: s.name[lang] || s.name.ja }).addTo(map).bindTooltip(esc(`${s.order ?? ''} ${s.name[lang] || s.name.ja}`));
  }
  // draggable なマーカーは、つかんだときだけ地図のパンを止める（Leaflet が自動で行う。タッチ対応）
  const icon = L.divIcon({ className: 'sim-me', iconSize: [28, 28], iconAnchor: [14, 14] });
  const me = L.marker([start.lat, start.lng], { icon, draggable: true, zIndexOffset: 1000 }).addTo(map);
  map.fitBounds(L.latLngBounds([[start.lat, start.lng], ...ordered.map((s) => [s.lat, s.lng])]).pad(0.15));

  let pos = { ...start };
  let lastSent = 0;
  const send = () => { lastSent = Date.now(); onMove(pos.lat, pos.lng, 5); };
  me.on('drag', (e) => {
    pos = { lat: e.latlng.lat, lng: e.latlng.lng };
    if (Date.now() - lastSent >= DRAG_THROTTLE_MS) send();
  });
  me.on('dragend', () => {
    const p = me.getLatLng();
    pos = { lat: p.lat, lng: p.lng };
    send();
  });
  const timer = setInterval(send, 1000); // 止まっている間も同じ位置を送り続ける

  setTimeout(() => { map.invalidateSize(); send(); }, 0);
  return { stop: () => clearInterval(timer), destroy: () => { clearInterval(timer); map.remove(); } };
}
