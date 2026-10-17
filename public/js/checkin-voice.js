// 音声チェックイン: 問いかけ → 聞き取り → 抽出 → 確認 → 返事。画面のチップとは app.js 側で同期する。
const LISTEN_MS = 10000;
const YES = /はい|ええ|うん|オーケー|ＯＫ|ok|おっけ|お願い|よろしい|いいです|いいよ|それで|yes|yeah|yep|sure|right|good|sounds/i;
const NO = /いいえ|いや|違|ちがう|やめ|修正|直し|変え|\bno\b|nope|change|not/i;

// 声 / ボタンの先着で返す。{text} {button} {error} {cancelled}
function listenOnce(vc) {
  return new Promise((resolve) => {
    // 読み上げ中に止められていたら、マイクを開かない
    if (vc.cancelled) return resolve({ cancelled: true });
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(t1);
      clearTimeout(t2);
      vc.onButton = null;
      vc.cancelHook = null;
      vc.voice.stopListening();
      resolve(r);
    };
    const t1 = setTimeout(() => vc.voice.stopListening(), LISTEN_MS);
    const t2 = setTimeout(() => finish({ text: '' }), LISTEN_MS + 3000);
    vc.onButton = (id) => finish({ button: id });
    vc.cancelHook = () => finish({ cancelled: true });
    vc.voice.listen().then((text) => finish({ text })).catch((error) => finish({ error }));
  });
}

const CANCEL = Symbol('cancel');
const FALLBACK = Symbol('fallback');
const MAX_FOLLOWUPS = 2; // 足りない項目の聞き直しは全体で最大 2 回（同一項目は 1 回まで）。超えたら既定値で進む

// 聞き取って返す。無音は 1 回だけ聞き直し、それでも無ければチップへ。マイク拒否は即チップへ
async function hearText(vc) {
  for (let i = 0; i < 2; i++) {
    vc.setStatus(vc.S().vcListening);
    const r = await listenOnce(vc);
    if (vc.cancelled) throw CANCEL;
    if (r.error) throw FALLBACK;
    if (r.text) return r;
    if (i === 0) await vc.say(vc.S().vcRetry);
  }
  throw FALLBACK;
}

// 'done' | 'fallback'（チップで続ける）| 'cancelled'
export async function runVoiceCheckin(vc) {
  try {
    return await flow(vc);
  } catch (e) {
    if (e === CANCEL) return 'cancelled';
    if (e === FALLBACK) return 'fallback';
    throw e;
  }
}

async function flow(vc) {
  const S = vc.S;
  await vc.say(S().vcAsk);
  let res = await parse(vc, (await hearText(vc)).text);
  const asked = new Set();
  let followups = 0;
  for (let guard = 0; guard < 8; guard++) {
    if (vc.cancelled) throw CANCEL;
    if (res.missing.length) {
      const fresh = res.missing.filter((k) => !asked.has(k));
      if (fresh.length && followups < MAX_FOLLOWUPS) {
        followups++;
        fresh.forEach((k) => asked.add(k));
        await vc.say(fresh.map((k) => S().vcMissing[k]).join(''));
        res = await parse(vc, (await hearText(vc)).text);
        continue;
      }
      // 答えが得られなかった項目は既定値で進み、確認の一言で伝える
      vc.setDefaults(res.missing);
      res = { ...res, missing: [], confirmText: vc.defaultConfirmText() };
    }
    // 確認 → 返事（はい / いいえ・修正）
    vc.showConfirm(true);
    await vc.say(res.confirmText);
    if (vc.cancelled) throw CANCEL;
    vc.setStatus(S().vcListening);
    let r = await listenOnce(vc);
    if (vc.cancelled) throw CANCEL;
    if (r.error || (!r.text && !r.button)) { vc.showConfirm(false); throw FALLBACK; }
    const t = r.text || '';
    if (r.button === 'yes' || (YES.test(t) && !NO.test(t))) { vc.showConfirm(false); return 'done'; }
    let fix = t;
    if (r.button === 'fix' || (NO.test(t) && t.length <= 6)) {
      await vc.say(S().vcFixAsk);
      vc.setStatus(S().vcListening);
      const f = await listenOnce(vc);
      if (vc.cancelled) throw CANCEL;
      if (!f.text) { vc.showConfirm(false); throw FALLBACK; }
      fix = f.text;
    }
    res = await parse(vc, fix);
  }
  vc.showConfirm(false);
  throw FALLBACK;
}

async function parse(vc, text) {
  vc.setStatus(vc.S().vcThinking);
  let res;
  try {
    res = await vc.parse(text);
  } catch {
    throw FALLBACK;
  }
  if (vc.cancelled) throw CANCEL;
  vc.apply(res);
  return res;
}
