// 音声合成（Gemini の音声 /api/tts を優先、だめならブラウザ標準の speechSynthesis）と音声認識 (SpeechRecognition) の薄いラッパー
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const REMOTE_TIMEOUT_MS = 8000; // Gemini の音声がこれより遅ければブラウザの音声に切り替える
const REMOTE_MAX_FAILS = 3; // 続けて失敗したら、以後はブラウザの音声だけにする
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

export class Voice {
  constructor() {
    this.synth = window.speechSynthesis;
    this.lang = 'ja';
    this.rate = 1.05;
    this.sentencePauseMs = 700; // 文と文の間
    this._pauseCancel = null;
    this.voice = null;
    this.onSpeak = null; // (chars) => void  利用量ログ用
    this.onError = null; // (errorType, sentence) => void  読み上げ失敗の通知（not-allowed 等）
    this._token = 0;
    this.remote = false; // Gemini の音声を使うか（app.js が /api/config を見て決める）
    this.token = null; // セッショントークン（X-Session-Token）
    this._audio = null; // 再生中の Audio
    this._abort = new Set(); // 取得中の fetch の AbortController
    this._fails = 0;
    this._recognizer = null;
    if (this.synth) this.synth.onvoiceschanged = () => this._pickVoice();
  }

  get canSpeak() { return Boolean(this.synth) || this.remote; }
  get canListen() { return Boolean(Recognition); }

  setLang(lang) {
    this.lang = lang;
    this._pickVoice();
  }

  _pickVoice() {
    if (!this.synth) return;
    const prefix = this.lang === 'en' ? 'en' : 'ja';
    const voices = this.synth.getVoices().filter((v) => v.lang.toLowerCase().startsWith(prefix));
    // ネットワーク音声（Chrome の Google 音声など）は無言で止まることがあるため、端末内の音声を優先する
    const local = voices.filter((v) => v.localService);
    const nice = (list) => list.find((v) => /natural|kyoko|o-ren|nanami|haruka|samantha|aria/i.test(v.name));
    this.voice = nice(local) || local[0] || nice(voices) || voices[0] || null;
  }

  // iOS/Android ではユーザー操作の中で一度発話させないと以後の自動発話がブロックされる
  unlock() {
    try { const a = new Audio(SILENT_WAV); a.volume = 0; a.play().catch(() => {}); } catch { /* 無音の再生が許されなくても続ける */ }
    if (!this.synth) return;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    this.synth.speak(u);
  }

  // Gemini の音声（WAV）を取って blob: URL にする。失敗・上限・時間切れは null（呼び出し側がブラウザの音声に切り替える）
  async _fetchAudio(sentence) {
    const ctrl = new AbortController();
    this._abort.add(ctrl);
    const timer = setTimeout(() => ctrl.abort(), REMOTE_TIMEOUT_MS);
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.token ? { 'X-Session-Token': this.token } : {}) },
        body: JSON.stringify({ text: sentence, lang: this.lang }),
        signal: ctrl.signal,
      });
      const data = await res.json();
      if (!res.ok || data.fallback || !data.audio) return null;
      const bin = atob(data.audio);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return URL.createObjectURL(new Blob([bytes], { type: data.mime || 'audio/wav' }));
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      this._abort.delete(ctrl);
    }
  }

  // 取得の結果を数える。続けて失敗したらこの体験の間はブラウザの音声に固定する
  _noteRemote(url) {
    if (url) { this._fails = 0; return; }
    if (++this._fails >= REMOTE_MAX_FAILS) this.remote = false;
  }

  // Gemini の音声を再生する。再生できたら true / 中断されたら false / 再生できなければ null
  _playUrl(url, token) {
    return new Promise((resolve) => {
      const a = new Audio(url);
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        if (this._audio === a) this._audio = null;
        this._pendingResolve = null;
        URL.revokeObjectURL(url);
        resolve(v);
      };
      this._audio = a;
      this._pendingResolve = (ok) => { a.pause(); done(ok); };
      a.onended = () => done(token === this._token);
      a.onerror = () => done(token === this._token ? null : false);
      a.play().catch(() => done(token === this._token ? null : false));
    });
  }

  // 長文は Chrome で途中停止するため文単位に分割して順に読み上げる。cancel() で中断すると false で resolve。
  async speak(text) {
    if ((!this.synth && !this.remote) || !text) return true;
    const token = ++this._token;
    const sentences = String(text).match(/[^。．！？!?.]+[。．！？!?.]?/g) || [text];
    this.onSpeak?.(text.length);
    const clean = sentences.map((x) => x.trim());
    // Gemini の音声は次の文を先に取っておき、待ち時間を減らす
    const audio = clean.map(() => null);
    const prefetch = (i) => { if (this.remote && clean[i] && !audio[i]) audio[i] = this._fetchAudio(clean[i]); };
    prefetch(0);
    for (let i = 0; i < sentences.length; i++) {
      if (token !== this._token) return false;
      prefetch(i + 1);
      const ok = await this._speakOne(clean[i], token, audio[i]);
      if (!ok) return false;
      if (i < sentences.length - 1 && !(await this.pause(this.sentencePauseMs))) return false;
    }
    return token === this._token;
  }

  // 1 文を読み上げる。Gemini の音声があればそれを再生し、取れない・再生できないときはブラウザの音声に切り替える
  async _speakOne(sentence, token, audioPromise) {
    if (audioPromise) {
      const url = await audioPromise;
      this._noteRemote(url);
      if (token !== this._token) { if (url) URL.revokeObjectURL(url); return false; }
      if (url) {
        const played = await this._playUrl(url, token);
        if (played !== null) return played;
      }
    }
    if (!this.synth) {
      // 読み上げる方法がないときも体験は止めず、字幕を読む時間だけ待つ
      this.onError?.('no-tts', sentence);
      return this.pause(Math.min(6000, sentence.length * 120));
    }
    return this._speakLocal(sentence, token);
  }

  _speakLocal(sentence, token, retry = false) {
    return new Promise((resolve) => {
      if (!sentence) return resolve(true);
      const u = new SpeechSynthesisUtterance(sentence);
      u.lang = this.lang === 'en' ? 'en-US' : 'ja-JP';
      if (this.voice && !retry) u.voice = this.voice;
      u.rate = this.rate;
      let settled = false;
      let watchdog = null;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        this._pendingResolve = null;
        resolve(ok);
      };
      // 読み上げ失敗だが完了扱いにして体験を止めない（画面の字幕を読む時間だけ待つ）
      const failSoft = (type) => {
        this.onError?.(type, sentence);
        const t = setTimeout(() => done(token === this._token), Math.min(6000, sentence.length * 120));
        this._pendingResolve = (ok) => { clearTimeout(t); done(ok); };
      };
      u.onstart = () => clearTimeout(watchdog);
      u.onend = () => done(token === this._token);
      u.onerror = (e) => {
        if (settled || u._abandoned) return;
        // cancel() による中断は false
        if (token !== this._token || e.error === 'interrupted' || e.error === 'canceled') return done(false);
        clearTimeout(watchdog);
        failSoft(e.error || 'error');
      };
      this._pendingResolve = done; // cancel 時に onend が来ないブラウザ対策
      // Chrome は音声が無言のまま始まらないことがある。4 秒で始まらなければ既定の音声で 1 回やり直し、それでもだめなら字幕だけで進める
      watchdog = setTimeout(() => {
        if (settled || token !== this._token) return;
        u._abandoned = true;
        this.synth.cancel();
        if (retry) return failSoft('no-start');
        settled = true;
        this._pendingResolve = null;
        this._speakLocal(sentence, token, true).then(resolve);
      }, 4000);
      if (this.synth.paused) this.synth.resume();
      this.synth.speak(u);
    });
  }

  // 間（ポーズ）。cancel() されたら false
  pause(ms) {
    const token = this._token;
    return new Promise((resolve) => {
      const t = setTimeout(() => { this._pauseCancel = null; resolve(token === this._token); }, ms);
      this._pauseCancel = () => { clearTimeout(t); this._pauseCancel = null; resolve(false); };
    });
  }

  cancel() {
    this._token++;
    this._pauseCancel?.();
    for (const c of this._abort) c.abort();
    this._audio?.pause();
    this.synth?.cancel();
    this._pendingResolve?.(false);
  }

  // 1 回分の発話を認識して文字列を返す
  listen() {
    return new Promise((resolve, reject) => {
      if (!Recognition) return reject(new Error('stt_unsupported'));
      const r = new Recognition();
      r.lang = this.lang === 'en' ? 'en-US' : 'ja-JP';
      r.interimResults = false;
      r.maxAlternatives = 1;
      let text = '';
      r.onresult = (e) => { text = Array.from(e.results).map((x) => x[0].transcript).join(''); };
      r.onerror = (e) => (e.error === 'no-speech' ? resolve('') : reject(new Error(`stt_${e.error}`)));
      r.onend = () => { this._recognizer = null; resolve(text.trim()); };
      this._recognizer = r;
      r.start();
    });
  }

  stopListening() {
    this._recognizer?.stop();
  }
}

// 静けさの終わりを知らせる、ごく小さな鐘の音（WebAudio）
let audioCtx;
export function softChime() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    for (const [freq, delay] of [[880, 0], [1320, 0.12]]) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t + delay);
      gain.gain.linearRampToValueAtTime(0.06, t + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 2.2);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t + delay);
      osc.stop(t + delay + 2.3);
    }
  } catch { /* 音が鳴らなくても体験は継続 */ }
}

// 「どうぞ」の合図: softChime よりずっと控えめな、ごく短い一音
export function listenCue() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 1046;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.02, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.4);
  } catch { /* 音が鳴らなくても体験は継続 */ }
}

export function unlockAudio() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume();
  } catch { /* noop */ }
}
