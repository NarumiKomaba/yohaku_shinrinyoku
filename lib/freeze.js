// 読み取り専用で使い回すデータを、中まで変えられないようにする
'use strict';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

module.exports = { deepFreeze };
