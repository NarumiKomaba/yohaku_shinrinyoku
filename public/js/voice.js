// 音声合成と音声認識の薄いラッパー。読み上げは、サーバーの Gemini 音声（fetchAudio）を先に試し、だめならブラウザ標準の音声合成 (speechSynthesis) に切り替える
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export class Voice {
  constructor() {
    this.synth = window.speechSynthesis;
    this.lang = 'ja';
    this.rate = 1.05;
    this.sentencePauseMs = 700; // 文と文の間
    this._pauseCancel = null;
    this.voice = null;
    this.fetchAudio = null; // async (text) => base64 の WAV。設定すると Gemini の音声で読み上げる（失敗したら端末の音声）
    this._audio = null;
    this._audioCache = new Map(); // 同じ文の音声（base64）は同じ体験の中で取り直さない。50 件まで、古いものから消す
    this._remoteOffUntil = 0; // Gemini の音声が失敗したら、しばらく端末の音声だけにする
    this.onSpeak = null; // (chars) => void  利用量ログ用
    this.onError = null; // (errorType, sentence) => void  読み上げ失敗の通知（not-allowed 等）
    this._token = 0;
    this._recognizer = null;
    if (this.synth) this.synth.onvoiceschanged = () => this._pickVoice();
  }

  get canSpeak() { return Boolean(this.synth || this.fetchAudio); }
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
    if (this.fetchAudio) this._unlockAudio();
    if (!this.synth) return;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    this.synth.speak(u);
  }

  // 音声ファイルの再生も、ユーザー操作の中で一度鳴らしておく（無音の短い WAV）
  _unlockAudio() {
    try {
      this._audio ||= new Audio();
      this._audio.src = URL.createObjectURL(new Blob([silentWav()], { type: 'audio/wav' }));
      this._audio.play().catch(() => {});
    } catch { /* 端末の音声に任せる */ }
  }

  // Gemini の音声で読み上げる。cancel() されたら false、使えなかったら null（端末の音声に切り替える）
  async _speakRemote(text, token) {
    if (Date.now() < this._remoteOffUntil) return null;
    let b64 = this._audioCache.get(text);
    if (!b64) {
      try {
        b64 = await this.fetchAudio(text);
      } catch { b64 = null; }
      if (b64) {
        this._audioCache.set(text, b64);
        if (this._audioCache.size > 50) this._audioCache.delete(this._audioCache.keys().next().value);
      }
    }
    if (token !== this._token) return false;
    if (!b64) { this._remoteOffUntil = Date.now() + 60_000; return null; }
    return new Promise((resolve) => {
      let url;
      const done = (v) => {
        this._pendingResolve = null;
        this._audio.onended = this._audio.onerror = null;
        URL.revokeObjectURL(url);
        resolve(v);
      };
      try {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
        this._audio ||= new Audio();
        this._audio.onended = () => done(token === this._token);
        this._audio.onerror = () => done(token === this._token ? null : false);
        this._audio.src = url;
        this._pendingResolve = (ok) => { this._audio.pause(); done(ok); };
        this._audio.play().catch(() => done(token === this._token ? null : false));
      } catch {
        done(null);
      }
    });
  }

  // 長文は Chrome で途中停止するため文単位に分割して順に読み上げる。cancel() で中断すると false で resolve。
  async speak(text) {
    if (!text || !(this.synth || this.fetchAudio)) return true;
    const token = ++this._token;
    if (this.fetchAudio) {
      const r = await this._speakRemote(String(text), token);
      if (r !== null) {
        if (r) this.onSpeak?.(text.length);
        return r;
      }
      if (!this.synth) return true;
    }
    const sentences = String(text).match(/[^。．！？!?.]+[。．！？!?.]?/g) || [text];
    this.onSpeak?.(text.length);
    for (const s of sentences) {
      if (token !== this._token) return false;
      const ok = await this._speakOne(s.trim(), token);
      if (!ok) return false;
      if (s !== sentences[sentences.length - 1] && !(await this.pause(this.sentencePauseMs))) return false;
    }
    return token === this._token;
  }

  _speakOne(sentence, token, retry = false) {
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
        this._speakOne(sentence, token, true).then(resolve);
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

let audioCtx;
// 無音の WAV（0.1 秒・8kHz・16bit モノラル）
function silentWav() {
  const data = 1600;
  const b = new DataView(new ArrayBuffer(44 + data));
  const w = (o, s) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); b.setUint32(4, 36 + data, true); w(8, 'WAVEfmt ');
  b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
  b.setUint32(24, 8000, true); b.setUint32(28, 16000, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true);
  w(36, 'data'); b.setUint32(40, data, true);
  return b.buffer;
}

// 静けさの終わりを知らせる、ごく小さな鐘の音（WebAudio）
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
