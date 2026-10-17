// 端末内だけで速度・moving/stopped・滞在秒数を算出する（軌跡はサーバーに送らない）
export function distanceM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// from → to の方位を 8 方位の添字（0=北, 1=北東, 2=東 …）で返す
export function compassIndex(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return Math.round(deg / 45) % 8;
}

const WINDOW_MS = 20000; // 速度を見る直近の時間
const STALE_MS = 15000; // これより古い点しか無ければ止まっているとみなす
const MIN_SPAN_MS = 4000; // 速度を出すのに必要な最小の時間幅
const MAX_ACCURACY_M = 30; // これより精度の悪い点は使わない
const MOVING_MPS = 0.4; // これ以上なら moving（段階分けはしない）

export class MotionTracker {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.points = [];
    this.pos = null; // 最後の位置（精度が悪くても距離計算用に保持）
    this._stoppedSince = null;
    this._sumMoving = 0; // 移動中の速さの平均用
    this._nMoving = 0;
  }

  push(lat, lng, accuracy, t = this.now()) {
    this.pos = { lat, lng };
    if (accuracy != null && accuracy > MAX_ACCURACY_M) return;
    this.points.push({ lat, lng, t });
    this._trim(t);
    this.update();
  }

  _trim(t) {
    const from = t - WINDOW_MS;
    while (this.points.length && this.points[0].t < from) this.points.shift();
  }

  // 直近の始点と終点の変位 ÷ 時間（GPS のゆらぎで止まっていても動いて見えるのを避ける）
  get speedMps() {
    const t = this.now();
    this._trim(t);
    const pts = this.points;
    if (pts.length < 2) return 0;
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (t - last.t > STALE_MS || last.t - first.t < MIN_SPAN_MS) return 0;
    return distanceM(first, last) / ((last.t - first.t) / 1000);
  }

  // 移動中の平均の速さ（0.6〜1.6 m/s にクランプ。標本が少ないうちは 1.1）
  get avgWalkMps() {
    if (this._nMoving < 5) return 1.1;
    return Math.min(1.6, Math.max(0.6, this._sumMoving / this._nMoving));
  }

  get moving() {
    return this.speedMps >= MOVING_MPS;
  }

  // moving が変わるたびに呼ばれる前提で、止まった時刻を管理する
  update() {
    const t = this.now();
    const speed = this.speedMps;
    if (speed >= MOVING_MPS) {
      this._stoppedSince = null;
      this._sumMoving += speed;
      this._nMoving++;
    } else if (this._stoppedSince == null) this._stoppedSince = t;
  }

  // 止まっている間だけ増える滞在秒数（動き出すと 0 に戻る）
  get dwellSec() {
    this.update();
    return this._stoppedSince == null ? 0 : Math.round((this.now() - this._stoppedSince) / 1000);
  }

  enterSpot() { this._stoppedSince = null; this.update(); }
  leaveSpot() { this._stoppedSince = null; }
  resetDwell() { this._stoppedSince = this.now(); }
  skipDwell(sec) { this.update(); if (this._stoppedSince != null) this._stoppedSince -= sec * 1000; }

  snapshot(spot) {
    const speed = this.speedMps;
    return {
      moving: speed >= MOVING_MPS,
      speedMps: Math.round(speed * 100) / 100,
      dwellSec: this.dwellSec,
      distanceToSpotM: spot && this.pos ? Math.round(distanceM(this.pos, spot)) : null,
    };
  }
}
