// 画面遷移と UI。体験の進行そのものは engine.js が担う。
import { STRINGS } from './i18n.js';
import { Voice, unlockAudio } from './voice.js';
import { WalkEngine } from './engine.js';
import { initSim } from './sim.js';
import { runVoiceCheckin } from './checkin-voice.js';
import { rateCommand } from './commands.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const app = {
  lang: localStorage.getItem('lang') || (navigator.language.startsWith('ja') ? 'ja' : 'en'),
  token: null,
  scenario: null,
  spots: null,
  checkin: { state: null, desire: null, durationMin: undefined, note: '' }, // durationMin: undefined=未回答, null=時間は気にしない
  demo: false,
  rate: null, // 話す速さ: slow / normal / fast
  engine: null,
  history: [],
  survey: { satisfaction: null, price: null, screen: null, next: new Set() },
  geoWatch: null,
  sim: null,
  wakeLock: null,
  finishedInfo: null,
  // サーバーの設定（/api/config）。読めるまでは安全側（購入なし・デモコード非表示）
  access: { purchaseEnabled: false, demoPublic: false, demoCode: '' },
};
const voice = new Voice();
const S = () => STRINGS[app.lang];
const tr = (o) => (o ? o[app.lang] || o.ja : '');

// ---------- ログ（バッチ送信） ----------
const outbox = [];
function log(type, data = {}) {
  outbox.push({ type, lang: app.lang, clientTs: new Date().toISOString(), ...data });
  if (outbox.length >= 20) flush();
}
async function flush(keepalive = false) {
  if (!app.token || !outbox.length) return;
  const events = outbox.splice(0, outbox.length);
  try {
    await fetch('/api/events', { method: 'POST', keepalive, headers: { 'Content-Type': 'application/json', 'X-Session-Token': app.token }, body: JSON.stringify({ events }) });
  } catch {
    outbox.unshift(...events); // 圏外などで失敗したら次回に再送
  }
}
setInterval(flush, 15000);
addEventListener('pagehide', () => flush(true));
voice.onSpeak = (chars) => log('tts', { chars });
// 読み上げに失敗しても体験を止めない: 内容を文字で表示し、not-allowed なら音声の有効化ボタンを出す
let ttsErrorLogged = false;
voice.onError = (type) => {
  if (!ttsErrorLogged) { ttsErrorLogged = true; log('error', { where: 'tts', message: type }); }
  if (type === 'not-allowed') $('#audio-enable').hidden = false;
};
$('#audio-enable').addEventListener('click', () => {
  voice.unlock();
  unlockAudio();
  $('#audio-enable').hidden = true;
});

// ---------- 共通 ----------
function show(id) {
  $$('.screen').forEach((s) => { s.hidden = s.id !== id; });
  window.scrollTo(0, 0);
}

function applyI18n() {
  document.documentElement.lang = app.lang;
  $$('[data-i18n]').forEach((el) => { el.textContent = S()[el.dataset.i18n] ?? ''; });
  $$('[data-i18n-placeholder]').forEach((el) => { el.placeholder = S()[el.dataset.i18nPlaceholder] ?? ''; });
  $$('.lang-switch .chip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === app.lang)));
  document.title = `${S().brand} ${S().edition}`;
  voice.setLang(app.lang);
  applyAccess();
  if (app.scenario) renderChoices();
}

// 購入ボタンとデモコードの案内は、サーバーの設定に合わせて出し分ける（購入とデモコードは別々の設定）
function applyAccess() {
  const { purchaseEnabled, demoPublic, demoCode } = app.access;
  $('#buy').hidden = !purchaseEnabled;
  $('#buy-note').hidden = !purchaseEnabled;
  $('#buy-note').textContent = S().buyNote;
  $('#code-note').textContent = demoPublic ? S().demoCodeNote.replace('{code}', demoCode) : S().codeNotePrivate;
  $('#demo-note').textContent = demoPublic ? S().demoNote : S().demoNotePrivate;
}

// コードが通らなかったときの文言（総当たり対策で止められたときは別の文言）
const codeErrorText = (err) => {
  if (!err || err.status !== 429) return S().invalidCode;
  return err.message === 'too_many_attempts' ? S().tooManyAttempts : S().dailyLimit;
};

function chipGroup(container, options, { multi = false, onChange }) {
  container.replaceChildren(...options.map(({ value, label }) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = label;
    b.dataset.value = String(value);
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      if (!multi) container.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
      const on = multi ? b.getAttribute('aria-pressed') !== 'true' : true;
      b.setAttribute('aria-pressed', String(on));
      onChange(value, on);
    });
    return b;
  }));
}

// 画面のチップ選択を app.checkin に合わせる（音声チェックインとの同期、言語切替後の再描画用）
function selectChip(container, value) {
  container.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(value !== undefined && c.dataset.value === String(value))));
}
function syncChips() {
  selectChip($('#choices-state'), app.checkin.state ?? undefined);
  selectChip($('#choices-desire'), app.checkin.desire ?? undefined);
  selectChip($('#choices-duration'), app.checkin.durationMin);
  $('#checkin-next').disabled = !(app.checkin.state && app.checkin.desire);
}

function renderChoices() {
  const sc = app.scenario.checkin;
  const sync = () => { $('#checkin-next').disabled = !(app.checkin.state && app.checkin.desire); };
  chipGroup($('#choices-state'), sc.states.map((s) => ({ value: s.id, label: tr(s.label) })), { onChange: (v) => { app.checkin.state = v; sync(); } });
  chipGroup($('#choices-duration'), (sc.durations || []).map((d) => ({ value: d.value, label: tr(d.label) })), { onChange: (v) => { app.checkin.durationMin = v; } });
  chipGroup($('#choices-desire'), sc.desires.map((d) => ({ value: d.id, label: tr(d.label) })), { onChange: (v) => { app.checkin.desire = v; sync(); } });
  syncChips();

  chipGroup($('#s-satisfaction'), [1, 2, 3, 4, 5].map((n) => ({ value: n, label: String(n) })), { onChange: (v) => { app.survey.satisfaction = v; } });
  chipGroup($('#s-price'), S().priceOpts.map((l, i) => ({ value: ['cheap', 'fair', 'expensive'][i], label: l })), { onChange: (v) => { app.survey.price = v; } });
  chipGroup($('#s-screen'), S().screenOpts.map((l, i) => ({ value: ['rarely', 'sometimes', 'often'][i], label: l })), { onChange: (v) => { app.survey.screen = v; } });
  chipGroup($('#s-next'), S().nextOpts.map((l, i) => ({ value: ['again', 'human', 'specialist', 'elsewhere'][i], label: l })), {
    multi: true,
    onChange: (v, on) => (on ? app.survey.next.add(v) : app.survey.next.delete(v)),
  });
}

// /api/narrate（先読み・打ち切りのため signal を受ける）
async function callNarrate(payload, signal) {
  const res = await fetch('/api/narrate', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'X-Session-Token': app.token },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`narrate ${res.status}`);
  return res.json();
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(app.token ? { 'X-Session-Token': app.token } : {}) },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}

// ---------- 1. 購入コード ----------
$$('.lang-switch .chip').forEach((b) => b.addEventListener('click', () => {
  app.lang = b.dataset.lang;
  localStorage.setItem('lang', app.lang);
  applyI18n();
}));

$('#buy').addEventListener('click', async () => {
  try {
    const { code } = await api('/api/purchase', { plan: 'ai40', lang: app.lang });
    $('#code').value = code;
  } catch {
    $('#buy').hidden = true; // 購入が止められている（サーバーの設定が変わった）
  }
});

async function enterSession(code) {
  const { token } = await api('/api/session', { code });
  app.token = token;
  show('screen-checkin');
  startVoiceCheckin();
}

$('#code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  // ユーザー操作の中で音声を有効化しておく（以後の自動発話・チェックインの問いかけのため）
  voice.unlock();
  unlockAudio();
  app.demo = false;
  $('#code-error').hidden = true;
  try {
    await enterSession($('#code').value);
  } catch (err) {
    $('#code-error').textContent = codeErrorText(err);
    $('#code-error').hidden = false;
  }
});

// デモで試す: デモコード自動入力 → チェックイン → 準備画面を飛ばしてシミュレーションで開始
// デモコードが公開されていない（お試し版など）ときは、入力されたコードを使う
$('#demo-start').addEventListener('click', async () => {
  const code = app.access.demoPublic ? app.access.demoCode : $('#code').value.trim();
  if (!code) {
    $('#code-error').textContent = S().demoNeedCode;
    $('#code-error').hidden = false;
    $('#code').focus();
    return;
  }
  voice.unlock();
  unlockAudio();
  app.demo = true;
  $('#code').value = code;
  $('#code-error').hidden = true;
  try {
    await enterSession(code);
  } catch (err) {
    $('#code-error').textContent = codeErrorText(err);
    $('#code-error').hidden = false;
  }
});

// ---------- 2. Check-in ----------
let vc = null; // 音声チェックインの状態
const vcApply = (res) => {
  if (res.state) app.checkin.state = res.state;
  if (res.desire) app.checkin.desire = res.desire;
  if (!res.missing.includes('durationMin')) app.checkin.durationMin = res.durationMin;
  app.checkin.note = res.note || '';
  $('#checkin-note').value = app.checkin.note;
  syncChips();
};

async function startVoiceCheckin() {
  if (!voice.canListen || !voice.canSpeak) return; // マイクが使えなければチップのみ
  vc = {
    voice, S, cancelled: false, onButton: null, cancelHook: null,
    say: (text) => { $('#vc-caption').textContent = text; return voice.speak(text); },
    setStatus: (t) => { $('#vc-status').textContent = t; },
    showConfirm: (on) => { $('#vc-confirm').hidden = !on; },
    parse: (transcript) => api('/api/checkin/parse', {
      lang: app.lang, transcript,
      current: { state: app.checkin.state, desire: app.checkin.desire, durationMin: app.checkin.durationMin, note: $('#checkin-note').value.trim() },
    }),
    apply: vcApply,
    // 聞いても決まらなかった項目の既定値: 時間は気にしない / 元気 / 自然を感じる
    setDefaults(missing) {
      if (missing.includes('state')) app.checkin.state = 'ok';
      if (missing.includes('desire')) app.checkin.desire = 'nature';
      if (missing.includes('durationMin')) app.checkin.durationMin = null;
      syncChips();
    },
    defaultConfirmText() {
      const c = app.checkin;
      const dur = c.durationMin ? S().vcDur.replace('{n}', c.durationMin) : S().vcDurNone;
      return S().vcDefaultConfirm.replace('{dur}', dur).replace('{desire}', S().vcDesirePhrase[c.desire] || '');
    },
    cancel() {
      this.cancelled = true;
      voice.cancel();
      voice.stopListening();
      this.cancelHook?.();
    },
  };
  const mine = vc;
  $('#vc').hidden = false;
  $('#vc-confirm').hidden = true;
  $('#vc-caption').textContent = '';
  mine.setStatus(S().vcStatus);
  let result = 'fallback';
  try { result = await runVoiceCheckin(mine); } catch (e) { log('error', { where: 'checkin-voice', message: e.message }); }
  if (vc !== mine || result === 'cancelled') return;
  if (result === 'done') finishCheckin('voice');
  else { $('#vc').hidden = true; mine.cancel(); } // 声での聞き取りが難しいときは、チップで続ける
}
$('#vc-yes').addEventListener('click', () => vc?.onButton?.('yes'));
$('#vc-fix').addEventListener('click', () => vc?.onButton?.('fix'));
$('#vc-stop').addEventListener('click', () => { vc?.cancel(); $('#vc').hidden = true; });
// 手で選ぶ・書くを始めたら声のチェックインは止める（声の結果で上書きしない・「声で入力」とマイクを取り合わない）
function stopVoiceCheckin() {
  if (!vc) return;
  vc.cancel();
  vc = null;
  $('#vc').hidden = true;
}
// capture で先に止める（「声で入力」の聞き取りを始めた後に止めると、その聞き取りまで止まるため）
$('#screen-checkin').addEventListener('click', (e) => { if (e.target.closest('.chip, .dictate')) stopVoiceCheckin(); }, true);
$('#checkin-note').addEventListener('focus', stopVoiceCheckin);

function finishCheckin(via) {
  vc?.cancel();
  vc = null;
  $('#vc').hidden = true;
  app.checkin.note = $('#checkin-note').value.trim().slice(0, 200);
  log('checkin', { ...app.checkin, via });
  if (app.demo) { startWalk({ mode: 'sim', silenceEnd: 'auto' }); return; }
  // PC（タッチ非対応）では位置取得の既定をシミュレーションに
  if (!matchMedia('(pointer: coarse)').matches) document.querySelector('input[name="mode"][value="sim"]').checked = true;
  show('screen-prep');
}
$('#checkin-next').addEventListener('click', () => finishCheckin('chips'));
$('#checkin-note').addEventListener('input', () => { app.checkin.note = $('#checkin-note').value; });

// ---------- 3. 準備 → 開始 ----------
async function requestWakeLock() {
  try { app.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* 非対応 */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && app.engine && !app.engine.ended) requestWakeLock();
});

function startGps() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('no geolocation'));
    let first = true;
    app.geoWatch = navigator.geolocation.watchPosition(
      (p) => {
        app.engine?.onPosition(p.coords.latitude, p.coords.longitude, p.coords.accuracy);
        if (first) { first = false; resolve(); }
      },
      (err) => {
        log('error', { where: 'gps', message: err.message });
        if (first) { first = false; reject(err); }
      },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 },
    );
  });
}

$('#start-walk').addEventListener('click', () => {
  // ユーザー操作の中で音声を有効化しておく（モバイルの自動再生制限対策）
  voice.unlock();
  unlockAudio();
  startWalk({
    mode: document.querySelector('input[name="mode"]:checked').value,
    silenceEnd: document.querySelector('input[name="silenceEnd"]:checked').value,
  });
});
$('#gps-fallback-sim').addEventListener('click', () => {
  document.querySelector('input[name="mode"][value="sim"]').checked = true;
  startWalk({ mode: 'sim', silenceEnd: document.querySelector('input[name="silenceEnd"]:checked').value });
});

async function startWalk({ mode, silenceEnd }) {
  $('#gps-error').hidden = true;
  $('#gps-fallback-sim').hidden = true;
  initRate();

  app.engine = new WalkEngine({ voice, scenario: app.scenario, spots: app.spots, lang: app.lang, checkin: app.checkin, settings: { silenceEnd }, log, narrate: callNarrate, history: app.history });
  bindEngine(app.engine);

  if (mode === 'gps') {
    try { await startGps(); } catch {
      $('#gps-error').textContent = S().gpsDenied;
      $('#gps-error').hidden = false;
      $('#gps-fallback-sim').hidden = false;
      app.engine.abort();
      app.engine = null;
      return;
    }
  }
  show('screen-walk');
  $('#sim-panel').hidden = mode !== 'sim';
  if (mode === 'sim') {
    try {
      app.sim = await initSim({
        container: $('#sim-map'), spots: app.spots, lang: app.lang,
        onMove: (lat, lng, acc) => app.engine?.onPosition(lat, lng, acc),
      });
      clearInterval(app.simReadout);
      app.simReadout = setInterval(renderSimReadout, 500);
    } catch (e) {
      log('error', { where: 'sim', message: e.message });
    }
  }
  requestWakeLock();
  log('session_start', { mode, silenceEnd });
  renderRateButton();
  renderAutoListenButton();
  app.engine.start();
}

// ---------- 4. ウォーク ----------
function bindEngine(engine) {
  engine.addEventListener('status', ({ detail }) => {
    const st = detail.status;
    const label = { speaking: S().statusSpeaking, idle: S().statusIdle, silence: S().statusSilence, paused: S().statusPaused, listening: S().listening, thinking: S().statusThinking, asking: S().statusAsking }[st] || '';
    $('#status-label').textContent = label;
    $('#status-label').classList.toggle('breathing', st === 'silence' || st === 'idle');
    $('#status-hint').textContent = st === 'silence' ? S().statusSilenceHint : '';
    $('#btn-back').hidden = st !== 'silence';
    $('#pocket-status').textContent = label;
    const paused = st === 'paused';
    $('#btn-pause').querySelector('[data-i18n]').textContent = paused ? S().resume : S().pause;
    $('#btn-pause').querySelector('.ico').textContent = paused ? '▶' : '❚❚';
  });

  engine.addEventListener('spot', ({ detail }) => {
    $('#spot-label').textContent = detail.spot ? tr(detail.spot.name) : '';
  });

  engine.addEventListener('ask', ({ detail }) => renderAsk(detail.ask));
  // いまの活動と残り時間（例: 「いま：耳を澄ませる時間（あと 20 秒）」）
  engine.addEventListener('activity', ({ detail }) => {
    app.activity = detail.type ? detail : null;
    renderActivity();
  });
  engine.addEventListener('listen', ({ detail }) => { $('#listen-cue').hidden = !detail.on; });
  // 区切りで自動で聞いた声は、質問として扱う（話す速さの指示は ask() 内で端末内に処理）
  engine.addEventListener('heard', async ({ detail }) => {
    if (!app.engine || app.engine.ended) return;
    app.engine.beginTalk();
    await ask(detail.text, 'voice');
  });
  // 案内文の字幕（直近 1〜2 文を大きく表示）
  let capLines = [];
  let capTimer = null;
  engine.addEventListener('caption', ({ detail }) => {
    const el = $('#caption');
    capLines = [...capLines, detail.text].slice(-2);
    el.textContent = capLines.join('\n');
    el.hidden = false;
    el.classList.remove('faded');
    clearTimeout(capTimer);
    capTimer = setTimeout(() => el.classList.add('faded'), 20000);
  });

  engine.addEventListener('position', ({ detail }) => {
    const n = detail.next;
    $('#next-label').textContent = !n ? S().allVisited
      : n.distance == null ? '' : `${S().nextSpot}: ${tr(n.spot.name)}  ${n.distance} m`;
  });

  engine.addEventListener('finished', ({ detail }) => {
    app.finishedInfo = detail;
    stopTracking();
    log('session_complete', { durationSec: detail.elapsedSec, spotsVisited: detail.visited.length, spotsTotal: app.spots.filter((s) => s.enabled !== false).length, ...detail.counts });
    flush();
    show('screen-reflect');
  });
}

// ask の選択ボタン（大きく、ダーク画面に合わせる）
function renderAsk(ask) {
  $('#ask-panel').hidden = !ask;
  if (!ask) return;
  $('#ask-text').textContent = ask.text;
  $('#ask-options').replaceChildren(...ask.options.map((o) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `ask-btn${o.id === ask.defaultId ? ' default' : ''}`;
    b.textContent = o.label;
    b.addEventListener('click', () => app.engine?.replyAsk({ optionId: o.id }));
    return b;
  }));
}
function renderActivity() {
  const a = app.activity;
  const el = $('#activity');
  el.hidden = !a;
  if (!a) return;
  const left = a.endsAt ? Math.max(0, Math.round((a.endsAt - Date.now()) / 1000)) : null;
  el.textContent = `${S().activityNow}${a.label}${left == null ? '' : S().activityLeft.replace('{s}', left)}`;
}
setInterval(() => { if (app.activity) renderActivity(); }, 1000);

function renderSimReadout() {
  if (!app.engine) return;
  const m = app.engine.motion.snapshot(app.engine.currentSpot);
  $('#sim-readout').textContent = m.moving
    ? S().simReadoutMoving.replace('{v}', m.speedMps.toFixed(1))
    : S().simReadoutStopped.replace('{v}', m.speedMps.toFixed(1)).replace('{s}', m.dwellSec);
}
$('#sim-dwell').addEventListener('click', () => app.engine?.debugAdvanceDwell(45));

function stopTracking() {
  if (app.geoWatch != null) navigator.geolocation.clearWatch(app.geoWatch);
  app.geoWatch = null;
  app.sim?.stop();
  clearInterval(app.simReadout);
  app.wakeLock?.release?.();
  app.wakeLock = null;
}

$('#btn-pause').addEventListener('click', () => {
  if (!app.engine) return;
  if (app.engine.paused) app.engine.resume(); else app.engine.pause();
});

$('#btn-back').addEventListener('click', () => app.engine?.userBack());

// 話す: タップで聞き始め、もう一度タップで終了
let listening = false;
$('#btn-talk').addEventListener('click', async () => {
  const engine = app.engine;
  if (!engine || engine.ended) return;
  if (listening) { voice.stopListening(); return; }
  if (!voice.canListen) { openTypeForm(); return; }
  engine.beginTalk();
  listening = true;
  $('#btn-talk').classList.add('listening');
  $('#talk-label').textContent = S().listening;
  let text = '';
  try {
    text = await voice.listen();
    log('stt_used', { ok: Boolean(text) });
  } catch (e) {
    log('error', { where: 'stt', message: e.message });
  } finally {
    listening = false;
    $('#btn-talk').classList.remove('listening');
    $('#talk-label').textContent = S().talk;
  }
  if (text) await ask(text, 'voice');
  else engine.endTalk();
});

function openTypeForm() {
  $('#type-form').hidden = false;
  $('#type-input').placeholder = voice.canListen ? '' : S().noSTT;
  $('#type-input').focus();
}
$('#btn-type').addEventListener('click', openTypeForm);
$('#type-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#type-input').value.trim();
  if (!text || !app.engine || app.engine.ended) return;
  $('#type-input').value = '';
  app.engine.beginTalk();
  await ask(text, 'text');
});

async function ask(question, input) {
  const engine = app.engine;
  const cmd = rateCommand(question);
  if (cmd) { // 話す速さの指示は /api/ask に送らず、端末内で即反映
    setRate(RATE_ORDER[Math.min(2, Math.max(0, RATE_ORDER.indexOf(app.rate) + cmd))], { via: 'voice' });
    await engine.answer(S().rateAck[app.rate]);
    engine.endTalk();
    return;
  }
  log('question_asked', { input, length: question.length, spotId: engine.currentSpot?.id || null });
  engine._setStatus('thinking');
  let answer;
  try {
    const res = await api('/api/ask', {
      question, lang: app.lang, spotId: engine.currentSpot?.id || null,
      checkin: app.checkin, history: app.history, clientTime: new Date().toISOString(),
    });
    answer = res.answer;
  } catch (e) {
    log('error', { where: 'ask', message: e.message });
    answer = app.lang === 'en' ? 'Sorry, I could not answer just now. Let\'s keep walking.' : 'すみません、いまはお答えできませんでした。歩みを続けましょう。';
  }
  app.history.push({ role: 'user', text: question }, { role: 'model', text: answer });
  await engine.answer(answer);
  engine.endTalk();
}

// ---------- 話す速さ・自動で聞く ----------
const RATES = { slow: 0.9, normal: 1.05, fast: 1.2 };
const RATE_ORDER = ['slow', 'normal', 'fast'];

function renderRateButton() {
  $('#btn-rate').textContent = `${S().rateLabel}: ${S().rateNames[app.rate]}`;
}
function setRate(rate, { via, save = true } = {}) {
  app.rate = rate;
  voice.rate = RATES[rate];
  if (save) localStorage.setItem('speechRate', rate); // 自分で変えたら保存（以後の初期値より優先）
  renderRateButton();
  if (via) log('speech_rate', { rate, via });
}
// 初期値: 保存済みがあればそれ。無ければ calm / 疲れ・気分が沈んでいる人は「ゆっくり」
function initRate() {
  const saved = localStorage.getItem('speechRate');
  const c = app.checkin;
  const slow = c.desire === 'calm' || c.state === 'body' || c.state === 'low';
  setRate(RATES[saved] ? saved : slow ? 'slow' : 'normal', { save: false });
}
$('#btn-rate').addEventListener('click', () => setRate(RATE_ORDER[(RATE_ORDER.indexOf(app.rate) + 1) % 3], { via: 'button' }));
function renderAutoListenButton() {
  $('#btn-autolisten').textContent = app.engine?.settings.autoListen === false ? S().autoListenOff : S().autoListenOn;
}
$('#btn-autolisten').addEventListener('click', () => {
  if (!app.engine) return;
  app.engine.settings.autoListen = app.engine.settings.autoListen === false;
  renderAutoListenButton();
});

// 終える
$('#btn-end').addEventListener('click', () => { $('#end-confirm').hidden = false; });
$('#end-no').addEventListener('click', () => { $('#end-confirm').hidden = true; });
$('#end-yes').addEventListener('click', () => {
  $('#end-confirm').hidden = true;
  app.engine?.finish();
});

// ポケットモード: 長押しで解除
const openPocket = () => { $('#pocket').hidden = false; requestWakeLock(); };
$('#btn-pocket').addEventListener('click', () => {
  if (localStorage.getItem('pocketSeen')) return openPocket();
  $('#pocket-intro').hidden = false; // 初回だけ短い説明
});
$('#pocket-cancel').addEventListener('click', () => { $('#pocket-intro').hidden = true; });
$('#pocket-ok').addEventListener('click', () => {
  localStorage.setItem('pocketSeen', '1');
  $('#pocket-intro').hidden = true;
  openPocket();
});
{
  let timer = null;
  const el = $('#pocket');
  el.addEventListener('pointerdown', () => { timer = setTimeout(() => { el.hidden = true; }, 1200); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(ev, () => clearTimeout(timer));
}

// ---------- 5. Reflection ----------
$$('.dictate').forEach((b) => b.addEventListener('click', async () => {
  if (!voice.canListen) { b.textContent = S().noSTT; return; }
  const target = $(`#${b.dataset.target}`);
  b.textContent = S().listening;
  try {
    const text = await voice.listen();
    if (text) target.value = target.value ? `${target.value} ${text}` : text;
  } catch (e) {
    log('error', { where: 'stt-reflect', message: e.message });
  }
  b.textContent = S().dictate;
}));

$('#s-recommend').addEventListener('input', (e) => { $('#s-recommend-out').textContent = e.target.value; });

$('#reflect-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  log('reflection', { noticed: $('#r-noticed').value.trim(), changed: $('#r-changed').value.trim(), nextWish: $('#r-next').value.trim() });
  const hrB = Number($('#hr-before').value) || null;
  const hrA = Number($('#hr-after').value) || null;
  log('survey', {
    satisfaction: app.survey.satisfaction, price: app.survey.price, screen: app.survey.screen,
    recommend: Number($('#s-recommend').value), next: [...app.survey.next],
    heartRateBefore: hrB, heartRateAfter: hrA,
  });
  await flush();
  renderSummary();
  show('screen-thanks');
});

function renderSummary() {
  const f = app.finishedInfo || { elapsedSec: 0, visited: [], counts: { silences: 0 } };
  const rows = [
    [S().summaryDuration, `${Math.max(1, Math.round(f.elapsedSec / 60))} ${S().minutes}`],
    [S().summarySpots, f.visited.map((id) => tr(app.spots.find((s) => s.id === id)?.name)).join('、') || '—'],
    [S().summaryPauses, `${f.counts.silences} ${S().times}`],
  ];
  $('#summary').replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    return [dt, dd];
  }));
}

$('#restart').addEventListener('click', () => location.reload());

// ---------- 起動 ----------
(async () => {
  const [scenario, spots, config] = await Promise.all([
    fetch('/api/data/scenario').then((r) => r.json()),
    fetch('/api/data/spots').then((r) => r.json()),
    fetch('/api/config').then((r) => r.json()).catch(() => ({})),
  ]);
  const demoCode = typeof config.demoCode === 'string' ? config.demoCode : '';
  app.access = { purchaseEnabled: config.purchaseEnabled === true, demoPublic: config.demoPublic === true && Boolean(demoCode), demoCode };
  app.scenario = scenario;
  app.spots = spots.spots;
  applyI18n();
  show('screen-welcome');
})();
