// ガイドさんページ: ログインとタブ切替
// 担当: implementer-guide
import { $, state, bus, api, setSession, loadSpots, toast } from './guide-core.js';
import { initMap, onShow as onMapShow, showCandidates, focusSpot } from './guide-map.js';
import { initRecord } from './guide-record.js';

const TABS = ['here', 'map', 'walk'];
let booted = false;

function showTab(name) {
  for (const t of TABS) {
    $(`#tab-${t}`).hidden = t !== name;
    $(`#nav-${t}`).classList.toggle('on', t === name);
  }
  if (name === 'map') onMapShow();
}

function showLogin(on) {
  $('#login').hidden = !on;
  $('#app').hidden = on;
}

async function boot() {
  showLogin(false);
  if (booted) { await loadSpots(); return; }
  booted = true;
  await loadSpots();
  initMap();
  initRecord({
    goMap: (id) => { showTab('map'); focusSpot(id); },
    showCandidates: (list) => { showTab('map'); showCandidates(list); },
  });
  for (const t of TABS) $(`#nav-${t}`).addEventListener('click', () => showTab(t));
  showTab('here');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { token } = await api('POST', '/api/guide/login', { passcode: $('#passcode').value });
    setSession(token, $('#guide-name').value.trim());
    $('#passcode').value = '';
    await boot();
  } catch (err) {
    $('#login-error').textContent = err.message === 'invalid_passcode' ? '合言葉が違います'
      : err.status === 429 ? '試行回数が多すぎます。しばらくしてからもう一度お試しください' : `ログインできません: ${err.message}`;
  }
});

$('#logout').addEventListener('click', () => { sessionStorage.removeItem('guideToken'); state.token = ''; showLogin(true); });
bus.addEventListener('logout', () => { showLogin(true); $('#login-error').textContent = 'ログインの有効期限が切れました。もう一度ログインしてください'; });

$('#guide-name').value = state.name;
if (state.token) boot().catch((e) => toast(e.message, true)); else showLogin(true);
