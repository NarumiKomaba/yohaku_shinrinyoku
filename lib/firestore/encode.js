// JS の値 ⇔ Firestore REST の型付きの値（Value）。
// 時刻は ISO 文字列のまま stringValue で書く（範囲検索は day: 日本時間の YYYY-MM-DD で行う）
'use strict';

const unencodable = (why) => Object.assign(new Error(`unencodable: ${why}`), { code: 'unencodable' });
const RESERVED_KEY = /^__.*__$/;

function toValue(v, inArray = false) {
  if (v === null || v === undefined) return { nullValue: 'NULL_VALUE' };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { nullValue: 'NULL_VALUE' };
    return Number.isSafeInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) {
    if (inArray) throw unencodable('array in array');
    return { arrayValue: { values: v.map((x) => toValue(x, true)) } };
  }
  if (typeof v === 'object') return { mapValue: { fields: toFields(v) } };
  throw unencodable(typeof v);
}

/** オブジェクト → fields。undefined の項目は書かない */
function toFields(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined).map(([k, v]) => {
    if (!k || RESERVED_KEY.test(k)) throw unencodable('key');
    return [k, toValue(v)];
  }));
}

function fromValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number.isFinite(Number(v.doubleValue)) ? Number(v.doubleValue) : null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue' in v) return fromFields(v.mapValue.fields);
  if ('timestampValue' in v) return v.timestampValue;
  if ('referenceValue' in v) return v.referenceValue;
  return null;
}

const fromFields = (fields) => Object.fromEntries(Object.entries(fields || {}).map(([k, v]) => [k, fromValue(v)]));

/** Firestore に書けるオブジェクトか（空のキー・__x__ のキー・配列の中の配列などがないか） */
function isEncodable(obj) {
  try {
    toFields(obj);
    return true;
  } catch {
    return false;
  }
}

module.exports = { toValue, toFields, fromValue, fromFields, isEncodable };
