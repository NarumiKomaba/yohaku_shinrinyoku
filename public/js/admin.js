// 集計ページ（admin.html）。CSP でインラインのスクリプトを禁止しているため別ファイルにしている
const $ = (s) => document.querySelector(s);
const fmt = (v, d = 1) => (v == null ? '—' : typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString() : v.toFixed(d)) : String(v));

function card(title, rows, cls = '') {
  const sec = document.createElement('section');
  if (cls) sec.className = cls;
  const h = document.createElement('h2');
  h.textContent = title;
  const table = document.createElement('table');
  for (const [k, v] of rows) {
    const tr = table.insertRow();
    tr.insertCell().textContent = k;
    tr.insertCell().textContent = fmt(v);
  }
  if (!rows.length) table.insertRow().insertCell().textContent = 'データなし';
  sec.append(h, table);
  return sec;
}
const entries = (o) => Object.entries(o || {}).sort((a, b) => b[1] - a[1]);

async function load() {
  const token = sessionStorage.getItem('guideToken') || '';
  const res = token ? await fetch('/api/stats', { headers: { 'X-Guide-Token': token } }) : { status: 401 };
  if (res.status === 401) {
    sessionStorage.removeItem('guideToken');
    $('#login').hidden = false; $('#logout').hidden = true; $('#cards').replaceChildren();
    return;
  }
  $('#login').hidden = true; $('#logout').hidden = false;
  if (!res.ok) {
    $('#meta').textContent = res.status === 503 ? '記録を読めませんでした。しばらくしてから開き直してください。' : `集計できませんでした（${res.status}）`;
    $('#cards').replaceChildren();
    return;
  }
  const s = await res.json();
  // 読む量の上限（STATS_MAX_DOCS）に届いたときは、新しい分だけを集計している
  const range = s.fromDay ? ` ／ ${s.fromDay} 〜 ${s.toDay}（${s.days} 日）` : '';
  $('#meta').textContent = `集計時刻 ${new Date(s.generatedAt).toLocaleString()} ／ モデル ${s.model}${range}${s.truncated ? ' ／ ⚠ 記録が多いため一部だけ集計' : ''}`;
  const f = s.funnel;
  const rate = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  const reflections = s.reflections.map((r) => [`${new Date(r.ts).toLocaleString()} [${r.lang}]`, [r.noticed, r.changed, r.nextWish].map((x) => x || '—').join(' ／ ')]);
  const notes = card('チェックイン自由記述（新しい順）', s.checkinNotes.map((n) => [new Date(n.ts).toLocaleString(), n.note]), 'wide refl');
  const refl = card('最近のふりかえり（気づき ／ 変化 ／ 次にしたいこと）', reflections, 'wide refl');

  $('#cards').replaceChildren(
    card('Market: 販売 → 利用', [
      ['販売数（デモコード含む）', f.purchases],
      ['利用開始数', f.started],
      ['完了数', f.completed],
      ['完了率', rate(f.completed, f.started)],
      ['平均利用時間（分）', s.avgDurationMin],
    ]),
    card('Economics: AI コスト（概算）', [
      ['会話（LLM）呼び出し回数', s.usage.llmCalls],
      ['会話のコスト（円）', s.usage.llmCostJpy],
      ['音声（Gemini）作成回数', s.usage.geminiTtsCalls],
      ['音声のコスト（円）', s.usage.geminiTtsCostJpy],
      ['入力トークン（会話＋音声）', s.usage.inputTokens],
      ['出力トークン（会話＋音声）', s.usage.outputTokens],
      ['合計コスト（円）', s.usage.totalCostJpy],
      ['1 利用あたり（円）', s.usage.costPerSessionJpy],
      ['STT 利用回数（ブラウザ・無料）', s.usage.sttCount],
      ['端末の音声 読み上げ文字数（無料）', s.usage.ttsChars],
    ]),
    card('Experience: アンケート', [
      ['回答数', s.survey.n],
      ['満足度（1–5）', s.survey.satisfactionAvg],
      ['推奨度（0–10）', s.survey.recommendAvg],
      ...entries(s.survey.price).map(([k, v]) => [`価格: ${k}`, v]),
      ...entries(s.survey.screen).map(([k, v]) => [`画面: ${k}`, v]),
    ]),
    card('次に興味があるもの', entries(s.survey.next)),
    card('言語 / モード', [...entries(s.language).map(([k, v]) => [`言語 ${k}`, v]), ...entries(s.mode).map(([k, v]) => [`モード ${k}`, v])]),
    card('Check-in', [...entries(s.checkinState).map(([k, v]) => [`状態 ${k}`, v]), ...entries(s.checkinDesire).map(([k, v]) => [`希望 ${k}`, v])]),
    card('Spot 到達（セッション数）', entries(s.spotReach)),
    card('Nature Interaction 実行', [...entries(s.interactions), ['静けさの平均（秒）', s.silenceAvgSec]]),
    card('ガイドさんへの質問（guide_ask）', [['質問回数', s.guideAsks.total], ...entries(s.guideAsks.answered).map(([k, v]) => [`返事: ${k}`, v])]),
    card('LLM 呼び出しの内訳（purpose）', entries(s.usage.byPurpose)),
    card('質問', [['合計', s.questions.total], ...entries(s.questions.byInput).map(([k, v]) => [`入力: ${k}`, v])]),
    card('Technology: エラー', entries(s.errors)),
    notes,
    refl,
  );
}
$('#reload').addEventListener('click', load);
$('#logout').addEventListener('click', () => { sessionStorage.removeItem('guideToken'); load(); });
$('#login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await fetch('/api/guide/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: $('#passcode').value }) });
  if (!r.ok) { $('#login-error').textContent = r.status === 429 ? '試行回数が多すぎます。しばらくしてからもう一度お試しください' : '合言葉が違います'; return; }
  sessionStorage.setItem('guideToken', (await r.json()).token);
  $('#passcode').value = ''; $('#login-error').textContent = '';
  load();
});
load();
