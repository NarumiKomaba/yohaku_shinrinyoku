// 端末内で判定する音声コマンド（DOM 非依存）
// 「もう少しゆっくり話して」「faster」などを端末内で判定する。-1: ゆっくり / +1: 速く / 0: 指示ではない
export function rateCommand(text) {
  const t = String(text || '');
  if (/(ゆっくり|遅く|おそく).{0,6}(話|しゃべ|喋|読)|(話|しゃべ|喋).{0,6}(ゆっくり|遅く)|slow(er)?\b.{0,12}(speak|talk)|(speak|talk).{0,12}slow/i.test(t)) return -1;
  if (/(早く|速く|はやく|早め|速め).{0,6}(話|しゃべ|喋|読)|(話|しゃべ|喋).{0,6}(早く|速く|はやく|早め|速め)|早口|fast(er)?\b.{0,12}(speak|talk)|(speak|talk).{0,12}fast|speed up/i.test(t)) return 1;
  return 0;
}
