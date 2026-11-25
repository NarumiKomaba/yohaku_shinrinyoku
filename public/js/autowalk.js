// デモ用の自動歩行（画面に依存しない計算だけ）。
// スポットを、エンジンが「次」と案内する順（渡されなければ order の順）に、ふつうの歩く速さで進み、着いたら案内などが終わるまでその場で待つ。早送りはしない。
const M_PER_DEG_LAT = 111195;
export const MIN_SPEED_MPS = 1.1;
export const MAX_SPEED_MPS = 1.3;
const ARRIVE_M = 2; // スポットの中心にこれだけ近づいたら着いたとみなす
const MIN_DWELL_SEC = 3; // 着いてから最低限待つ秒数（エンジンが着いたことに気づく間）

const metres = (a, b) => {
  const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
  const dx = (b.lng - a.lng) * M_PER_DEG_LAT * Math.cos((a.lat * Math.PI) / 180);
  return { dx, dy, d: Math.hypot(dx, dy) };
};

export function routeLengthM(start, spots) {
  let len = 0;
  let prev = start;
  for (const s of spots) { len += metres(prev, s).d; prev = s; }
  return len;
}

// 時間を決めたとき（totalMin）は、その時間でだいたい回れるように速さと各スポットで待つ長さを決める
export function planAutoWalk(start, spots, totalMin) {
  if (!totalMin) return { speedMps: 1.2, dwellSec: MIN_DWELL_SEC };
  const totalSec = totalMin * 60;
  const len = routeLengthM(start, spots);
  const speedMps = Math.min(MAX_SPEED_MPS, Math.max(MIN_SPEED_MPS, len / (totalSec * 0.5)));
  const walkSec = len / speedMps;
  const dwellSec = Math.max(MIN_DWELL_SEC, (totalSec - walkSec) / Math.max(1, spots.length));
  return { speedMps, dwellSec };
}

// isSpotDone(spot): エンジンがそのスポットを訪れて、案内・問いかけ・静かな時間を終えたら true
// nextSpot(): エンジンが「次は○○です」と案内するスポット（なければ null）。渡されたら order ではなくこの案内の順に歩く
export function createAutoWalker({ start, spots, totalMin = null, isSpotDone, nextSpot = null }) {
  const plan = planAutoWalk(start, spots, totalMin);
  let pos = { ...start };
  let current = null; // いま向かっている（着いたら待っている）スポット。終わるまで変えない
  let over = false;
  let idx = 0; // nextSpot がないときの order の順の位置
  let dwell = 0;
  const target = () => {
    if (!current && !over) {
      current = (nextSpot ? nextSpot() : spots[idx++]) || null;
      if (!current) over = true;
    }
    return current;
  };

  return {
    plan,
    get pos() { return { ...pos }; },
    get finished() { target(); return over; },
    get targetSpot() { return target(); },
    // 手動で動かしたあとなどに、いまの位置から次の（まだ終わっていない）スポットへ向かい直す
    resume(p) {
      if (p) pos = { lat: p.lat, lng: p.lng };
      current = null;
      over = false;
      idx = Math.max(0, spots.findIndex((x) => !isSpotDone(x)));
      if (spots.every(isSpotDone)) idx = spots.length;
      dwell = 0;
    },
    tick(dtSec) {
      const s = target();
      if (!s) return { ...pos };
      const { dx, dy, d } = metres(pos, s);
      if (d > ARRIVE_M) {
        const step = Math.min(d, plan.speedMps * dtSec);
        pos = {
          lat: pos.lat + (dy / d) * step / M_PER_DEG_LAT,
          lng: pos.lng + (dx / d) * step / (M_PER_DEG_LAT * Math.cos((pos.lat * Math.PI) / 180)),
        };
        return { ...pos };
      }
      pos = { lat: s.lat, lng: s.lng };
      dwell += dtSec;
      if (dwell >= plan.dwellSec && isSpotDone(s)) { current = null; dwell = 0; }
      return { ...pos };
    },
  };
}
