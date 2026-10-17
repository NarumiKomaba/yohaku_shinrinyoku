// Firestore 版の保存先（REST、外部ライブラリなし）。記録は envs/{STORE_NAMESPACE}/...、Spot は envs/{SPOTS_NAMESPACE}/...
// 作るときには Firestore につながない（最初に使うときか、gcloud なら warmUp でトークンを取る）
'use strict';

const { namespaceProblem } = require('../../config');
const { createRest } = require('../../firestore/rest');
const { createTokenSource } = require('../../firestore/token');
const { createEvents } = require('./events');
const { createSpots } = require('./spots');
const { createPurchases } = require('./purchases');
const { createRecordings } = require('./recordings');

function createFirestoreStore({ rest, namespace, spotsNamespace = namespace, spotsCacheSec = 30, now = Date.now }) {
  for (const [name, value] of [['STORE_NAMESPACE', namespace], ['SPOTS_NAMESPACE', spotsNamespace]]) {
    const problem = namespaceProblem(name, value);
    if (problem) throw new Error(problem);
  }
  const ctx = { rest, base: `envs/${namespace}`, now };
  return {
    ...createEvents(ctx),
    ...createSpots({ rest, spotsBase: `envs/${spotsNamespace}`, now, cacheMs: spotsCacheSec * 1000 }),
    ...createPurchases(ctx),
    ...createRecordings(ctx),
  };
}

/** 設定から REST を作る（サーバーと移行スクリプトで共通）。自分のアカウント（gcloud）で呼ぶときは、使う量をこのプロジェクトに付ける */
function restFromConfig(cfg) {
  if (!cfg.FIRESTORE_PROJECT_ID) throw new Error('STORE_BACKEND=firestore には FIRESTORE_PROJECT_ID が要ります');
  const tokens = createTokenSource({ mode: cfg.FIRESTORE_AUTH, gcloudConfig: cfg.GCLOUD_CONFIG });
  const userProject = cfg.FIRESTORE_AUTH === 'gcloud' ? cfg.FIRESTORE_PROJECT_ID : '';
  return createRest({ projectId: cfg.FIRESTORE_PROJECT_ID, database: cfg.FIRESTORE_DATABASE, tokens, userProject });
}

function fromConfig(cfg) {
  const rest = restFromConfig(cfg);
  const store = createFirestoreStore({ rest, namespace: cfg.STORE_NAMESPACE, spotsNamespace: cfg.SPOTS_NAMESPACE, spotsCacheSec: cfg.SPOTS_CACHE_SEC });
  // gcloud は数秒かかるので、最初のリクエストを待たせないよう先にトークンを取る（メタデータサーバーは速いので取らない）
  return cfg.FIRESTORE_AUTH === 'gcloud' ? { ...store, warmUp: () => rest.warmUp() } : store;
}

module.exports = { createFirestoreStore, restFromConfig, fromConfig };
