# デジタルネイチャー＆ウェルネスインストラクター 皇居外苑版

音声を中心とした ~40 分の森林浴ウォーク体験アプリ。スマートフォンから目を離し、自然と自分の感覚に向き合う時間を設計しています。

- **Eyes Up**: スマートフォンから目を離す
- **Audio First**: ブラウザの合成音声を中心に、Intentional Silence（意図的な沈黙）を重視
- **Nature First**: 身近な自然の詳細に気づく体験
- **AI ガイドではなく「素材」**: ガイドさんが登録した「話の種」から、その場で適切な案内を組み立てる仕組み

## 必要環境・起動

### 要件
- Node.js 18 以上
- 外部ライブラリなし（純粋な Node API のみ）
- ブラウザの GPS、マイク、TTS/STT 機能

### インストールと起動

```bash
npm install          # 依存なし。念のため実行
npm start            # http://localhost:3000（記録は Firestore。下の「ローカルの Firestore 認証」）
npm run start:offline  # Firestore を使わずに動かす（記録は data/ のファイル）
npm test             # ユニットテスト実行（ファイル版で動き、Firestore にはつながない）
```

#### ローカルの Firestore 認証
`npm start` は GCP プロジェクト `yohaku-shinrinyoku` の Firestore に記録します（イベント・購入・録音は `envs/local`、Spot はお試し版と同じ `envs/preview`）。
共有の Spot を保存できるのは、合言葉がお試し版と同じ（16 文字以上）ときだけです。`GUIDE_PASSCODE` がなければ `~/.secrets/shinrinyoku/preview.env` から読みます（なければ既定の合言葉で、Spot は読むだけ。`start:lan` は起動しません）。
トークンは `gcloud auth print-access-token` を gcloud の設定 `shinrinyoku` で実行して取ります（既定の設定は変えません。ADC は使いません）。

```bash
gcloud config configurations create shinrinyoku   # 初回だけ
CLOUDSDK_ACTIVE_CONFIG_NAME=shinrinyoku gcloud auth login
CLOUDSDK_ACTIVE_CONFIG_NAME=shinrinyoku gcloud config set project yohaku-shinrinyoku
```

つながらないときは、イベントは捨てずにメモリに残して次に書けたときに書き直し、Spot は最後に読めた内容を最大 1 時間使います。購入・ガイドさんの保存・集計は 503 になります。

#### LAN 接続（スマホ実機テスト）
```bash
npm run start:lan   # http://0.0.0.0:3000 でバインド
# ホストマシンの IP アドレスでアクセス可能（例: http://192.168.1.100:3000）
```

### 起動時の表示

```
Digital Nature & Wellness Instructor — http://localhost:3000
  体験アプリ: /   ガイドさんページ: /guide.html   集計: /admin.html
  Gemini: key found (Windows user environment), model=gemini-2.5-flash
  デモ用購入コード: DEMO2027   ガイドさん合言葉: GAIEN-GUIDE
```

## 環境変数

Gemini API キーは Windows のユーザー環境変数から自動的に読み込まれます（値は起動ログには表示されません）。

| 変数 | 既定値 | 説明 |
|---|---|---|
| `GEMINI_API_KEY` | — | Gemini API キー。Windows ユーザー環境変数に設定（プロセス環境変数で上書き可） |
| `GEMINI_SA_JSON` | — | サービスアカウントの鍵（JSON の文字列。旧名 `GEMINI_SERVICE_ACCOUNT_JSON` も可）。設定すると API キーより優先して、Vertex AI をその鍵のトークンで呼ぶ。外すと API キーに戻る |
| `GEMINI_VERTEX_PROJECT` | 鍵の `project_id` | Vertex AI のプロジェクト |
| `GEMINI_VERTEX_LOCATION` | `global` | Vertex AI の場所（`us-central1` など） |
| `NODE_ENV` | — | `production` にすると公開用の設定を確かめ、足りなければ起動しない（Cloud Run の `K_SERVICE` があるときも同じ扱い。docs/OPERATIONS.md） |
| `GUIDE_PASSCODE` | `GAIEN-GUIDE` | ガイドさんページと集計ページのログイン合言葉。起動ログには値を出さない（既定値のときだけ表示） |
| `DEMO_CODES` | `DEMO2027` | デモ用購入コード（複数指定時はカンマ区切り）。初期値以外にすると、画面にコードを表示せず「デモで試す」も入力したコードを使う |
| `PURCHASE_ENABLED` | ローカル `1`／公開 `0` | 購入（モック）を受け付けるか。`0` で止めて購入ボタンを隠す。公開では使えない（`1` にすると起動しない） |
| `LLM_DAILY_MAX` | `0`（無制限） | サーバー全体の 1 日（日本時間）の Gemini 呼び出し上限。体験者向けの呼び出し（質問・案内・チェックイン）だけを数え、ガイドさんの録音・抽出は数えない。超えたら素材と Knowledge だけの案内に切り替わる。`callGemini` を呼んだ回数で数える（失敗した呼び出しも 1 回）。メモリで数えるので再起動で 0 に戻る |
| `SESSIONS_PER_CODE_DAILY` | `0`（無制限） | 1 つのデモコードで 1 日（日本時間）に始められる体験の数。公開では必須 |
| `SESSIONS_PER_IP_DAILY` | ローカル `0`／公開 `20` | 1 つの接続元（IPv4 はアドレス、IPv6 は /64）で 1 日に始められる体験の数 |
| `WALK_CALLS_PER_MIN` / `WALK_CALLS_PER_DAY` | ローカル `0`／公開 `30`・`300` | 1 回の体験で、体験中の API（質問・案内・チェックイン）を呼べる回数。超えたら 429 |
| `EVENTS_DAILY_BYTES` | ローカル `0`／公開 `20000000` | 利用ログに 1 日に書き込む量の上限（バイト。JSON 1 行ずつで数える）。超えた分は捨てる。Firestore の無料保存（1 GiB）を考えると、お試し版では `5000000` に下げるのがおすすめ（docs/OPERATIONS.md） |
| `EVENTS_DAILY_WRITES` | ローカル `0`／公開 `15000` | 利用ログを 1 日に書く回数（Firestore のドキュメント数）の上限。無料枠は 1 日 2 万回の書き込み |
| `STORE_BACKEND` | `file` | 記録の保存先。`file`（data/ のファイル。テストと `start:offline`）・`firestore`（`npm start` とお試し版）・`memory`（テスト用）。公開では `firestore` が必須 |
| `FIRESTORE_PROJECT_ID` | — | Firestore の GCP プロジェクト。`firestore` で必須（`npm start` は `yohaku-shinrinyoku`） |
| `FIRESTORE_DATABASE` | `(default)` | Firestore のデータベース |
| `STORE_NAMESPACE` | `local` | イベント・購入・録音を置く名前（`envs/<名前>/...`）。お試し版は `preview`。公開では必須で `local` は使えない |
| `SPOTS_NAMESPACE` | `STORE_NAMESPACE` と同じ | Spot を置く名前。`npm start` はお試し版と同じ `preview` を読み書きする |
| `FIRESTORE_AUTH` | 公開は `metadata`、それ以外は `gcloud` | トークンの取り方。`metadata` は実行アカウント、`gcloud` は `gcloud auth print-access-token`。公開では `metadata` だけ |
| `GCLOUD_CONFIG` | — | `gcloud` で使う gcloud の設定名。`FIRESTORE_AUTH=gcloud` では必須（`npm start` は `shinrinyoku`。既定の設定は使わない） |
| `SHINRINYOKU_PREVIEW_ENV` | `~/.secrets/shinrinyoku/preview.env` | `npm start` で `GUIDE_PASSCODE` がないときに、合言葉を読むファイル（`GUIDE_PASSCODE=...` の行。表示しない） |
| `STATS_MAX_DOCS` | `1000` | 集計で読む利用ログのドキュメント数の上限。超えたら新しい分だけを集計し、集計ページに「一部だけ集計」と出す |
| `STATS_CACHE_SEC` | `300` | 集計の結果を使い回す秒数（`0` で使い回さない。テストは `0`） |
| `SPOTS_CACHE_SEC` | `30` | Firestore 版で Spot を使い回す秒数（自分の保存はすぐ反映。ほかのインスタンスの保存は最大この秒数遅れる） |
| `TRUSTED_PROXY_HOPS` | `0` | `X-Forwarded-For` を足す信頼できるプロキシの段数（Cloud Run 直結は `1`、前にロードバランサーを置くなら `2`）。総当たり対策で接続元 IP を見分けるのに使う。公開では必須 |
| `NARRATE_MAX_PER_SESSION` | `0`（無制限） | 1 回の体験での案内（narrate）の Gemini 呼び出し上限。超えたら素材だけの案内。公開では必須 |
| `ASK_MAX_PER_SESSION` | `0`（無制限） | 1 回の体験での自由質問（ask）の Gemini 呼び出し上限。超えたら素材と Knowledge だけで答える。公開では必須 |
| `GEMINI_MODEL` | `gemini-2.5-flash` | 使用する Gemini モデル。新しく作った GCP プロジェクトでは `gemini-2.5-flash` が使えないので、`gemini-3.8-flash` などを指定する（Flash 系は考える時間を 0 にして送る） |
| `PORT` | `3000` | リッスンポート |
| `HOST` | `127.0.0.1` | バインドアドレス（`0.0.0.0` でLAN公開） |
| `GEMINI_PRICE_IN_PER_M` | `0.3` | 入力トークン 1M あたりの USD |
| `GEMINI_PRICE_OUT_PER_M` | `2.5` | 出力トークン 1M あたりの USD。`gemini-3.8-flash` なら入力 `0.75`・出力 `3.75` を設定する |
| `USD_JPY` | `150` | USD から JPY への換算レート |
| `LOG_QUESTION_TEXT` | `0` | `1` に設定するとログに質問テキストを記録（デフォルト非記録） |
| `DATA_DIR` | `./data` | 同梱データ（knowledge.json・scenario.json）と、ファイル版の記録の置き場所 |

## ページと用途

| URL | 用途 | 対象者 |
|---|---|---|
| `/` | 体験アプリ | 来園者 |
| `/guide.html` | Spot 登録・編集、素材の登録、録音ウォーク | ガイドさん |
| `/admin.html` | 利用統計とコスト集計 | ガイドさん／スタッフ |

## ウォーク体験の流れ（実機）

### 1. チェックイン画面
- 購入コード入力（`DEMO2027` でデモ体験可）
- 言語選択（日本語／English）
- 体調・希望・自由記述で「状態」を AI に伝える
  - 状態: 頭／体／低い／OK
  - 希望: リフレッシュ／瞑想／自然志向／運動
  - 自由記述: 例「疲れているのでゆっくり」「植物に興味がある」（声入力も可）

### 2. 準備・モード選択
- **実機モード（デフォルト）**: GPS で位置を取得、実際に歩く
- **シミュレーションモード**: 地図クリックで移動、speed ボタンで速度制御
  - 🟠 オレンジの丸をドラッグして歩く、離すと止まる
  - 「次の Spot へ」ボタンでジャンプ
  - 「滞在を早送り」で停止状態を続行

### 3. ウォーク中
- Spot に接近すると案内が流れる
- 止まって滞在すると追加情報が提示される場合あり
- AI から質問される場合がある（「もう少し聞きますか、それとも先に進みますか？」）
  - ボタンまたはマイク（8 秒間開く）で返事
  - 返事がなければ静かに見守る
- 最後にふりかえりアンケート（気づいたこと、変化、次へ）

## ポケットモード（スマホ）

iOS で GPS / 録音が止まるのを防ぐため：
- 画面下部「ポケットモード」ボタンで黒画面を有効化
- ポケットに入れたまま体験を続行
- 画面タップで復帰

## デモデータ

### デモ Spot の生成

```bash
node scripts/seed-demo.js
```

OpenStreetMap から皇居外苑周辺の地物（樹木、歴史的建造物、庭園、水域など）を取得し、タグ由来の事実だけから素材を自動生成。既存の Spot とマージされます。

オプション:
- `--dry-run`: 差分表示のみ（ファイル変更なし）
- `--bbox south,west,north,east`: 別の場所を指定（既定は皇居外苑）
- `--max N`: 取得する候補の上限（既定 15）
- `--cache <file>`: OSM レスポンスをキャッシュ

### デモ Spot を使わずテスト

`scripts/seed-demo.js` を実行しなくても、既存の 6 つの Spot（二の丸庭園など）でデモ可能です。

## ガイドさんページの使い方

ガイドさんが素材（話の種）を登録・編集するページです。合言葉は `GAIEN-GUIDE`（環境変数で変更可）。

### A. ここで登録
チェックイン画面で来園者が登録した内容を確認します。

### B. 地図で編集
Spot（位置 + 素材）を地図上で登録・編集します。
- 「Spot を追加」: 新しい Spot を作成
- 「OSM 候補を取り込む」: OpenStreetMap から候補を取得（`scripts/seed-demo.js` 相当）
- 「現在地」: GPS から現在地を取得
- 素材の登録フォーム
  - 種類: fact（事実）、story（小話）、sense（五感への促し）、notice（注意事項）、must（必ず伝える）
  - 話題: plant（植物）、history（歴史）、culture（文化）、nature（自然）、birds（野鳥）、water（水）、view（眺望）、senses（感覚）、safety（安全）

### C. 録音ウォーク
ガイドさんが実際に歩きながら 5 分単位で音声を記録。自動で文字起こしされ、Spot 候補が提案されます。

## スマホ実機での試行（HTTPS トンネル経由）

ブラウザの地理情報（GPS）とマイク機能は HTTPS が必須です。ローカル LAN では HTTP では動作しません。

### cloudflared トンネルを使う例

```bash
# 1. cloudflared をインストール（Windows/Mac/Linux）
#    https://developers.cloudflare.com/cloudflare-one/connections/connect-applications/install-and-setup/tunnel-guide/local-management/

# 2. トンネルを開く
cloudflared tunnel --url http://localhost:3000

# 3. 出力された URL（例: https://xxxxx.trycloudflare.com）をスマホで開く
```

代替方法:
- ngrok: `ngrok http 3000`
- localtunnel: `npx localtunnel --port 3000`

※ 具体的なコマンドと設定は各ツールのドキュメントを参照してください。

## 既知の制約

### ブラウザ・端末の差
- **TTS（音声読み上げ）**: 端末の言語設定や音声エンジンによって発音・速度が異なります
- **STT（音声認識）**: ブラウザの実装によって精度が異なります（Chrome が安定）
- **GPS 精度**: 屋外で ±5〜15m（ビル影響で ±30m になる可能性）
- **iOS**: 画面を消すと GPS / 音声録音が停止する場合があります → ポケットモード推奨

### アーキテクチャの制限
- **セッション管理**: セッショントークン・ガイドトークンはメモリ内に保持（サーバー再起動で消失）
- **位置情報**: 体験者の軌跡サーバーに保存しない（プライバシー保護）
- **音声ファイル**: 文字起こし後すぐに破棄（ストレージ節約、プライバシー保護）
- **ログ**: イベントベースで保存。個人軌跡ではなく、Spot 到達、質問の有無などを記録
- **決済**: モック実装（デモ用）。実際の課金は別途実装が必要

### データ保存
保存先は `STORE_BACKEND` で選びます。`npm start` とお試し版は Firestore、テストと `npm run start:offline` はファイルです。

| 記録 | Firestore | ファイル版 |
|---|---|---|
| Spot と素材 | `envs/{SPOTS_NAMESPACE}/data/spots`（1 ドキュメント、900KB まで） | `data/spots.json` |
| Spot の古い版（新しい 20 個） | `envs/{SPOTS_NAMESPACE}/spotsHistory/{保存時刻}` | `data/logs/spots.backup-{時刻}.json` |
| 利用ログ | `envs/{STORE_NAMESPACE}/eventBatches/{時刻}-{乱数}`（1 回の書き込み = 1 ドキュメント） | `data/logs/events.jsonl`（1 イベント = 1 行） |
| 購入（モック） | `envs/{STORE_NAMESPACE}/purchases/{コード}` | `data/logs/purchases.json` |
| 録音ウォーク | `envs/{STORE_NAMESPACE}/recordings/{id}` と `chunks/{番号}` | `data/logs/recordings/{id}.json` |

- knowledge.json・scenario.json は書き換えないので、どちらでもファイルのまま読みます
- ファイル版の記録や Spot を Firestore に移すときは `npm run migrate -- --namespace <名前> --spots-from <ファイルか URL> --logs`（`--dry-run` で確認だけ、Spot がすでにあれば `--force` なしでは上書きしない。何度流しても 2 重にならない）
- **再起動で失うもの**: セッショントークン、進行中のウォーク、未コミットの素材変更（ガイドさんページで保存ボタンを押す必要あり）

## ディレクトリ構成

```
.
├── README.md                        # このファイル
├── docs/
│   ├── DESIGN.md                    # API 契約・データ形式・ディレクトリ分担
│   └── OPERATIONS.md                # 運用・ログ・コスト管理
├── server.js                        # メインサーバー（ルーティング）
├── lib/
│   ├── config.js                    # 環境変数・設定値読み込み
│   ├── store/                       # 記録の保存先（STORE_BACKEND で選ぶ）
│   │   ├── index.js                     # 選択・1 日の書き込み上限・書けなかったイベントの持ち越し
│   │   ├── common.js                    # エラーの形・ID の形
│   │   ├── file.js                      # ファイル版（テスト・start:offline）
│   │   ├── memory.js                    # メモリ版（テスト用）
│   │   └── firestore/                   # Firestore 版（events・spots・purchases・recordings）
│   ├── firestore/                       # Firestore REST（rest.js・encode.js・token.js・writes.js）
│   ├── static-data.js                   # knowledge.json・scenario.json の読み込み（1 回だけ読んで使い回す）
│   ├── freeze.js                        # 使い回すデータを変えられないようにする
│   ├── spot-validate.js                 # Spot と素材の検査・整形（ガイドさんページと移行で共通）
│   ├── stats.js                         # 集計（/api/stats）
│   ├── limits.js                        # 回数の上限・接続元 IP
│   ├── auth.js                      # セッション・ガイド認証
│   ├── http.js                      # HTTP レスポンス
│   ├── knowledge.js                 # 一般知識ベース・検索
│   └── gemini.js                    # Gemini API 呼び出し・コスト計算
├── routes/
│   ├── core.js                      # /api/login（体験者・ガイド）
│   ├── walk.js                      # /api/narrate, /api/ask（ウォーク中 AI）
│   └── guide.js                     # ガイドさん API（Spot 編集、録音、文字起こし）
├── public/
│   ├── index.html                   # 体験アプリ（チェックイン → ウォーク → 反省）
│   ├── guide.html                   # ガイドさんページ（素材登録）
│   ├── admin.html                   # 集計ページ（統計・コスト）
│   ├── css/
│   │   ├── style.css                # 体験アプリのスタイル
│   │   └── guide.css                # ガイド・集計ページのスタイル
│   └── js/
│       ├── app.js                   # 体験アプリのメイン
│       ├── engine.js                # ウォーク状態管理・AI との連携
│       ├── motion.js                # GPS / シミュレーション位置追跡
│       ├── voice.js                 # TTS / STT ラッパー
│       ├── guide.js                 # ガイドさんページのメイン
│       ├── guide-core.js            # Spot 編集ロジック
│       ├── guide-map.js             # 地図操作（Leaflet）
│       ├── guide-record.js          # 録音ウォーク
│       ├── sim.js                   # シミュレーションモード
│       ├── i18n.js                  # 多言語対応
│       └── motion.js                # 動作ユーティリティ
├── data/
│   ├── spots.json                   # Spot データ（ファイル版の初期値。Firestore 版は envs/{ns}/data/spots）
│   ├── scenario.json                # ウォーク全体の流れ（プロトコル）
│   ├── knowledge.json               # 一般知識ベース（補足情報）
│   └── logs/                        # ファイル版の記録（git には入れない）
│       ├── events.jsonl             # イベントログ（1 行 = 1 イベント）
│       ├── purchases.json           # 購入・チェックイン実績
│       ├── recordings/              # 録音ウォークの文字起こしと軌跡（音声は保存しない）
│       └── spots.backup-*.json      # Spot の古い版
├── scripts/
│   ├── seed-demo.js                 # OSM からデモデータ自動生成
│   ├── start-local.js               # npm start（Firestore の既定値を入れて起動）
│   └── migrate-to-firestore.js      # ファイル版の記録・Spot を Firestore へ移す
└── test/
    └── *.test.js                    # ユニットテスト
```

詳細は [docs/DESIGN.md](docs/DESIGN.md) を参照。

## 開発・デバッグ

### ローカルテスト

```bash
npm test                   # 全テスト実行
npm start                  # サーバー起動（http://localhost:3000、記録は Firestore）
npm run start:offline      # Firestore を使わずに起動（node server.js と同じ）
npm run start:lan          # LAN 公開（http://0.0.0.0:3000）
```

### デモ体験の流れ

1. `http://localhost:3000` にアクセス
2. 言語選択
3. 購入コード入力 → `DEMO2027`
4. チェックイン画面で状態・希望を選択
5. 準備画面で「シミュレーションモード」を選択
6. ウォーク開始 → 地図上で 🟠 オレンジの丸をドラッグして移動
   - ゆっくり・ふつう・はやい・停止ボタンで速度調整
   - 「次の Spot へ」でジャンプ
   - 「滞在を早送り」で長めの停止を進行
7. 最後にアンケート回答

### Gemini API キーの設定（Windows）

1. **Windows 環境変数に設定する方法**
   ```powershell
   $env:GEMINI_API_KEY = 'sk-xxx...'
   [Environment]::SetEnvironmentVariable("GEMINI_API_KEY", "sk-xxx...", "User")
   ```
   
2. **確認**
   ```powershell
   $env:GEMINI_API_KEY
   # または
   reg query HKCU\Environment /v GEMINI_API_KEY
   ```

3. **プロセス環境変数で一時的に上書き**
   ```bash
   set GEMINI_API_KEY=sk-xxx&&npm start
   # または PowerShell
   $env:GEMINI_API_KEY="sk-xxx"; npm start
   ```

キーが見つからない場合、サーバーはフォールバック モード（素材と Knowledge ベースのみ）で動作します。

## まとめ

このプロトタイプは、**スマートフォンから目を離し、自然と対話する体験**を設計しています。AI は不可視の支援役で、来園者の感覚と選択を最大限に尊重します。

- 詳細な API 仕様: [docs/DESIGN.md](docs/DESIGN.md)
- 運用・ログ・コスト: [docs/OPERATIONS.md](docs/OPERATIONS.md)
