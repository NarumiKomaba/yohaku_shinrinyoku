# 運用ガイド — デジタルネイチャー＆ウェルネスインストラクター 皇居外苑版

## データとプライバシーの扱い

### 来園者が共有しないデータ

| 項目 | 保存 | 理由 |
|---|---|---|
| 移動軌跡（GPS 座標の時系列） | **保存しない** | プライバシー保護。位置判定は端末内で完結 |
| 音声ファイル | **保存しない** | 文字起こし後すぐ破棄（ストレージ・プライバシー節約） |
| 質問テキスト（声入力） | 既定：保存しない | `LOG_QUESTION_TEXT=1` で有効化時のみ記録 |

### 記録されるログ

**ファイル**: `data/logs/events.jsonl`（1 イベント = 1 行）

イベント種別（`type` フィールド）:
- `session_start` — ウォーク開始
- `checkin` — チェックイン回答（state, desire, note）
- `spot_reached` — Spot に接近
- `narrate` — AI が案内を生成（trigger, spotId, fallback フラグ）
- `guide_ask` — AI が質問を提示
- `guide_ask_reply` — 来園者の返事（via: button|voice|timeout）
- `interaction` — AI が推奨する行動（LOOK, LISTEN など）
- `silence_end` — Intentional Silence 終了
- `question_asked` — 来園者が自由質問
- `stt_used` — 音声認識使用
- `tts` — 音声読み上げ
- `reflection` — ふりかえり回答
- `survey` — アンケート回答
- `session_complete` — ウォーク完了
- `llm_usage` — LLM 呼び出し（コスト追跡用）
- `error` — エラー発生

**自由記述テキストの制限**: チェックイン note、質問、ふりかえりは **200 文字以内** に自動カット

### 購入履歴・チェックイン

**ファイル**: `data/logs/purchases.json`

```json
{
  "code": "DEMO2027",
  "count": 5,           // 使用回数
  "lastUsed": "2026-10-04T12:34:56.789Z",
  "checkins": [
    { "sessionId": "...", "lang": "ja", "timestamp": "...", "checkin": {...} }
  ]
}
```

## コスト管理

### Gemini API 使用量の確認

**ページ**: `/admin.html` → 集計ページ

1. ガイドさん合言葉（デフォルト `GAIEN-GUIDE`）でログイン
2. 「Economics」セクションで確認
   - 入力トークン、出力トークン
   - 推定コスト（JPY）
   - 用途別の内訳（`/api/narrate`, `/api/ask` など）

### 使いすぎを防ぐ設定（お試し版・公開時）

`NODE_ENV=production`（Dockerfile で設定済み）で起動すると、次の設定が足りないときは起動しません。
- `GUIDE_PASSCODE` が 16 文字以上で設定されている
- `DEMO_CODES` が設定されていて、`DEMO2027` を含まず、どのコードも 8 文字以上
- 購入（モック）は既定で止まる（`PURCHASE_ENABLED=1` のときだけ有効）

| 変数 | おすすめ | 効果 |
|---|---|---|
| `DEMO_CODES=<配る用のコード>` | 公開時は必須 | 初期値の `DEMO2027` を無効にし、画面にもコードを出さない |
| `GUIDE_PASSCODE=<16 文字以上のランダム値>` | 公開時は必須 | ガイドさんページ・集計ページの合言葉 |
| `LLM_DAILY_MAX` | 200 程度 | サーバー全体の 1 日の Gemini 呼び出し上限（体験者向けだけ）。超えると Gemini なしの案内になる |
| `NARRATE_MAX_PER_SESSION` | 40 程度 | 1 回の体験での案内の上限 |
| `SESSIONS_PER_CODE_DAILY` | 必要なら | 1 つのデモコードで 1 日に始められる体験の数 |
| `TRUSTED_PROXY_HOPS=1` | Cloud Run では必須 | 総当たり対策で、接続元 IP を正しく見分ける |

`LLM_DAILY_MAX` はメモリで数えるため、再起動や複数インスタンスでは正確な上限になりません。確実な上限は、GCP の Generative Language API のクォータ（1 日のリクエスト数）で設定してください（Vertex AI Express のキー `AQ.` を使う場合は、Vertex AI 側のクォータ）。

### アプリ側の守り（公開時）

- **総当たり対策**: `/api/session`（コード）と `/api/guide/login`（合言葉）は、同じ IP から 10 分で 10 回失敗すると 429 を返す。失敗はログに `[auth] invalid ...` と IP だけを残す（入力された値は残さない）
- **期限**: 体験者のセッションは 24 時間、ガイドさんのログインは 8 時間で切れる
- **イベント**: `/api/events` は体験アプリが送る種類だけを受け付け、文字列は 200 字まで、1 セッション 2,000 件まで。`llm_usage`・`purchase` はサーバーだけが書く
- **入力の大きさ**: 体験中の API とイベントは 64KB まで。チェックインなど LLM に渡す項目は切り詰める
- **エラー**: 想定外のエラーは `internal_error` とだけ返し、詳しい内容はサーバーのログにだけ出す
- **ヘッダー**: CSP（外部は Leaflet の unpkg・国土地理院の地図タイル・Overpass API だけ許可）、`X-Frame-Options: DENY`、`nosniff` など

### Cloud Run で動かすとき

- **インスタンスは最大 1**（`--max-instances 1`）。ログイン状態や上限の回数をメモリに持つため、複数に分かれるとログインが切れ、上限も正しく数えられない
- **データは残らない**: Cloud Run のファイルはメモリ上にあり、インスタンスが止まると消える。ガイドさんページで編集した Spot、`events.jsonl`、`purchases.json` は再起動で元に戻る（お試し版はそれでよい）
- 秘密の値（`GEMINI_API_KEY`・`DEMO_CODES`・`GUIDE_PASSCODE`）は `--set-secrets` で Secret Manager から渡す（`--set-env-vars` だとリビジョンの設定に平文で残る）

### コスト計算式

```
入力コスト（JPY）= 入力トークン ÷ 1,000,000 × 入力単価 × USD_JPY
出力コスト（JPY）= 出力トークン ÷ 1,000,000 × 出力単価 × USD_JPY
```

**デフォルト料金**（環境変数で上書き可）:
- `GEMINI_PRICE_IN_PER_M=0.3` — 入力 USD/100万トークン
- `GEMINI_PRICE_OUT_PER_M=2.5` — 出力 USD/100万トークン
- `USD_JPY=150` — USD/JPY 換算レート

### LLM 使用ログ

**ファイル**: `data/logs/events.jsonl` の `type: 'llm_usage'` イベント

```json
{
  "type": "llm_usage",
  "ts": "2026-10-04T12:34:56.789Z",
  "purpose": "narrate",           // narrate | ask | transcribe | extract
  "model": "gemini-2.5-flash",
  "inputTokens": 1234,
  "outputTokens": 567,
  "costJpy": 123.45
}
```

## バックアップ

### 自動バックアップ

**タイミング**: `data/spots.json` 更新時（ガイドさんページで保存したとき）

**ファイル名**: `data/logs/spots.backup-{timestamp}.json`

**例**:
```
spots.backup-1791071432324.json
spots.backup-1791071707342.json
spots.backup-1791071707367.json
```

タイムスタンプはミリ秒精度の Unix タイム。

### 手動バックアップ

本番環境で定期的に以下をバックアップしてください:

```
data/spots.json         — Spot 定義と素材
data/scenario.json      — ウォークプロトコル
data/knowledge.json     — 一般知識ベース
data/logs/              — イベントログ全体
```

推奨: 日次で `data/logs/events.jsonl` と `data/spots.json` を外部ストレージへ。

## トラブルシューティング

### GPS が動作しない
- ブラウザで位置情報許可を確認
- スマホの位置情報サービスが ON か確認
- スマホ実機の場合、HTTPS トンネル（cloudflared など）が必要
- iOS の場合、「プライバシー設定 > 位置情報」でブラウザを許可

### 音声読み上げ（TTS）が無音
- ブラウザの音量確認
- スマホのマナーモード確認
- ブラウザコンソールでエラー確認
- デバイスの音声言語設定を確認（日本語選択時に日本語音声が必要）

### 音声認識（STT）が認識しない
- マイク許可確認
- マイクが無音でないか確認（周囲音を増幅）
- 別のブラウザ試行（Chrome 推奨）

### Gemini API エラー
- API キーが正しいか確認（`npm start` 起動ログで `key found` 表示）
- クォータ / 月額予算に達していないか確認
- コンソールの詳細エラーを確認

### セッショントークン無効
- サーバー再起動後は既存トークンが無効
- クライアント側で再度 `/api/login` を実行（通常、アプリが自動で行う）

### スマホ実機での GPS/音声が止まる（iOS）
- ポケットモード（画面黒化）を使用 → 画面を消さない対策
- または、サーバー側で速度判定を緩和（ガイドさん経由で相談）

## メンテナンス・監視

### サーバーログの見方

**起動時メッセージ**:
```
Digital Nature & Wellness Instructor — http://localhost:3000
  体験アプリ: /   ガイドさんページ: /guide.html   集計: /admin.html
  Gemini: key found (Windows user environment), model=gemini-2.5-flash
  デモ用購入コード: DEMO2027   ガイドさん合言葉: GAIEN-GUIDE
```

**エラーログ**（stderr）:
```
[POST /api/narrate] Error: Gemini API timeout
```

### ログ分析（簡易版）

```bash
# イベント総数
wc -l data/logs/events.jsonl

# Gemini 呼び出し回数
grep '"type":"llm_usage"' data/logs/events.jsonl | wc -l

# セッション開始数
grep '"type":"session_start"' data/logs/events.jsonl | wc -l

# エラー発生回数
grep '"type":"error"' data/logs/events.jsonl | wc -l
```

### 定期メンテナンス

**日次**:
- ログファイルサイズ監視（`data/logs/events.jsonl`）
- エラーログ確認
- Gemini API コスト確認（`/admin.html` > Economics）

**週次**:
- `data/logs/events.jsonl` のバックアップ
- `data/spots.json` のバックアップ確認

**月次**:
- Gemini API 月額請求確認
- ウォーク体験者数・回答率の集計
- メモリリーク確認（長時間実行の場合）

## セキュリティ・注意点

- **ガイドさんページ**: 合言葉のみで保護。本番では「ガイドさん本人の認証」追加推奨
- **API トークン**: メモリ内保持のため、サーバー再起動で消失。本番向けには DB 保存推奨
- **ログ**: `data/logs/` は外部アクセスから保護（`.gitignore` に登録済み）
- **API キー**: Windows 環境変数に保管。コードにハードコードしない

## 更新とデプロイ

### ローカル開発

```bash
git pull
npm install   # 依存なしだが念のため実行
npm test      # テスト確認
npm start     # 起動確認
```

### デモデータの再生成

```bash
node scripts/seed-demo.js --dry-run    # 差分確認
node scripts/seed-demo.js              # 実行（既存 Spot 保持、マージ）
```

### ロールバック

古い Spot データに戻す:
```bash
# backup から復元
cp data/logs/spots.backup-{古いタイムスタンプ}.json data/spots.json
npm start
```

---

**最終更新**: 2026-10-04  
**バージョン**: Phase 1 Prototype
