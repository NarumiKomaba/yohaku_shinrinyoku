// Firestore を呼ぶためのアクセストークン。ADC は使わない（このパソコンの会社用の設定と混ざらないように）:
//   metadata: Cloud Run のメタデータサーバー（実行アカウント）。期限の 5 分前（短いトークンは半分）まで使い回す
//   gcloud:   gcloud auth print-access-token を GCLOUD_CONFIG の設定で実行（既定の設定は使わない・変えない）。50 分使い回す
// シェルは通さず、引数は固定値だけ。Windows の gcloud は gcloud.cmd なので、場所を 1 回だけ調べ（作業フォルダの中のものは使わない）、
// cmd.exe /d /s /c でその場所を指定して動かす。同時に頼まれても取りに行くのは 1 回。トークンはログにもエラーにも出さない
'use strict';

const path = require('path');
const { promisify } = require('util');
const childProcess = require('child_process');
const { storeUnavailable } = require('../store/common');

const METADATA_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const METADATA_TIMEOUT_MS = 2000;
const EARLY_SEC = 5 * 60;
const GCLOUD_REUSE_MS = 50 * 60_000;
const GCLOUD_TIMEOUT_MS = 30_000;
const GCLOUD_ARGS = ['auth', 'print-access-token'];

async function fromMetadata(fetch, now) {
  const res = await fetch(METADATA_URL, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`metadata ${res.status}`);
  const body = await res.json();
  if (typeof body.access_token !== 'string' || !body.access_token) throw new Error('metadata: no token');
  const life = Math.max(0, Number(body.expires_in) || 0);
  return { token: body.access_token, until: now() + Math.max(life / 2, life - EARLY_SEC) * 1000 };
}

// 実行するもの（file・args）。Windows は where.exe で gcloud の場所を調べ、作業フォルダの中のものは除く
async function gcloudCommand({ run, platform, cwd, env }) {
  if (platform !== 'win32') return { file: 'gcloud', args: GCLOUD_ARGS, opts: {} };
  const systemRoot = env.SystemRoot || 'C:\\Windows';
  const { stdout } = await run(path.win32.join(systemRoot, 'System32', 'where.exe'), ['gcloud'], { env, timeout: GCLOUD_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' });
  const base = path.win32.resolve(cwd).toLowerCase() + '\\';
  const full = String(stdout || '').split(/\r?\n/).map((l) => l.trim())
    .find((l) => /\.(cmd|bat|exe)$/i.test(l) && !l.toLowerCase().startsWith(base));
  if (!full) throw new Error('gcloud not found');
  const comspec = env.ComSpec || path.win32.join(systemRoot, 'System32', 'cmd.exe');
  // /s: 外側の引用符だけを外す。場所は引用符で囲み、引数は固定値
  return { file: comspec, args: ['/d', '/s', '/c', `""${full}" ${GCLOUD_ARGS.join(' ')}"`], opts: { windowsVerbatimArguments: true } };
}

async function fromGcloud({ run, command, gcloudConfig, env, now }) {
  const { file, args, opts } = await command();
  const { stdout } = await run(file, args, { ...opts, env: { ...env, CLOUDSDK_ACTIVE_CONFIG_NAME: gcloudConfig }, timeout: GCLOUD_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' });
  const token = String(stdout || '').trim();
  if (!token) throw new Error('gcloud: no token');
  return { token, until: now() + GCLOUD_REUSE_MS };
}

function createTokenSource({
  mode, gcloudConfig = '', fetch = globalThis.fetch, run = promisify(childProcess.execFile),
  platform = process.platform, cwd = process.cwd(), env = process.env, now = Date.now,
} = {}) {
  if (mode !== 'metadata' && mode !== 'gcloud') throw new Error(`FIRESTORE_AUTH は metadata か gcloud にしてください（${mode}）`);
  if (mode === 'gcloud' && !gcloudConfig) throw new Error('FIRESTORE_AUTH=gcloud には GCLOUD_CONFIG（gcloud の設定名）が要ります（既定の設定は使いません）');
  let cached = null; // { token, until }
  let fetching = null;
  let resolved = null; // gcloud の実行のしかた（1 回だけ調べる。失敗したら次にまた調べる）
  const command = () => {
    if (!resolved) resolved = gcloudCommand({ run, platform, cwd, env }).catch((e) => { resolved = null; throw e; });
    return resolved;
  };

  async function load() {
    try {
      cached = mode === 'metadata' ? await fromMetadata(fetch, now) : await fromGcloud({ run, command, gcloudConfig, env, now });
      return cached.token;
    } catch {
      // 失敗の中身（gcloud の出力など）にはトークンが入りうるので出さない
      console.error(`[store] token failed (${mode})`);
      throw storeUnavailable(0, 'TOKEN');
    } finally {
      fetching = null;
    }
  }

  return {
    get() {
      if (cached && now() < cached.until) return Promise.resolve(cached.token);
      if (!fetching) fetching = load();
      return fetching;
    },
    /** 401 が返ったときに呼ぶ（次の get で取り直す） */
    invalidate() { cached = null; },
  };
}

module.exports = { createTokenSource, METADATA_URL };
