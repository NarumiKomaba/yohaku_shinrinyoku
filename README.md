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
npm install     # 依存なし。念のため実行
npm start       # http://localhost:3000
npm test        # ユニットテスト実行
```

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
| `NODE_ENV` | — | `production` にすると公開用の設定を確かめ、足りなければ起動しない（下の「公開するとき」） |
| `GUIDE_PASSCODE` | `GAIEN-GUIDE` | ガイドさんページと集計ページのログイン合言葉。起動ログには値を出さない（既定値のときだけ表示） |
| `DEMO_CODES` | `DEMO2027` | デモ用購入コード（複数指定時はカンマ区切り）。初期値以外にすると、画面にコードを表示せず「デモで試す」も入力したコードを使う |
| `PURCHASE_ENABLED` | ローカル `1`／公開 `0` | 購入（モック）を受け付けるか。`0` で止めて購入ボタンを隠す。`NODE_ENV=production` のときは既定で止まり、`1` で有効 |
| `LLM_DAILY_MAX` | `0`（無制限） | サーバー全体の 1 日（日本時間）の Gemini 呼び出し上限。体験者向けの呼び出し（質問・案内・チェックイン）だけを数え、ガイドさんの録音・抽出は数えない。超えたら素材と Knowledge だけの案内に切り替わる。`callGemini` を呼んだ回数で数える（失敗した呼び出しも 1 回）。メモリで数えるので再起動で 0 に戻る |
| `SESSIONS_PER_CODE_DAILY` | `0`（無制限） | 1 つのデモコードで 1 日（日本時間）に始められる体験の数 |
| `TRUSTED_PROXY_HOPS` | `0` | `X-Forwarded-For` を足す信頼できるプロキシの段数（Cloud Run は `1`）。総当たり対策で接続元 IP を見分けるのに使う |
| `NARRATE_MAX_PER_SESSION` | `0`（無制限） | 1 回の体験での案内（narrate）の Gemini 呼び出し上限 |
| `GEMINI_MODEL` | `gemini-2.5-flash` | 使用する Gemini モデル |
| `PORT` | `3000` | リッスンポート |
| `HOST` | `127.0.0.1` | バインドアドレス（`0.0.0.0` でLAN公開） |
| `GEMINI_PRICE_IN_PER_M` | `0.3` | 入力トークン 1M あたりの USD |
| `GEMINI_PRICE_OUT_PER_M` | `2.5` | 出力トークン 1M あたりの USD |
| `USD_JPY` | `150` | USD から JPY への換算レート |
| `LOG_QUESTION_TEXT` | `0` | `1` に設定するとログに質問テキストを記録（デフォルト非記録） |
| `DATA_DIR` | `./data` | データ保存ディレクトリ |

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
- **ログ**: イベントベース（events.jsonl）で保存。個人軌跡ではなく、Spot 到達、質問の有無などを記録
- **決済**: モック実装（デモ用）。実際の課金は別途実装が必要

### データ保存
- **Spot と素材**: `data/spots.json` に保存（バージョン 2）
- **ログ**: `data/logs/events.jsonl` に追記（1 イベント = 1 行）
- **バックアップ**: データ更新時に `data/logs/*.backup-{timestamp}.json` が自動作成
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
│   ├── store.js                     # ファイル I/O・ログ記録
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
│   ├── spots.json                   # Spot データ（位置 + 素材）
│   ├── scenario.json                # ウォーク全体の流れ（プロトコル）
│   ├── knowledge.json               # 一般知識ベース（補足情報）
│   └── logs/
│       ├── events.jsonl             # イベントログ（1 行 = 1 イベント）
│       ├── purchases.json           # 購入・チェックイン実績
│       ├── recordings/              # 音声録音ファイル（処理後削除）
│       └── *.backup-*.json          # 自動バックアップ
├── scripts/
│   └── seed-demo.js                 # OSM からデモデータ自動生成
└── test/
    └── *.test.js                    # ユニットテスト
```

詳細は [docs/DESIGN.md](docs/DESIGN.md) を参照。

## 開発・デバッグ

### ローカルテスト

```bash
npm test                   # 全テスト実行
node server.js             # サーバー起動（http://localhost:3000）
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
