# 運用ガイド — デジタルネイチャー＆ウェルネスインストラクター 皇居外苑版

## データとプライバシーの扱い

### 来園者が共有しないデータ

| 項目 | 保存 | 理由 |
|---|---|---|
| 移動軌跡（GPS 座標の時系列） | **保存しない** | プライバシー保護。位置判定は端末内で完結 |
| 音声ファイル | **保存しない** | 文字起こし後すぐ破棄（ストレージ・プライバシー節約） |
| 質問テキスト（声入力） | 既定：保存しない | `LOG_QUESTION_TEXT=1` で有効化時のみ記録 |

### 記録されるログ

**保存先**: Firestore の `envs/{STORE_NAMESPACE}/eventBatches/{時刻}-{乱数}`（1 回の書き込み = 1 ドキュメント `{ day, ts, n, types, events }`。`day` は日本時間の日付）。ファイル版（テスト・`start:offline`）は `data/logs/events.jsonl`（1 イベント = 1 行）

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

### 購入（モック）

**保存先**: Firestore の `envs/{STORE_NAMESPACE}/purchases/{コード}`（ファイル版は `data/logs/purchases.json`）。デモコードは保存せず、使ったことを `purchase` イベント（`demoCode: true`）で残す

```json
{ "code": "KG-1A2B3C", "plan": "ai40", "lang": "ja", "priceJpy": 2000, "createdAt": "2026-10-04T12:34:56.789Z", "usedAt": null }
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

`NODE_ENV=production`（Dockerfile で設定済み）か Cloud Run（`K_SERVICE` が自動で付く）で起動すると、次の設定が足りないときは起動しません。
- `GUIDE_PASSCODE` が（前後の空白を除いて）16 文字以上
- `DEMO_CODES` が設定されていて、`DEMO2027` を含まず、どのコードも 8 文字以上
- `LLM_DAILY_MAX`・`NARRATE_MAX_PER_SESSION`・`ASK_MAX_PER_SESSION`・`SESSIONS_PER_CODE_DAILY` が 1 以上
- `TRUSTED_PROXY_HOPS` が 1 以上（Cloud Run 直結は 1。前にロードバランサーを置くなら 2）
- `PURCHASE_ENABLED=1` ではない（購入のモックは誰でもコードを発行でき、上限も効かないため、公開では使えない）
- `STORE_BACKEND=firestore`、`FIRESTORE_PROJECT_ID` があり、`STORE_NAMESPACE` が `local` 以外の正しい形（英小文字で始まる英小文字・数字・-）。`SPOTS_NAMESPACE` を入れるなら同じ形。起動時には Firestore につながない（つながるかは最初の記録で分かる）

公開では、次の上限が既定で入ります（環境変数で変えられます）: 1 つの接続元で 1 日 20 体験（`SESSIONS_PER_IP_DAILY`）、1 回の体験で体験中の API を 1 分 30 回・1 日 300 回（`WALK_CALLS_PER_MIN`・`WALK_CALLS_PER_DAY`）、利用ログは 1 日 20MB・15000 回まで（`EVENTS_DAILY_BYTES`・`EVENTS_DAILY_WRITES`）。

| 変数 | おすすめ | 効果 |
|---|---|---|
| `DEMO_CODES=<配る用のコード>` | 公開時は必須 | 初期値の `DEMO2027` を無効にし、画面にもコードを出さない |
| `GUIDE_PASSCODE=<16 文字以上のランダム値>` | 公開時は必須 | ガイドさんページ・集計ページの合言葉 |
| `LLM_DAILY_MAX` | 200 程度 | サーバー全体の 1 日の Gemini 呼び出し上限（体験者向けだけ）。超えると Gemini なしの案内になる |
| `TTS_DAILY_MAX` | 既定 3000 | サーバー全体の 1 日の Gemini 音声（`gemini-3.8-flash-tts`）作成回数。会話の `LLM_DAILY_MAX` とは別に数える。超えると端末の音声になる |
| `TTS_MAX_PER_SESSION` | 既定 150 | 1 回の体験で作れる音声の回数（無制限にはならない）。超えると端末の音声になる |
| `GEMINI_TTS_MODEL` / `GEMINI_TTS_VOICE` / `GEMINI_TTS_STYLE` | 既定 `gemini-3.8-flash-tts` / `Kore` / 落ち着いた・あたたかい・ゆっくりした声 | 音声のモデル・声・声の雰囲気。単価は `GEMINI_TTS_PRICE_IN_PER_M`（既定 0.5）・`GEMINI_TTS_PRICE_OUT_PER_M`（既定 9）。2027-01-01 から自動で 1.0・18 になる |
| `NARRATE_MAX_PER_SESSION` | 40 程度（必須） | 1 回の体験での案内の上限 |
| `ASK_MAX_PER_SESSION` | 20 程度（必須） | 1 回の体験での自由質問の上限 |
| `SESSIONS_PER_CODE_DAILY` | 30 程度（必須） | 1 つのデモコードで 1 日に始められる体験の数 |
| `TRUSTED_PROXY_HOPS=1` | 必須（ロードバランサーを前に置くなら 2） | 総当たり対策で、接続元 IP を正しく見分ける。0 のままだと全員が同じ接続元として数えられ、1 人の失敗で全員がログインできなくなる |
| `GEMINI_MODEL=gemini-3.8-flash` | 新しいプロジェクトでは必須 | `gemini-2.5-flash` は新しいプロジェクトでは使えない。料金は `GEMINI_PRICE_IN_PER_M=0.75`・`GEMINI_PRICE_OUT_PER_M=3.75` |

`LLM_DAILY_MAX` はメモリで数えるため、再起動や複数インスタンスでは正確な上限になりません。確実な上限は、GCP の Generative Language API のクォータ（1 日のリクエスト数）で設定してください（Vertex AI Express のキー `AQ.` を使う場合は、Vertex AI 側のクォータ）。

### Vertex AI をサービスアカウントで使う

| 変数 | 効果 |
|---|---|
| `GEMINI_SA_JSON` | サービスアカウントの鍵（JSON の文字列。旧名 `GEMINI_SERVICE_ACCOUNT_JSON` も可）。`--set-secrets` で Secret Manager から渡す。設定すると `GEMINI_API_KEY` より優先して、Vertex AI をその鍵のトークンで呼ぶ |
| `GEMINI_VERTEX_PROJECT` | Vertex AI のプロジェクト。未設定なら鍵の `project_id` |
| `GEMINI_VERTEX_LOCATION` | 場所。既定 `global`（`us-central1` など） |

- 切り替え：`GEMINI_SA_JSON` を設定すると Vertex、外すと `GEMINI_API_KEY` に戻る。サービスアカウントには「Vertex AI ユーザー」の権限が要る
- 音声が `audio/wav`（または RIFF ヘッダー付き）で返ったときは包み直さずそのまま使う。ヘッダーなしの PCM だけ WAV にする
- 呼び出しが失敗したときのログには、最初に試したエンドポイントのエラーを残す

### アプリ側の守り（公開時）

- **総当たり対策**: `/api/session`（コード）と `/api/guide/login`（合言葉）は、同じ接続元（IPv4 はアドレス、IPv6 は /64）から 10 分で 10 回、または全体で 200 回失敗すると 429 を返す。同時に送っても上限を超えない。失敗はログに `[auth] invalid ...` と IP だけを残す（入力された値は残さない）
- **期限**: 体験者のセッションは 24 時間、ガイドさんのログインは 8 時間で切れる
- **イベント**: `/api/events` は体験アプリが送る種類だけを受け付け、文字列は 200 字まで、1 セッション 300 件まで。`llm_usage`・`purchase` はサーバーだけが書く
- **入力の大きさ**: 体験中の API とイベントは 64KB まで。チェックインなど LLM に渡す項目は切り詰める
- **エラー**: 想定外のエラーは `internal_error` とだけ返し、詳しい内容はサーバーのログにだけ出す
- **ヘッダー**: CSP（外部は unpkg の Leaflet 1.9.4 のパスだけ（SRI でハッシュも確認）・国土地理院の地図タイル・Overpass API だけ許可）、`X-Frame-Options: DENY`、`nosniff` など

### Cloud Run で動かすとき

- **インスタンスは最大 1**（`--max-instances 1`）。ログイン状態や上限の回数をメモリに持つため、複数に分かれるとログインが切れ、上限も正しく数えられない
- **記録は Firestore に残す**: `STORE_BACKEND=firestore`・`FIRESTORE_PROJECT_ID=yohaku-shinrinyoku`・`STORE_NAMESPACE=preview`・`SPOTS_NAMESPACE=preview`。トークンは実行アカウント（メタデータサーバー）から取るので、実行アカウントに `roles/datastore.user` が要る。イメージには knowledge.json・scenario.json だけが入る（読み取り専用）
- **止めるとき**: SIGTERM で受け付けをやめ、書きかけのログと、Firestore が止まっていた間に持ち越したイベントを最大 5 秒待って書く
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

**保存先**: 利用ログ（上の「記録されるログ」）の `type: 'llm_usage'` イベント

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

## Firestore（記録の保存先）

GCP プロジェクト `yohaku-shinrinyoku` の Firestore（Native モード、asia-northeast1、`(default)`）。REST で読み書きし、外部ライブラリは使わない。

```
envs/{ns}/eventBatches/{ms13 桁}-{乱数 8 桁}   利用ログ（1 回の書き込み = 1 ドキュメント）
envs/{ns}/purchases/{コード}                  購入（モック）
envs/{ns}/recordings/{id}                     録音ウォーク（状態と候補）
envs/{ns}/recordings/{id}/chunks/{番号 6 桁}   録音ウォークの文字起こしと軌跡（終わったら軌跡は消す）
envs/{spotsNs}/data/spots                     Spot と素材（1 ドキュメント、900KB まで。超えたら 413）
envs/{spotsNs}/spotsHistory/{ms13 桁}          Spot の古い版（新しい 20 個）
```

- **名前空間**: `ns` = `STORE_NAMESPACE`（パソコンの `npm start` は `local`、お試し版は `preview`）、`spotsNs` = `SPOTS_NAMESPACE`（パソコンもお試し版と同じ `preview` を読み書きする）
- **索引**: 集計は `day` の範囲検索だけなので、自動の単一フィールド索引で動く（複合索引は要らない）。大きな配列・map の項目は検索に使わないので、単一フィールド索引から外している（書き込みの量と費用を抑え、索引の上限にかからないように）:

  | コレクショングループ | 項目 |
  |---|---|
  | `eventBatches` | `events` |
  | `data` | `spots` |
  | `spotsHistory` | `spots` |
  | `chunks` | `track`・`segments` |
  | `recordings` | `candidates` |

  ```bash
  CLOUDSDK_ACTIVE_CONFIG_NAME=shinrinyoku gcloud firestore indexes fields update events --collection-group=eventBatches --disable-indexes
  # data/spots、spotsHistory/spots、chunks/track、chunks/segments、recordings/candidates も同じように
  ```
- **セキュリティルール**: 全部拒否にする（ブラウザから直接は触らせない。サーバーは IAM で読み書きする）
- **ローカルの認証**: `gcloud auth print-access-token` を gcloud の設定 `shinrinyoku`（`GCLOUD_CONFIG`。`FIRESTORE_AUTH=gcloud` では必須で、空なら起動しない）で実行する。会社用の既定の設定や ADC は使わない。シェルは通さず、Windows では gcloud の場所を 1 回だけ調べ（作業フォルダの中の gcloud は使わない）、`cmd.exe /d /s /c` で動かす。トークンは 50 分使い回し、401 なら 1 回だけ取り直す。起動時に先に取っておく（gcloud のときだけ）
- **公開の認証**: 公開（`NODE_ENV=production` か Cloud Run）では `FIRESTORE_AUTH` は `metadata`（未設定なら `metadata`）でないと起動しない。メタデータサーバーのトークンは期限の 5 分前（短いトークンは期限の半分）まで使い回す
- **共有の Spot は合言葉が強いときだけ保存できる**: `npm start` は Spot をお試し版と共有する（`SPOTS_NAMESPACE`=`preview` が `STORE_NAMESPACE`=`local` と違う）。このとき合言葉（`GUIDE_PASSCODE`）が既定（`GAIEN-GUIDE`）か 16 文字より短いと、Spot は読むだけになる（保存・削除は 403 `shared_spots_read_only`。起動時に 1 行お知らせを出す）。`npm run start:lan` は、この状態では起動しない
- **パソコンの合言葉**: `npm start` は `GUIDE_PASSCODE` がなければ、お試し版と同じ合言葉を `SHINRINYOKU_PREVIEW_ENV`（既定 `~/.secrets/shinrinyoku/preview.env`）の `GUIDE_PASSCODE=...` の行から読む（表示しない。ファイルがなければ既定の合言葉のまま＝Spot は読むだけ）。`npm run start:lan` はファイルから読まない（LAN で保存するなら `GUIDE_PASSCODE` を環境変数で渡す）。パソコンで `local` 以外の名前空間の Spot を直接使うとき（`STORE_NAMESPACE=preview` など）も、合言葉が弱ければ読むだけ
- **パソコンのサーバーはほかのサイトから使わせない**: ループバック（`127.0.0.1` など）で待ち受けているときは、`Host` が `localhost`・`127.0.0.1`・`[::1]` 以外のリクエストを 421 で断る（DNS リバインディング対策）
- **集計**: `/api/stats?days=N`（既定 7、1〜90）。読むのは最大 `STATS_MAX_DOCS`（1000）ドキュメント・応答の合計 50MB まで（100 件ずつ読み、読んだそばから変換する）で、超えたら新しい分だけを集計して集計ページに「一部だけ集計」と出す（購入の一覧が上限 5000 件に届いたときも）。結果は `STATS_CACHE_SEC`（300 秒）使い回す
- **Spot の使い回し**: `SPOTS_CACHE_SEC`（30 秒）。自分のインスタンスで保存したらすぐ反映。ほかのインスタンス（パソコンとお試し版）の保存は最大 30 秒遅れて見える。同時に保存が重なったら 1 回だけやり直し、だめなら 409 `spots_conflict`

### Firestore が止まったとき

| 機能 | 動き |
|---|---|
| 利用ログ（`/api/events` など） | 200 で `accepted: 0`。最大 500 イベントをメモリに残し、次に書けたときと終了時に書き直す |
| Spot を読む（体験・ガイドさんページ） | 最後に読めた内容を最大 1 時間使う。なければ 503 `store_unavailable` |
| デモコードで始める | そのまま通る（Firestore を読まない） |
| 購入の発行・購入コードの確認 | 503 `store_unavailable`（失敗の回数には数えない） |
| ガイドさんの保存・録音ウォーク・集計 | 503 `store_unavailable` |

通信は 5 秒で打ち切り、429・500・503・ABORTED・UNAVAILABLE・通信エラーだけ 200ms・600ms あけて最大 2 回やり直す。サーバーのログには `[store] commit 503 UNAVAILABLE` のようにコードだけを出す（中身・トークンは出さない）。

### 無料枠と上限

Firestore の無料枠は 1 日に読み取り 5 万・書き込み 2 万・削除 2 万、保存 1 GiB。
- 書き込み: 利用ログは 1 回の書き込み = 1 ドキュメントにまとめ、`EVENTS_DAILY_WRITES`（公開の既定 15000）で止める
- 保存: `EVENTS_DAILY_BYTES` の公開の既定 20MB のままだと、毎日上限まで書かれた場合に 2 か月ほどで 1 GiB を超える。お試し版では `EVENTS_DAILY_BYTES=5000000`（5MB、約 7 か月分）に下げることをすすめる
- 読み取り: 集計は 1 回で最大 1000 ドキュメント読むので、`STATS_CACHE_SEC` で使い回す
- 書き込みのやり直し: 読み込みは失敗したらやり直す。書き込みは、やり直して「もう書けていた」になっても扱えるもの（イベント・購入・録音）だけやり直す。Spot の保存はやり直さない（失敗したらガイドさんがもう一度保存する）

### 移行

`--logs` は、移す元（パソコンの `data/logs/`）への書き込みが止まってから 1 回だけ流す（書いている途中で流すと、増えた日のまとめが重なって書かれることがある）。Firestore 版で読める番号を超える録音の chunk は移さず、その数を表示する。
`--spots-from` の URL は `https://` だけ。Spot はガイドさんページの保存と同じ検査・整形を通す。お試し版（`--namespace preview`）に書くときは `--yes` が要る（先に `--dry-run`）。利用ログは日ごとに 100 件ずつ、中身のハッシュを ID にして書く（流し直しても重ならない。あとから増えた日は、変わったまとめだけ書く）。Firestore に書けないイベントは捨て、その数を表示する。

```bash
# お試し版の今の Spot を移す（すでにあれば --force なしでは上書きしない）
FIRESTORE_PROJECT_ID=yohaku-shinrinyoku GCLOUD_CONFIG=shinrinyoku \
  npm run migrate -- --namespace preview --spots-from https://<お試し版の URL>/api/data/spots --dry-run
# ファイル版の記録（data/logs/）も移す。何度流しても 2 重にならない
FIRESTORE_PROJECT_ID=yohaku-shinrinyoku GCLOUD_CONFIG=shinrinyoku npm run migrate -- --namespace local --logs
```

## バックアップ

### 自動バックアップ

**タイミング**: Spot を保存したとき（ガイドさんページで保存したとき）

**保存先**: Firestore は `envs/{spotsNs}/spotsHistory/{ミリ秒}`（新しい 20 個）。ファイル版は `data/logs/spots.backup-{timestamp}.json`

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
# （ファイル版）イベント総数。Firestore 版は /admin.html か /api/stats?days=N で見る
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
# ファイル版: backup から復元
cp data/logs/spots.backup-{古いタイムスタンプ}.json data/spots.json
npm run start:offline

# Firestore 版: Firebase コンソールで spotsHistory の版を開き、{ version, spots } を JSON ファイルにして書き戻す（今の内容は履歴に残る）
FIRESTORE_PROJECT_ID=yohaku-shinrinyoku GCLOUD_CONFIG=shinrinyoku npm run migrate -- --namespace preview --spots-from old-spots.json --force
```

---

**最終更新**: 2026-10-04  
**バージョン**: Phase 1 Prototype
- **データ**: 記録と Spot は Firestore に残る（インスタンスが止まっても消えない）。最大インスタンス数は 1 にする（ログイン状態と上限の数え方がメモリにあるため）。Spot の古い版は新しい 20 個まで
