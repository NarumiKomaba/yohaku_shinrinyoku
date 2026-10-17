// commit に渡す書き込み（Write）と、読んだドキュメントの取り出し
'use strict';

const { toFields, fromFields } = require('./encode');

/**
 * 書き込み。mask を渡すとその項目だけを書く（obj にない項目は消える）。渡さなければ丸ごと書く。
 * currentDocument は条件: { exists: false }（まだないときだけ）、{ updateTime }（読んだときから変わっていないときだけ）など
 */
const updateWrite = (name, obj, { mask, currentDocument } = {}) => ({
  update: { name, fields: toFields(obj) },
  ...(mask ? { updateMask: { fieldPaths: mask } } : {}),
  ...(currentDocument ? { currentDocument } : {}),
});
/** なければ作る（あれば ALREADY_EXISTS） */
const createWrite = (name, obj) => updateWrite(name, obj, { currentDocument: { exists: false } });
const deleteWrite = (name) => ({ delete: name });

const dataOf = (doc) => fromFields(doc && doc.fields);

// 検索の部品
const byField = (fieldPath, op, value) => ({ fieldFilter: { field: { fieldPath }, op, value } });
const order = (fieldPath, direction = 'ASCENDING') => ({ field: { fieldPath }, direction });

module.exports = { updateWrite, createWrite, deleteWrite, dataOf, byField, order };
