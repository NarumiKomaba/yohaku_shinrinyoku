'use strict';
// 保存先ごとに同じテスト（test/_store-contract.js）を流す
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./_helper');

h.setupEnv();
const { runStoreContract, SPOTS } = require('./_store-contract');
const { createFileStore } = require('../lib/store/file');
const { createMemoryStore } = require('../lib/store/memory');

runStoreContract('file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-store-'));
  fs.writeFileSync(path.join(dir, 'spots.json'), JSON.stringify(SPOTS));
  return { store: createFileStore({ dataDir: dir }) };
});

runStoreContract('memory', () => ({ store: createMemoryStore({ spots: SPOTS }) }));

const { createFakeFirestore, fakeTokens } = require('./_fake-firestore');
const { createRest } = require('../lib/firestore/rest');
const { createFirestoreStore } = require('../lib/store/firestore');

runStoreContract('firestore', async () => {
  const fake = createFakeFirestore();
  const rest = createRest({ projectId: 'p1', fetch: fake.fetch, tokens: fakeTokens(), sleep: async () => {} });
  const store = createFirestoreStore({ rest, namespace: 'test', spotsCacheSec: 0 });
  await store.updateSpots(() => SPOTS);
  return { store, fake };
});
