'use strict';
// lib/firestore/encode.js: JS の値 ⇔ Firestore の型付きの値
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toValue, fromValue, toFields, fromFields } = require('../lib/firestore/encode');

test('toValue_encodesScalars', () => {
  assert.deepEqual(toValue('あ'), { stringValue: 'あ' });
  assert.deepEqual(toValue(''), { stringValue: '' });
  assert.deepEqual(toValue(42), { integerValue: '42' });
  assert.deepEqual(toValue(-7), { integerValue: '-7' });
  assert.deepEqual(toValue(0.5), { doubleValue: 0.5 });
  assert.deepEqual(toValue(2 ** 60), { doubleValue: 2 ** 60 }, '安全な整数でない数は double');
  assert.deepEqual(toValue(true), { booleanValue: true });
  assert.deepEqual(toValue(null), { nullValue: 'NULL_VALUE' });
  for (const n of [NaN, Infinity, -Infinity]) assert.deepEqual(toValue(n), { nullValue: 'NULL_VALUE' });
});

test('toValue_encodesNestedObjectsAndArrays', () => {
  assert.deepEqual(toValue({ a: [1, 'x'], b: { c: false } }), {
    mapValue: { fields: { a: { arrayValue: { values: [{ integerValue: '1' }, { stringValue: 'x' }] } }, b: { mapValue: { fields: { c: { booleanValue: false } } } } } },
  });
  assert.deepEqual(toValue([]), { arrayValue: { values: [] } });
  assert.deepEqual(toValue({}), { mapValue: { fields: {} } });
  assert.deepEqual(toValue([{ list: [1] }]), { arrayValue: { values: [{ mapValue: { fields: { list: { arrayValue: { values: [{ integerValue: '1' }] } } } } }] } }, '配列の中の map の中の配列は書ける');
});

test('toFields_dropsUndefined', () => {
  assert.deepEqual(toFields({ a: 1, b: undefined }), { a: { integerValue: '1' } });
  assert.deepEqual(toValue([1, undefined]), { arrayValue: { values: [{ integerValue: '1' }, { nullValue: 'NULL_VALUE' }] } }, '配列の中は JSON と同じく null');
});

test('toValue_rejectsWhatFirestoreCannotStore', () => {
  assert.throws(() => toValue([[1]]), (e) => e.code === 'unencodable', '配列の中の配列');
  assert.throws(() => toValue({ __name__: 1 }), (e) => e.code === 'unencodable', '__x__ のキー');
  assert.throws(() => toValue({ '': 1 }), (e) => e.code === 'unencodable', '空のキー');
  assert.throws(() => toValue(() => 1), (e) => e.code === 'unencodable');
  assert.throws(() => toValue(10n), (e) => e.code === 'unencodable');
});

test('fromValue_decodesEveryTypeWeWriteAndRead', () => {
  assert.equal(fromValue({ stringValue: 'a' }), 'a');
  assert.equal(fromValue({ integerValue: '12' }), 12);
  assert.equal(fromValue({ doubleValue: 1.5 }), 1.5);
  assert.equal(fromValue({ doubleValue: 'NaN' }), null, 'JSON で表せない数は null');
  assert.equal(fromValue({ booleanValue: false }), false);
  assert.equal(fromValue({ nullValue: 'NULL_VALUE' }), null);
  assert.equal(fromValue({ timestampValue: '2026-10-17T00:00:00Z' }), '2026-10-17T00:00:00Z');
  assert.deepEqual(fromValue({ arrayValue: {} }), [], '空の配列は values が省かれる');
  assert.deepEqual(fromValue({ mapValue: {} }), {}, '空の map は fields が省かれる');
});

test('roundTrip_keepsValues', () => {
  const obj = { s: 'x', i: 3, d: 0.25, t: true, n: null, arr: ['a', 1, { k: [true] }], m: { deep: { er: 'y' } }, e: [], o: {} };
  assert.deepEqual(fromFields(toFields(obj)), obj);
  assert.deepEqual(fromFields(undefined), {});
});
