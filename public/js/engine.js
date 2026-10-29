// Refresh Walk エンジン
// Slow down（定型）→ 各 Spot（その場で narrate）→ Reflect/Return（定型）を進行する。
// UI には依存しない（イベントで状態を通知する）。
import { softChime, listenCue } from './voice.js';
import { MotionTracker, distanceM, compassIndex } from './motion.js';

export { distanceM };

const INTERACTION_GAP_MS = 4000; // 指示の後、実際にやってみるための間
const PHASE_OF = { LOOK: 'notice', LISTEN: 'notice', WALK: 'walk', STOP: 'pause', REST: 'pause', SILENCE: 'pause' };
const PREFETCH_MARGIN_M = 60; // Spot の半径 + これ以内に近づいたら arrive を先読み
const LEAVE_FACTOR = 1.5; // 半径 × これを超えたら離脱
const NARRATE_TIMEOUT_MS = 8000;
const LINGER_SEC = 45;
const LINGER_MAX = 2;
const ASK_MIC_MS = 8000; // 声の返事を待つ時間
const ASK_TIMEOUT_MS = 12000; // 無返事なら静かに見守る
const CLOSE_DWELL_SEC = 30; // 全 Spot 訪問後、最後の Spot でこれだけ止まったら締めへ
const AUTO_LISTEN_MS = 4000; // 区切りで自動で聞く時間
const MIN_HEARD_CHARS = 2; // これ未満は雑音とみなして無視
const TOPIC_PAUSE_MS = 1200; // 話題の切れ目の間
const SENTENCE_PAUSE_MS = 700; // 文と文の間（narrate の各文の間）
const FALLBACK_ORDER = ['must', 'fact', 'sense', 'story', 'notice'];

const sentencesOf = (text) => (String(text || '').match(/[^。．！？!?.]+[。．！？!?.]?/g) || []).map((x) => x.trim()).filter(Boolean);

export class WalkEngine extends EventTarget {
  // narrate: async (payload, signal) => レスポンス（/api/narrate）
  constructor({ voice, scenario, spots, lang, checkin, settings, log, narrate, history, now }) {
    super();
    this.voice = voice;
    this.scenario = scenario;
    this.spots = spots.filter((s) => s.enabled !== false).sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    this.lang = lang;
    this.checkin = checkin;
    this.settings = { silenceEnd: 'auto', autoListen: true, ...settings };
    this.log = log || (() => {});
    this.narrateFn = narrate || (async () => { throw new Error('no narrate'); });
    this.history = history || [];
    this.now = now || (() => Date.now());
    this.motion = new MotionTracker({ now: this.now });

    this.state = scenario.checkin.states.find((s) => s.id === checkin.state);
    this.desire = scenario.checkin.desires.find((d) => d.id === checkin.desire);
    this.totalMin = checkin.durationMin || null; // null = 時間を気にしない

    this.queue = [];
    this.visited = new Set();
    this.spoken = {}; // spotId -> Set(素材 id)
    this.spokenTexts = {}; // spotId -> この Spot で話した文（繰り返し防止用）
    this.asked = new Set(); // 質問済みの spotId
    this.lingers = {}; // spotId -> 回数
    this._prefetch = new Map(); // spotId -> { promise, count }
    this.status = 'idle';
    this.phase = null;
    this.paused = false;
    this.talking = false;
    this.ended = false;
    this.closing = false;
    this.currentSpot = null;
    this.position = null;
    this.lastActivity = this.now();
    this.startedAt = null;
    this.counts = { silences: 0, interactions: 0, cues: 0, narrates: 0, asks: 0 };
    this._used = {};
    this._running = false;
    this._cancelWait = null;
    this._silence = null;
    this._ask = null;
    this._autoListening = false;
    this._timeUpAsked = false;
  }

  // ---------- 公開 API ----------
  start() {
    this.startedAt = this.now();
    const t = (o) => o[this.lang] || o.ja;
    this.queue.push({ kind: 'phase', phase: 'slowdown' });
    for (const line of t(this.scenario.opening)) this.queue.push({ kind: 'say', text: line, pause: true });
    if (this.state) this.queue.push({ kind: 'say', text: t(this.state.cue), pause: true });
    this.queue.push({ kind: 'phase', phase: 'walk' }, { kind: 'listen' });
    this._tickTimer = setInterval(() => this._tick(), 1000);
    this._loop();
  }

  onPosition(lat, lng, accuracy) {
    if (this.ended) return;
    this.position = { lat, lng, accuracy };
    this.motion.push(lat, lng, accuracy);
    if (!this.closing && !(accuracy > 60)) this._checkSpots();
    this._emit('position', { position: this.position, next: this.nextSpot() });
  }

  // いちばん近い未訪問の Spot（位置が分かる前はおすすめ順の先頭）
  nextSpot() {
    const rest = this.spots.filter((x) => !this.visited.has(x.id));
    if (!rest.length) return null;
    if (!this.position) return { spot: rest[0], distance: null };
    const scored = rest.map((spot) => ({ spot, distance: Math.round(distanceM(this.position, spot)) }));
    return scored.sort((a, b) => a.distance - b.distance)[0];
  }

  pause() {
    if (this.ended || this.paused) return;
    this.paused = true;
    this._interrupt();
    this._setStatus('paused');
  }

  resume() {
    if (this.ended || !this.paused) return;
    this.paused = false;
    this._setStatus('idle');
    this._loop();
  }

  // 質問開始: 案内を止める。静けさの最中なら、その静けさは終わったものとして扱う
  beginTalk() {
    if (this.ended) return;
    this.talking = true;
    const head = this.queue[0];
    if (head && head.kind === 'silence' && head.introDone && !head.over) {
      head.skip = true;
      this.log('silence_end', { reason: 'talk', actualSec: Math.round((this.now() - head.startedAt) / 1000) });
    }
    if (head && head.kind === 'ask') head.skip = true; // 自由に質問されたら、こちらからの質問は取り下げる
    this._interrupt();
    this._setStatus('listening');
  }

  // 読み上げる文は字幕としても通知する（Eyes Up を妨げない範囲で、音が出せなくても内容が分かるように）
  _speak(text) {
    if (text) this._emit('caption', { text });
    return this.voice.speak(text);
  }

  async answer(text) {
    this._setStatus('speaking');
    await this._speak(text);
  }

  endTalk() {
    this.talking = false;
    this.lastActivity = this.now();
    if (this.ended) return;
    this._setStatus(this.paused ? 'paused' : 'idle');
    this._loop();
  }

  // 静けさの時間に「戻りました」
  userBack() {
    if (this._silence) this._silence.finish('manual');
  }

  // ask の選択ボタン（{optionId}）
  replyAsk(reply) {
    this._ask?.resolve({ via: 'button', ...reply });
  }

  // 終える: 残りの案内を捨てて Reflect → Return へ
  finish() {
    if (this.ended) return;
    this.paused = false;
    this.talking = false;
    this._interrupt();
    this._leaveSpot(true);
    this.queue = this._closingSteps();
    this._emit('finishing', {});
    this._loop();
  }

  abort() {
    this.ended = true;
    clearInterval(this._tickTimer);
    this._interrupt();
  }

  // シミュレーション用: 止まっている滞在秒数を進める
  debugAdvanceDwell(sec) {
    this.motion.skipDwell(sec);
  }

  get elapsedSec() {
    return this.startedAt ? Math.round((this.now() - this.startedAt) / 1000) : 0;
  }

  // ---------- 内部 ----------
  _emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _setStatus(status, extra = {}) {
    this.status = status;
    this._emit('status', { status, ...extra });
  }

  _setPhase(phase) {
    if (this.phase === phase) return;
    this.phase = phase;
    this._emit('phase', { phase });
  }

  // scenario.phrases の {x} 置換。phrases が無いシナリオでは空文字を返す
  _phrase(key, vars = {}) {
    const ph = this.scenario.phrases?.[key];
    const tpl = ph && (Array.isArray(ph[this.lang] || ph.ja) ? null : (ph[this.lang] || ph.ja));
    if (!tpl) return '';
    return Object.entries(vars).reduce((acc, [k, v]) => acc.replace(`{${k}}`, v), tpl);
  }

  _unit(kind, n) {
    const u = this.scenario.phrases?.units;
    const tpl = u && (u[this.lang] || u.ja)[kind];
    return tpl ? tpl.replace('{n}', n) : `${n}`;
  }

  // 目安時間の言い方（90 秒未満は 5 秒単位の秒、以上は分）
  _durText(sec) {
    return sec < 90 ? this._unit('sec', Math.max(5, Math.round(sec / 5) * 5)) : this._unit('min', Math.round(sec / 60));
  }

  _timeBox(sec) {
    return this._phrase('timeBox', { t: this._durText(sec) });
  }

  _moveOnLine() {
    const list = this.scenario.phrases?.moveOn;
    const pool = list && (list[this.lang] || list.ja);
    return pool?.length ? pool[Math.floor(Math.random() * pool.length)] : '';
  }

  // いま何の時間か・あと何秒かを UI に知らせる（type が null なら終了）
  _setActivity(type, endsAt = null) {
    const label = type ? (this.scenario.activityLabels?.[type]?.[this.lang] || this.scenario.activityLabels?.[type]?.ja || '') : '';
    this._emit('activity', { type, label, endsAt });
  }

  // 次の Spot の予告（名前・方角（8 方位）・距離・目安分数）。歩く速さは本人の平均（0.6〜1.6 m/s、不明なら 1.1）
  _previewText() {
    const n = this.nextSpot();
    if (!n || !this.position) return '';
    const d = distanceM(this.position, n.spot);
    const dirs = this.scenario.phrases?.dirs;
    const dir = dirs && (dirs[this.lang] || dirs.ja)[compassIndex(this.position, n.spot)];
    if (!dir) return '';
    const dist = d < 1000 ? this._unit('m', d < 100 ? Math.max(10, Math.round(d / 10) * 10) : Math.round(d / 50) * 50) : this._unit('km', (d / 1000).toFixed(1));
    const min = this._unit('min', Math.max(1, Math.ceil(d / this.motion.avgWalkMps / 60)));
    return this._phrase('preview', { name: n.spot.name[this.lang] || n.spot.name.ja, dir, dist, min });
  }

  _pick(type) {
    const pool = this.scenario.interactionPools[type]?.[this.lang] || this.scenario.interactionPools[type]?.ja || [];
    const used = (this._used[type] ||= new Set());
    const fresh = pool.map((_, i) => i).filter((i) => !used.has(i));
    const idx = (fresh.length ? fresh : pool.map((_, i) => i))[Math.floor(Math.random() * (fresh.length || pool.length))];
    used.add(idx);
    return pool[idx] || '';
  }

  _closingSteps() {
    this.closing = true;
    const lines = this.scenario.closing[this.lang] || this.scenario.closing.ja;
    return [
      { kind: 'phase', phase: 'reflect' },
      ...lines.map((text) => ({ kind: 'say', text, pause: true })),
      { kind: 'phase', phase: 'return' },
      { kind: 'finish' },
    ];
  }

  // ---------- Spot の出入り ----------
  _checkSpots() {
    const pos = this.position;
    // 離脱: 半径 × 1.5 を超えた
    let left = false;
    if (this.currentSpot && distanceM(pos, this.currentSpot) > this.currentSpot.radius * LEAVE_FACTOR) { this._leaveSpot(); left = true; }

    const rest = this.spots
      .filter((s) => !this.visited.has(s.id))
      .map((spot) => ({ spot, d: distanceM(pos, spot) }))
      .sort((a, b) => a.d - b.d);

    // 入場
    const inside = rest.find((x) => x.d <= x.spot.radius);
    if (inside) { this._enterSpot(inside.spot); return; }

    // Spot を出て次へ向かうとき、次の場所を予告する
    if (left && rest.length) {
      const text = this._previewText();
      if (text) { this.queue.push({ kind: 'cue', text }); this._loop(); }
    }

    // 先読み: 近づいてきた Spot の arrive を先に作っておく
    for (const [id, p] of this._prefetch) {
      const sp = this.spots.find((s) => s.id === id);
      if (!sp || distanceM(pos, sp) > sp.radius + PREFETCH_MARGIN_M * 2) { if (p.done) this._prefetch.delete(id); }
    }
    const near = rest[0];
    if (near && near.d <= near.spot.radius + PREFETCH_MARGIN_M && !this._prefetch.has(near.spot.id)) {
      this._prefetch.set(near.spot.id, this._startNarrate({ trigger: 'arrive', spot: near.spot }));
    }
  }

  _enterSpot(spot) {
    if (this.currentSpot) this._leaveSpot();
    this.visited.add(spot.id);
    this.currentSpot = spot;
    this.motion.enterSpot();
    this.log('spot_reached', { spotId: spot.id, elapsedSec: this.elapsedSec });
    this._emit('spot', { spot });
    const pre = this._prefetch.get(spot.id);
    this._prefetch.delete(spot.id);
    this.queue.push({ kind: 'narrate', trigger: 'arrive', spot, promise: pre?.promise });
    this._loop();
  }

  // 離脱: その Spot の未読み上げ分は捨てる。話の途中なら文の切れ目で止まる
  _leaveSpot(all = false) {
    const spot = this.currentSpot;
    if (!spot) return;
    this.currentSpot = null;
    this.motion.leaveSpot();
    this._emit('spot', { spot: null });
    this._emit('ask', { ask: null });
    if (all) return;
    const head = this.queue[0];
    const mine = (st) => st.spot === spot;
    const headMine = head && mine(head);
    this.queue = this.queue.filter((st, i) => !mine(st) || (i === 0 && st.kind === 'narrate'));
    if (headMine && head.kind !== 'narrate') this._interrupt();
    if (!this.closing) this._setPhase('walk');
    this._loop();
  }

  _left(step) {
    return Boolean(step.spot) && this.currentSpot !== step.spot;
  }

  // ---------- narrate ----------
  _payload({ trigger, spot, pendingAsk = null, userReply = null, motion = null }) {
    const elapsedMin = Math.round(this.elapsedSec / 60);
    return {
      lang: this.lang,
      checkin: { state: this.checkin.state, desire: this.checkin.desire, durationMin: this.totalMin, note: this.checkin.note || '' },
      trigger,
      spotId: spot ? spot.id : null,
      motion: motion || this.motion.snapshot(spot),
      timing: { totalMin: this.totalMin, elapsedMin, remainingMin: this.totalMin ? Math.max(0, this.totalMin - elapsedMin) : null },
      spokenMaterialIds: spot ? [...(this.spoken[spot.id] || [])] : [],
      spokenTexts: spot ? (this.spokenTexts[spot.id] || []).slice(-6) : [],
      askedAtSpot: spot ? this.asked.has(spot.id) : false,
      pendingAsk,
      userReply,
      history: this.history.slice(-6),
      clientTime: new Date().toISOString(),
    };
  }

  // 8 秒以内に返らなければ素材から機械的に作る。戻り値は常に解決する Promise を持つ
  _startNarrate(opts) {
    const payload = this._payload(opts);
    const ac = new AbortController();
    let timer;
    // signal を無視する narrateFn でも確実にフォールバックへ進めるため、タイムアウトは race で待つ
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { ac.abort(); reject(new Error('narrate timeout')); }, NARRATE_TIMEOUT_MS);
    });
    const entry = { done: false };
    entry.promise = (async () => {
      this.counts.narrates++;
      try {
        const res = await Promise.race([this.narrateFn(payload, ac.signal), timeout]);
        if (!res || typeof res.say !== 'string') throw new Error('bad narrate');
        return res;
      } catch (e) {
        this.log('error', { where: 'narrate', message: e.message });
        return this._fallback(opts, payload);
      } finally {
        clearTimeout(timer);
        entry.done = true;
      }
    })();
    return entry;
  }

  _fallback({ trigger, spot, userReply }, payload) {
    const out = { say: '', ask: null, next: 'wait', interaction: null, silenceSec: null, usedMaterialIds: [], fallback: true };
    if (!spot || trigger === 'between') return out;
    if (trigger === 'reply' && userReply?.optionId === 'next') return { ...out, next: 'move_on' };
    const spoken = new Set(payload.spokenMaterialIds);
    const pool = (spot.materials || []).filter((m) => !spoken.has(m.id) && (!m.lang || m.lang === this.lang));
    for (const type of FALLBACK_ORDER) {
      const m = pool.find((x) => x.type === type);
      if (m) {
        const max = payload.motion.speedMps > 1.8 ? 2 : 3;
        return { ...out, say: sentencesOf(m.text).slice(0, max).join(this.lang === 'en' ? ' ' : ''), usedMaterialIds: [m.id] };
      }
    }
    // 「もっと」に出せる新しい素材が無ければ、正直に伝えて先へ
    if (trigger === 'reply') return { ...out, say: this.scenario.phrases?.endLine?.[this.lang] || this.scenario.phrases?.endLine?.ja || '', next: 'move_on' };
    return out;
  }

  async _execNarrate(step) {
    const spot = step.spot;
    this._setPhase('notice');
    step.promise ||= this._startNarrate({ trigger: step.trigger, spot, pendingAsk: step.pendingAsk, userReply: step.userReply, motion: step.motion }).promise;
    const res = await step.promise;
    if (this.ended || this.queue[0] !== step) return true; // finish() などで差し替わった
    if (this.paused || this.talking) return false; // 結果は保持して、再開時に読む
    if (this._left(step)) return true;

    if (!step.recorded) {
      step.recorded = true;
      const set = (this.spoken[spot.id] ||= new Set());
      for (const id of res.usedMaterialIds || []) set.add(id);
      if (res.say) {
        this.history.push({ role: 'model', text: res.say });
        (this.spokenTexts[spot.id] ||= []).push(...sentencesOf(res.say));
      }
      if (res.ask) this.asked.add(spot.id);
    }

    const sentences = sentencesOf(res.say);
    step.sentIdx ||= 0;
    this._setStatus('speaking');
    while (step.sentIdx < sentences.length) {
      if (this._left(step)) return true; // 文の切れ目で打ち切る
      if (!(await this._speak(sentences[step.sentIdx]))) return false;
      step.sentIdx++;
      if (step.sentIdx < sentences.length) await this.voice.pause?.(this.voice.sentencePauseMs ?? SENTENCE_PAUSE_MS);
    }
    if (this._left(step)) return true;

    if (!step.followed) {
      step.followed = true;
      const extra = [];
      if (res.ask) extra.push({ kind: 'ask', ask: res.ask, spot });
      else if (res.next === 'silence') extra.push({ kind: 'silence', seconds: res.silenceSec || 60, text: this._pick('SILENCE'), spot });
      else if (res.next === 'interaction' && res.interaction) extra.push({ kind: 'interaction', type: res.interaction, text: this._pick(res.interaction), spot });
      this.queue.splice(1, 0, ...extra);
      if (!extra.length && res.next !== 'silence' && res.next !== 'interaction' && res.say) await this._autoListen();
    }
    return true;
  }

  // ---------- ask（質問 → ボタン表示 → 約 8 秒マイク → 返事） ----------
  async _execAsk(step) {
    const { ask } = step;
    if (!step.spoken) {
      this._setStatus('speaking');
      if (!(await this._speak(ask.text))) return false;
      step.spoken = true;
      this.counts.asks++;
      if (!step.local) {
        this.log('guide_ask', { spotId: step.spot.id });
        this.history.push({ role: 'model', text: ask.text });
      }
    }
    if (this._left(step)) return true;
    this._setStatus('asking');
    this._emit('ask', { ask });
    const reply = await this._waitReply();
    this._emit('ask', { ask: null });
    if (reply.interrupted) return false;
    if (this.ended || this.queue[0] !== step) return true;

    const spotId = step.spot ? step.spot.id : null;
    if (reply.via === 'timeout') {
      this.log('guide_ask_reply', { via: 'timeout', spotId }); // 返事が無ければ、静かに見守る
      return true;
    }
    this.log('guide_ask_reply', { via: reply.via, optionId: reply.optionId || null, spotId });
    if (step.local) {
      const id = reply.optionId || (/終|おわ|やめ|end|finish|stop|done/i.test(reply.text || '') ? 'end' : 'more');
      if (id === 'end') this.finish();
      return true;
    }
    const label = ask.options.find((o) => o.id === reply.optionId)?.label;
    this.history.push({ role: 'user', text: reply.text || label || '' });
    this.queue.splice(1, 0, {
      kind: 'narrate', trigger: 'reply', spot: step.spot, pendingAsk: ask,
      userReply: reply.optionId ? { optionId: reply.optionId } : { text: reply.text },
    });
    return true;
  }

  _waitReply() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        clearTimeout(t12);
        clearTimeout(t8);
        this._ask = null;
        this.voice.stopListening?.();
        resolve(r);
      };
      this._ask = { resolve: finish };
      const t12 = setTimeout(() => finish({ via: 'timeout' }), ASK_TIMEOUT_MS);
      const t8 = setTimeout(() => this.voice.stopListening?.(), ASK_MIC_MS);
      if (this.voice.canListen) {
        this.voice.listen().then((text) => {
          this.log('stt_used', { ok: Boolean(text), purpose: 'ask' });
          if (text) finish({ via: 'voice', text });
        }).catch(() => {});
      }
    });
  }

  // 区切り（Spot の案内の後、Silence 明け）で数秒だけ聞く。話さなければ何もしない
  async _autoListen() {
    if (!this.settings.autoListen || !this.voice.canListen || this.paused || this.talking || this.ended || this.closing) return;
    this._autoListening = true;
    this._emit('listen', { on: true });
    listenCue();
    const timer = setTimeout(() => this.voice.stopListening?.(), AUTO_LISTEN_MS);
    let text = '';
    try {
      text = (await this.voice.listen()) || '';
    } catch (e) {
      this.log('error', { where: 'stt-auto', message: e.message });
      // マイクの許可が無いときだけ以後は試さない。no-speech / aborted / network などは一時的なので続ける
      if (/not-allowed/.test(e.message)) this.settings.autoListen = false;
    } finally {
      clearTimeout(timer);
      this._autoListening = false;
      this._emit('listen', { on: false });
    }
    text = text.trim();
    if (text.length < MIN_HEARD_CHARS || this.paused || this.talking || this.ended) return;
    this.log('stt_used', { ok: true, purpose: 'auto' });
    this._emit('heard', { text });
  }

  _timeUpAsk() {
    const t = (o) => o[this.lang] || o.ja;
    const tu = this.scenario.timeUp;
    return {
      text: t(tu.text),
      options: tu.options.map((o) => ({ id: o.id, label: t(o.label) })),
      defaultId: 'more',
    };
  }

  // ---------- 進行ループ ----------
  async _loop() {
    if (this._running) { this._rerun = true; return; }
    this._running = true;
    const canRun = () => this.queue.length && !this.paused && !this.talking && !this.ended;
    do {
      this._rerun = false;
      while (canRun()) {
        const step = this.queue[0];
        const completed = step.skip || (await this._exec(step));
        if (!completed) break; // 中断された: 先頭に残し、再開時にやり直す
        if (this.queue[0] === step) this.queue.shift(); // finish() でキューが差し替わっていれば触らない
        this.lastActivity = this.now();
      }
    } while (this._rerun && canRun());
    this._running = false;
    if (!this.queue.length && !this.paused && !this.talking && !this.ended) this._setStatus('idle');
  }

  async _exec(step) {
    switch (step.kind) {
      case 'phase':
        this._setPhase(step.phase);
        return true;
      case 'say': {
        this._setStatus('speaking');
        const ok = await this._speak(step.text);
        if (ok && step.pause) await this.voice.pause?.(TOPIC_PAUSE_MS);
        return ok;
      }
      case 'listen':
        await this._autoListen();
        return true;
      case 'narrate':
        return this._execNarrate(step);
      case 'ask':
        return this._execAsk(step);
      case 'interaction': {
        this._setPhase(PHASE_OF[step.type] || 'notice');
        const sec = this.scenario.interactionSec?.[step.type]; // 目安時間（無ければ従来どおり短い間だけ）
        if (!step.said) {
          this._setStatus('speaking', { interaction: step.type });
          const lead = sec ? this._timeBox(sec) : '';
          if (!(await this._speak(`${lead}${step.text}`))) return false;
          step.said = true;
          step.remainingMs = sec ? sec * 1000 : INTERACTION_GAP_MS;
          this.counts.interactions++;
          this.log('interaction', { kind: step.type, spotId: this.currentSpot?.id || null });
        }
        this._setStatus('idle');
        const began = this.now();
        if (sec) this._setActivity(step.type, began + step.remainingMs);
        const waited = await this._wait(step.remainingMs);
        if (sec) this._setActivity(null);
        if (!waited) { step.remainingMs = Math.max(0, step.remainingMs - (this.now() - began)); return false; }
        step.remainingMs = 0;
        if (sec && !step.closed) {
          step.closed = true; // 終わりの区切りの一言
          this._setStatus('speaking');
          if (!(await this._speak(this._moveOnLine()))) return false;
        }
        await this._autoListen();
        return true;
      }
      case 'silence':
        return this._execSilence(step);
      case 'cue': {
        this._setPhase('walk');
        this._setStatus('speaking');
        if (!(await this._speak(step.text))) return false;
        await this._autoListen();
        return true;
      }
      case 'finish':
        this.ended = true;
        clearInterval(this._tickTimer);
        this._setStatus('ended');
        this._emit('finished', { elapsedSec: this.elapsedSec, visited: [...this.visited], counts: this.counts });
        return true;
      default:
        return true;
    }
  }

  async _execSilence(step) {
    this._setPhase('pause');
    if (!step.introDone) {
      this._setStatus('speaking', { interaction: 'SILENCE' });
      if (!(await this._speak(`${this._timeBox(step.seconds)}${step.text}`))) return false;
      step.introDone = true;
      step.startedAt = this.now();
      step.remainingMs = step.seconds * 1000;
      this.counts.silences++;
      this.log('interaction', { kind: 'SILENCE', spotId: this.currentSpot?.id || null, seconds: step.seconds });
    }
    this._setStatus('silence', { seconds: step.seconds, startedAt: step.startedAt });
    this._setActivity('SILENCE', this.now() + step.remainingMs);

    const reason = await new Promise((resolve) => {
      const began = this.now();
      let timer = null;
      const finish = (r) => {
        clearTimeout(timer);
        if (r === 'interrupted') step.remainingMs = Math.max(0, step.remainingMs - (this.now() - began));
        this._silence = null;
        resolve(r);
      };
      this._silence = { finish };
      timer = setTimeout(() => {
        // Intentional Silence の目安時間が過ぎた
        if (this.scenario.silenceChime !== false) softChime();
        step.remainingMs = 0;
        if (this.settings.silenceEnd === 'auto') finish('auto');
        else { this._setStatus('silence', { seconds: step.seconds, startedAt: step.startedAt, overtime: true }); this._setActivity('SILENCE', null); }
      }, step.remainingMs);
    });
    this._setActivity(null);
    if (reason === 'interrupted') return false;

    this.log('silence_end', { reason, plannedSec: step.seconds, actualSec: Math.round((this.now() - step.startedAt) / 1000) });
    step.over = true;
    this._setStatus('speaking');
    await this._speak(this.scenario.silenceEnd[this.lang] || this.scenario.silenceEnd.ja);
    await this._autoListen();
    return true;
  }

  _wait(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this._cancelWait = null; resolve(true); }, ms);
      this._cancelWait = () => { clearTimeout(timer); this._cancelWait = null; resolve(false); };
    });
  }

  _interrupt() {
    this.voice.cancel();
    this._cancelWait?.();
    this._silence?.finish('interrupted');
    this._ask?.resolve({ interrupted: true });
    if (this._autoListening) this.voice.stopListening?.();
  }

  // 1 秒ごと: 時間到達の確認 / 締め / linger / Spot 間の声かけ
  _tick() {
    if (this.paused || this.talking || this.ended || this.closing || this.queue.length || this.status !== 'idle') return;
    const snap = this.motion.snapshot(this.currentSpot);

    if (this.totalMin && !this._timeUpAsked && this.elapsedSec >= this.totalMin * 60) {
      this._timeUpAsked = true;
      this.queue.push({ kind: 'ask', ask: this._timeUpAsk(), local: true, spot: null });
      this._loop();
      return;
    }

    // 全 Spot を訪問済みで、最後の Spot で落ち着いたら（または離れたら）締めへ
    if (this.visited.size >= this.spots.length && this.spots.length && (!this.currentSpot || snap.dwellSec >= CLOSE_DWELL_SEC)) {
      this._leaveSpot(true);
      this.queue = this._closingSteps();
      this._loop();
      return;
    }

    const spot = this.currentSpot;
    if (spot) {
      if (!snap.moving && snap.dwellSec >= LINGER_SEC && (this.lingers[spot.id] || 0) < LINGER_MAX) {
        this.lingers[spot.id] = (this.lingers[spot.id] || 0) + 1;
        const motion = this.motion.snapshot(spot); // resetDwell の前の値を narrate に渡す
        this.motion.resetDwell();
        this.queue.push({ kind: 'narrate', trigger: 'linger', spot, motion });
        this._loop();
      }
      return;
    }

    // Spot 間: 歩いている間、長く無言が続いたら短い声かけを一つだけ。間隔は希望と歩く速さで調整
    if (!snap.moving) return;
    const factor = (this.desire?.cueFactor || 1) * (snap.speedMps > 1.6 ? 1.3 : 1);
    const interval = (this.scenario.walkCueIntervalSec || 240) * 1000 * factor;
    if (this.now() - this.lastActivity < interval) return;
    const pool = this.scenario.walkCues[this.lang] || this.scenario.walkCues.ja;
    if (this.counts.cues >= pool.length) return;
    this.counts.cues++;
    this.queue.push({ kind: 'cue', text: pool[(this.counts.cues - 1) % pool.length] });
    this._loop();
  }
}
