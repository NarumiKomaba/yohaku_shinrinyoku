// デモデータ作成: OpenStreetMap（Overpass・読み取りのみ）から皇居外苑周辺の名前付き地物・樹木を取得し、
// タグに書かれている事実だけから素材を作って data/spots.json にマージする。
//   node scripts/seed-demo.js [--dry-run] [--bbox south,west,north,east] [--out <file>] [--cache <file>] [--max 15]
// 既定（皇居外苑）は既存の Spot を残してマージする。素材 id は決定的なので何度実行しても重複しない。
// 他の場所（--bbox 指定）は既存 Spot を使わず、OSM タグ由来の素材だけで新規に作る。
// 出力先は --out（既定 data/spots.json。他の場所で data/spots.json を上書きするには --force が必要）。
// 担当: implementer-guide
'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../lib/config');
const { readData, writeData } = require('../lib/store');

// 皇居外苑（皇居前広場・和田倉噴水公園・馬場先濠・桜田門・二重橋・楠公像周辺）。丸の内・東御苑・日比谷側は含めない
const DEFAULT_BBOX = '35.6765,139.752,35.685,139.762';
// おすすめの周回順（和田倉[+噴水公園内の碑] → 馬場先濠 → 楠公 → 黒松 → 二重橋 → 桜田門）。ここにない Spot は後ろ、bbox 外は無効化
const ROUTE_ORDER = ['wadakura', 'monument-to-the-wedding-of-his-imperial', 'osm-n5500162081', 'babasaki', 'kusunoki', 'kuromatsu', 'nijubashi', 'sakuradamon'];
const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const BBOX = (argVal('--bbox') || DEFAULT_BBOX).replace(/\s/g, '');
if (!/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/.test(BBOX)) { console.error('--bbox は south,west,north,east の数値で指定してください'); process.exit(1); }
const IS_DEFAULT = BBOX === DEFAULT_BBOX;
const DEFAULT_OUT = path.join(DATA_DIR, 'spots.json');
const OUT = path.resolve(argVal('--out') || DEFAULT_OUT);
if (!IS_DEFAULT && OUT === DEFAULT_OUT && !DRY && !args.includes('--force')) { console.error('皇居外苑以外の場所で data/spots.json を上書きするには --out <file> か --force を指定してください'); process.exit(1); }
const CACHE = argVal('--cache');
const MAX_TOTAL = Number(argVal('--max')) || 15;
const ROUTE_M = Number(argVal('--route-m')) || 500; // （皇居外苑のみ）既存 Spot からこれ以内の候補だけ（歩ける範囲）
// 初期データの位置が実際の地物から大きくずれていたものを OSM の位置へ補正（皇居外苑のみ）
const FIXES = { kusunoki: { type: 'node', id: 4235132094 }, sakuradamon: { type: 'way', id: 145400030 } };
const MERGE_M = 40; // これ以内は同じ場所とみなす
const CREATED = new Date().toISOString();

const QUERY = `[out:json][timeout:60];
(
  nwr["name"]["historic"](${BBOX});
  nwr["name"]["tourism"~"attraction|viewpoint|artwork"](${BBOX});
  nwr["name"]["leisure"~"park|garden"](${BBOX});
  nwr["name"]["natural"](${BBOX});
  nwr["name"]["man_made"~"bridge|tower|lighthouse"](${BBOX});
  way["name"]["bridge"="yes"](${BBOX});
  nwr["name"]["amenity"="fountain"](${BBOX});
  nwr["name"]["water"](${BBOX});
  nwr["name"]["waterway"](${BBOX});
  node["natural"="tree"](${BBOX});
);
out center tags 1500;`;

async function fetchOsm() {
  if (CACHE && fs.existsSync(CACHE)) return JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  let last;
  for (const url of MIRRORS) {
    try {
      const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: QUERY }), headers: { 'User-Agent': 'kokyo-gaien-seed/1.0 (prototype)' }, signal: AbortSignal.timeout(70000) });
      if (!res.ok) throw new Error(`${url} ${res.status}`);
      const json = await res.json();
      if (CACHE) fs.writeFileSync(CACHE, JSON.stringify(json), 'utf8');
      return json;
    } catch (e) { last = e; console.error(`取得失敗: ${e.message}`); }
  }
  throw last;
}

// ---------- 地理 ----------
const dist = (a, b) => Math.hypot((a.lat - b.lat) * 111320, (a.lng - b.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180));
const pos = (el) => ({ lat: el.lat ?? el.center?.lat, lng: el.lon ?? el.center?.lon });

// ---------- タグ → 種類・事実 ----------
const HISTORIC_JA = { monument: '記念碑', memorial: '記念碑', castle: '城郭に関わる場所', city_gate: '城門', ruins: '遺構', archaeological_site: '史跡', wayside_shrine: '祠', building: '歴史的な建物', fort: '城郭', yes: '歴史的な場所' };

function kindOf(t) {
  if (t.historic === 'city_gate') return 'gate';
  if (t.historic) return 'landmark';
  if (t.bridge || t.man_made === 'bridge') return 'bridge';
  if (t.amenity === 'fountain' || t.water || t.waterway || t.natural === 'water') return 'water';
  if (t.tourism === 'viewpoint') return 'view';
  if (t.leisure === 'park' || t.leisure === 'garden') return 'garden';
  if (t.natural === 'tree' || t.natural === 'wood' || t.natural === 'tree_row') return 'trees';
  if (t.tourism) return 'landmark';
  return 'other';
}

const RADIUS = { landmark: 30, gate: 30, bridge: 30, trees: 30, water: 40, view: 40, garden: 50, rest: 30, other: 30 };
const INTERACTIONS = {
  landmark: [{ type: 'STOP' }, { type: 'LOOK' }], gate: [{ type: 'LOOK' }], bridge: [{ type: 'LOOK' }, { type: 'WALK' }],
  trees: [{ type: 'LOOK' }, { type: 'SILENCE', seconds: 45 }], water: [{ type: 'LISTEN' }, { type: 'LOOK' }],
  view: [{ type: 'LOOK' }], garden: [{ type: 'WALK' }, { type: 'SILENCE', seconds: 60 }], rest: [{ type: 'REST' }], other: [{ type: 'LOOK' }],
};
const KIND_TOPICS = { landmark: ['history'], gate: ['history'], bridge: ['view'], trees: ['plant'], water: ['water'], view: ['view'], garden: ['nature'], other: ['nature'] };

const LEAF = { broadleaved: '広葉樹', needleleaved: '針葉樹' };

// タグに書かれている事実だけを文にする。facts = 内容のある事実、label = 種類だけの弱い情報
function factsOf(t, nameJa, kind) {
  const facts = [];
  const add = (text, topics, label = false) => facts.push({ text, topics, label });
  const desc = t['description:ja'] || (/[぀-ヿ一-鿿]/.test(t.description || '') ? t.description : '');
  if (desc) add(desc.slice(0, 300), KIND_TOPICS[kind] || ['nature']);
  const sd = t.start_date || t['construction_date'];
  if (sd) add(`${nameJa}の開始時期は ${sd}${/^\d{3,4}$/.test(sd) ? '年' : ''} と記録されています。`, ['history']);
  if (t.inscription) add(`${nameJa}には「${t.inscription.replace(/\s+/g, ' ').slice(0, 120)}」という文字が記されています。`, ['history']);
  if (t.artist_name || t.architect || t.builder) add(`${nameJa}の作者・設計者として「${t.artist_name || t.architect || t.builder}」が記録されています。`, ['history', 'culture']);
  if (t.species || t['species:ja'] || t.genus || t['genus:ja']) {
    const sp = t['species:ja'] || t['genus:ja'] || t.species || t.genus;
    add(`ここの木は ${sp}${t['species:ja'] && t.species ? `（${t.species}）` : ''} と記録されています。${LEAF[t.leaf_type] ? `${LEAF[t.leaf_type]}です。` : ''}`, ['plant']);
  } else if (LEAF[t.leaf_type]) add(`ここの木は${LEAF[t.leaf_type]}と記録されています。`, ['plant']);
  if (t.height && /^\d+(\.\d+)?$/.test(t.height)) add(`高さはおよそ ${t.height} メートルと記録されています。`, ['nature']);
  if (t.heritage || t['heritage:operator']) add(`${nameJa}は、文化財などの指定・登録に関わる場所として記録されています。`, ['history', 'culture']);
  if (t.historic && HISTORIC_JA[t.historic]) add(`${nameJa}は、${HISTORIC_JA[t.historic]}として記録されています。`, ['history'], true);
  else if (t.amenity === 'fountain') add(`${nameJa}は、噴水として記録されています。`, ['water'], true);
  else if (t.water === 'moat') add(`${nameJa}は、お濠として記録されています。`, ['water', 'history'], true);
  else if (t.bridge || t.man_made === 'bridge') add(`${nameJa}は、橋として記録されています。`, ['view'], true);
  else if (t.tourism === 'viewpoint') add(`${nameJa}は、眺めのよい場所（展望）として記録されています。`, ['view'], true);
  else if (t.leisure === 'park' || t.leisure === 'garden') add(`${nameJa}は、${t.leisure === 'park' ? '公園' : '庭園'}として記録されています。`, ['nature'], true);
  return facts;
}

// 内容のある事実の数（種類ラベルは数えない）
// 開始時期だけでは「内容のある事実」とみなさない（公園・庭園などが理由なく入るのを防ぐ）
const substantive = (facts) => { const n = facts.filter((f) => !f.label).length; return n === 1 && facts[0].text.includes('開始時期') ? 0 : n; };

function slug(name, fallback, taken) {
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '') || fallback;
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

function buildMaterials(spotId, osmKey, facts) {
  return facts.map((f, i) => ({
    id: `${spotId}-osm-${osmKey}-${i + 1}`, type: 'fact', text: f.text, lang: 'ja', topics: f.topics, source: 'osm', author: '', verified: false, createdAt: CREATED,
  }));
}

async function main() {
  const [bs, bw, bn, be] = BBOX.split(',').map(Number);
  const inBox = (p) => p.lat >= bs && p.lat <= bn && p.lng >= bw && p.lng <= be;
  const { elements: all } = await fetchOsm();
  const elements = all.filter((e) => { const p = pos(e); return p.lat != null && inBox(p); }); // キャッシュが広い範囲でも bbox 内だけ使う
  // 皇居外苑は既存 Spot とマージ。他の場所は空から作る
  const data = IS_DEFAULT ? readData('spots.json') : { version: 2, spots: [] };
  const spots = data.spots;
  const taken = new Set(spots.map((s) => s.id));
  const report = { moved: [], merged: [], added: [], skipped: [] };
  const baseCount = spots.length;
  if (IS_DEFAULT) {
    for (const [sid, ref] of Object.entries(FIXES)) {
      const el = elements.find((e) => e.type === ref.type && e.id === ref.id);
      const sp = spots.find((x) => x.id === sid);
      if (!el || !sp) continue;
      const p = pos(el);
      const d = Math.round(dist(sp, p));
      if (d > 5) { report.moved.push(`${sid}: ${d}m 移動 → ${p.lat.toFixed(5)},${p.lng.toFixed(5)} (${el.tags.name})`); sp.lat = +p.lat.toFixed(6); sp.lng = +p.lng.toFixed(6); }
    }
  }

  // --- 名前付き地物 ---
  const named = [];
  const seen = new Set();
  for (const el of elements) {
    const t = el.tags || {};
    if (!t.name || t.natural === 'tree') continue;
    const p = pos(el);
    if (p.lat == null) continue;
    const key = `${t.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = kindOf(t);
    const nameJa = t['name:ja'] || t.name;
    const facts = factsOf(t, nameJa, kind);
    const subst = substantive(facts);
    named.push({ el, t, p, kind, nameJa, nameEn: t['name:en'] || '', facts, subst, score: subst * 3 + facts.length });
  }

  // --- 樹木: 種が分かる木を近くでまとめる ---
  // 日本語名（species:ja / genus:ja）が分かる木だけ対象（学名だけでは読み上げに向かない）
  const trees = elements.filter((e) => e.tags && e.tags.natural === 'tree' && (e.tags['species:ja'] || e.tags['genus:ja']) && !e.tags.name);
  const clusters = [];
  for (const e of trees) {
    const p = pos(e);
    const sp = e.tags['species:ja'] || e.tags['genus:ja'] || e.tags.species || e.tags.genus;
    const c = clusters.find((c) => c.sp === sp && dist(c.center, p) <= MERGE_M);
    if (c) { c.members.push({ e, p }); c.center = { lat: c.members.reduce((a, m) => a + m.p.lat, 0) / c.members.length, lng: c.members.reduce((a, m) => a + m.p.lng, 0) / c.members.length }; } else clusters.push({ sp, members: [{ e, p }], center: p });
  }
  for (const c of clusters.filter((c) => c.members.length >= 3)) {
    const t = c.members[0].e.tags;
    const facts = factsOf(t, '', 'trees').filter((f) => f.topics.includes('plant')).slice(0, 1);
    if (!facts.length) continue;
    facts.unshift({ text: `この付近に、${c.sp} と記録された木が ${c.members.length} 本あります。`, topics: ['plant'] });
    named.push({ el: c.members[0].e, t, p: c.center, kind: 'trees', nameJa: `${c.sp}の木々`, nameEn: '', facts, subst: 2, score: 6 + c.members.length / 10, treeCluster: c.sp });
  }

  // --- マージ / 追加の判定 ---
  const fresh = [];
  for (const c of named.sort((a, b) => b.score - a.score)) {
    const nearExisting = spots.find((s) => dist(s, c.p) <= MERGE_M);
    if (nearExisting) {
      if (c.subst === 0) continue; // 既存 Spot には、内容のある事実がある場合だけ足す
      const osmKey = c.treeCluster ? `tree${Math.abs(c.el.id) % 100000}` : `${c.el.type[0]}${c.el.id}`;
      const mats = buildMaterials(nearExisting.id, osmKey, c.facts.filter((f) => c.subst > 0));
      const have = new Set(nearExisting.materials.map((m) => m.id));
      const add = mats.filter((m) => !have.has(m.id) && !nearExisting.materials.some((x) => x.text === m.text));
      if (add.length) report.merged.push(`${nearExisting.id} ← ${c.nameJa} (+${add.length} 素材)`);
      if (add.length && !DRY) nearExisting.materials.push(...add);
      continue;
    }
    if (c.subst === 0) { report.skipped.push(`${c.nameJa} (${c.kind}): 事実が少ない`); continue; }
    if (IS_DEFAULT && Math.min(...spots.map((s) => dist(s, c.p))) > ROUTE_M) { report.skipped.push(`${c.nameJa}: 既存ルートから遠い`); continue; }
    if (fresh.some((f) => dist(f.p, c.p) <= MERGE_M)) { report.skipped.push(`${c.nameJa}: 近接する候補があるため`); continue; }
    fresh.push(c);
  }

  const room = Math.max(0, MAX_TOTAL - spots.length);
  for (const c of fresh.slice(0, room)) {
    const id = slug(c.nameEn || (c.treeCluster ? `trees-${c.el.id}` : ''), `osm-${c.el.type[0]}${c.el.id}`, taken);
    taken.add(id);
    const osmKey = c.treeCluster ? 'cluster' : `${c.el.type[0]}${c.el.id}`;
    const spot = {
      id, enabled: true,
      name: { ja: c.nameJa, en: c.nameEn || c.nameJa },
      kind: c.kind, lat: +c.p.lat.toFixed(6), lng: +c.p.lng.toFixed(6), radius: RADIUS[c.kind] || 30,
      materials: buildMaterials(id, osmKey, c.facts),
      interactions: INTERACTIONS[c.kind] || [{ type: 'LOOK' }],
      osm: c.treeCluster ? { type: 'node', id: c.el.id, tags: c.t } : { type: c.el.type, id: c.el.id, tags: c.t },
    };
    // おすすめ順: 既存ルートのいちばん遠回りにならない位置へ挿入
    const route = [...spots].sort((a, b) => a.order - b.order);
    let bestI = route.length; let bestCost = Infinity;
    for (let i = 0; i <= route.length; i++) {
      const prev = route[i - 1]; const next = route[i];
      const cost = (prev ? dist(prev, spot) : 0) + (next ? dist(spot, next) : 0) - (prev && next ? dist(prev, next) : 0);
      if (cost < bestCost) { bestCost = cost; bestI = i; }
    }
    route.splice(bestI, 0, spot);
    route.forEach((s, i) => { s.order = i + 1; });
    spots.push(spot);
    report.added.push(`${id} [${c.kind}] ${c.nameJa} 素材${spot.materials.length}件\n      ${spot.materials.map((m) => m.text).join('\n      ')}`);
  }
  for (const c of fresh.slice(room)) report.skipped.push(`${c.nameJa}: 件数上限 (${MAX_TOTAL})`);

  console.log(`bbox ${BBOX}${IS_DEFAULT ? '（皇居外苑）' : ''} / 取得 ${elements.length} 要素 / 既存 Spot ${baseCount} 件`);
  for (const [k, label] of [['moved', '位置補正'], ['added', '追加'], ['merged', '既存に素材を統合'], ['skipped', 'スキップ']]) {
    console.log(`\n[${label}] ${report[k].length}`);
    for (const l of report[k]) console.log('  ' + l);
  }
  if (DRY) { console.log('\n--dry-run: 書き込みしていません'); return; }
  if (IS_DEFAULT) {
    // bbox 外の既存 Spot は削除せず無効化。有効なものだけで周回順を振り直す
    const out = spots.filter((s) => !inBox(s) && s.enabled !== false);
    for (const s of out) { s.enabled = false; report.moved.push(`${s.id}: 外苑の外のため enabled:false`); }
    const on = spots.filter((s) => s.enabled !== false);
    const rank = (s) => { const i = ROUTE_ORDER.indexOf(s.id); return i >= 0 ? i : 100 + (s.order || 0); };
    on.sort((a, b) => rank(a) - rank(b));
    const off = spots.filter((s) => s.enabled === false).sort((a, b) => (a.order || 0) - (b.order || 0));
    [...on, ...off].forEach((s, i) => { s.order = i + 1; });
  }
  spots.sort((a, b) => a.order - b.order);
  if (OUT === DEFAULT_OUT) writeData('spots.json', { ...data, spots }); // バックアップ自動
  else { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify({ ...data, spots }, null, 2), 'utf8'); }
  console.log(`\n${OUT} を更新しました（計 ${spots.length} 件）`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
