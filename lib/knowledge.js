// RAG: 一般知識 (knowledge.json) と Spot の素材 (spots.json の materials) から関連するものを選ぶ
'use strict';

const { readData } = require('./store');

function tokens(s) {
  const text = String(s || '').toLowerCase();
  const set = new Set();
  for (const w of text.match(/[a-z0-9]+/g) || []) if (w.length > 2) set.add(w);
  for (const seg of text.replace(/[^぀-ヿ㐀-鿿]+/g, ' ').split(' ')) {
    for (let i = 0; i < seg.length - 1; i++) set.add(seg.slice(i, i + 2));
  }
  return set;
}

function overlap(q, text) {
  const t = tokens(text);
  let n = 0;
  for (const x of q) if (t.has(x)) n++;
  return n;
}

function retrieve(query, { spotId, seasonName, k = 4 } = {}) {
  const q = tokens(query);
  return readData('knowledge.json').chunks
    .map((c) => {
      let score = overlap(q, [c.title.ja, c.title.en, c.text.ja, c.text.en, ...(c.tags || [])].join(' '));
      if (spotId && c.spots && c.spots.includes(spotId)) score += 3;
      if (c.season && seasonName && c.season.includes(seasonName)) score += 1;
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.c);
}

function season(date) {
  const m = date.getMonth() + 1;
  if (m >= 3 && m <= 5) return 'spring';
  if (m >= 6 && m <= 8) return 'summer';
  if (m >= 9 && m <= 11) return 'autumn';
  return 'winter';
}

function timeOfDay(date) {
  const h = date.getHours();
  if (h < 10) return 'morning';
  if (h < 16) return 'daytime';
  if (h < 18) return 'late afternoon';
  return 'evening';
}

module.exports = { tokens, overlap, retrieve, season, timeOfDay };
