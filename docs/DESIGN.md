# 設計書 — デジタルネイチャー＆ウェルネスインストラクター 皇居外苑版（Phase 1）

チーム共通の取り決め。**ここに書いたデータ形式と API 契約は勝手に変えない**（変える場合はリードに相談）。

## 1. コンセプト（ユーザー合意済み）

- 「AI ガイド」と言わない。スマートフォンから目を離すための音声中心の体験。Eyes Up / Audio First / Nature First。
- 音声は**合成音声（ブラウザ TTS）**。ガイドさん本人の録音は流さない（内容を人に合わせて変えるため）。
- **ガイドさんは「素材」を登録する**（事実・見どころ・小話・気づいてほしいこと・必ず伝えたいこと）。完成した読み上げ原稿ではない。
- **AI がその場で話す内容を組み立てる**。材料は「最初のアンケート（選択肢＋自由記述）」「いまの様子（歩いている/止まっている/この場所に何秒いるか/通り過ぎつつある）」「残り時間」「それまでの会話」。
  - 例: 自由記述に「植物に興味がある」→ 同じ場所でも木の話を中心に。「今日は元気、アクティブに」→ 歩きながらテンポよく。「疲れているのでゆっくり森林浴で癒されたい」→ 話を減らし Silence を長めに。
- **速く歩く人もペースを尊重**。「ペースを落としましょう」とは言わない。人のガイドのように「この松にはもう少し話がありますが、先に進みますか？」と聞く。
- **迷ったら本人に聞く**。ただし**質問は 1 Spot につき最大 1 回**。返事は**声でも画面ボタンでも**よい。返事がなければ静かに見守る側を選ぶ。
- Intentional Silence（意図的に黙る時間）は重要な UX。エラーや待ち時間ではない。
- 速度の「段階」は作らない。数値と状態をそのまま AI に渡して判断させる。
- 位置の精度は木の下で ±5〜15m。**1 本の木ではなく半径 15〜50m の「エリア」に素材を紐づける。**
- 体験者の移動軌跡はサーバーに保存しない（速度・滞在の判定は端末内だけ）。個人情報は必要以上に取らない。
- 迷子用の地図は後回し（Phase 1 の最後）。

## 2. ディレクトリと担当（ファイル競合防止）

| パス | 担当 |
|---|---|
| `server.js`, `lib/*` | リード（変更が必要ならリードに依頼） |
| `routes/core.js` | リード |
| `routes/walk.js`（/api/ask, /api/narrate） | implementer-walk |
| `routes/guide.js`（ガイドさん API, 録音ウォーク） | implementer-guide |
| `public/index.html`, `public/css/style.css`, `public/js/{app,engine,motion,voice,sim,i18n}.js` | implementer-walk |
| `public/guide.html`, `public/js/guide*.js`, `public/css/guide.css`, `public/admin.html` | implementer-guide |
| `public/editor.html`, `public/js/editor.js` | implementer-guide（guide.html に統合して削除してよい） |
| `data/scenario.json` | implementer-walk |
| `data/spots.json`, `data/knowledge.json`, `scripts/*` | implementer-guide |
| `test/*` | tdd-guide |
| `README.md`, `docs/*`（本書以外） | doc-updater |

開発時のポート: implementer-guide は `PORT=3101`、implementer-walk は `PORT=3102`、tdd-guide は `3103`（3000 はユーザー用に空ける）。

## 3. データ形式

### 3.1 `data/spots.json`（version 2）

```jsonc
{
  "version": 2,
  "spots": [
    {
      "id": "kuromatsu",            // 英小文字・数字・ハイフン。一意
      "order": 4,                   // おすすめルート順（任意。GPS では順不同で反応）
      "enabled": true,
      "name": { "ja": "黒松の広場", "en": "Black Pine Lawn" },
      "kind": "trees",              // landmark | gate | bridge | trees | water | view | garden | rest | other
      "lat": 35.68, "lng": 139.756,
      "radius": 50,                 // 反応半径 m（15〜100）
      "materials": [                // 素材 = 話の種。AI はここに無い事実を話さない
        {
          "id": "kuromatsu-m1",     // spot 内で一意
          "type": "fact",           // fact(事実) | story(小話) | sense(五感への促し) | notice(注意事項) | must(必ず伝える)
          "text": "このあたりにはクロマツが…",
          "lang": "ja",             // 素材は 1 言語で可。AI が話す言語に訳す
          "topics": ["plant"],      // plant | history | culture | nature | birds | water | view | senses | safety
          "source": "guide",        // seed | osm | guide | recording
          "author": "",             // ガイドさん名（任意）
          "verified": false,        // ガイドさん確認済みか
          "createdAt": "ISO8601"
        }
      ],
      "interactions": [             // おすすめの関わり（AI が状況で使う/使わないを選ぶ）
        { "type": "LOOK" }, { "type": "SILENCE", "seconds": 60 }
      ],
      "osm": null                   // OSM 由来なら { "type": "node", "id": 123, "tags": {...} }
    }
  ]
}
```

### 3.2 `data/knowledge.json`
既存のまま（一般知識。`chunks[].title/text` が ja/en）。

### 3.3 チェックイン（クライアント → narrate/ask）
```json
{ "state": "head|body|low|ok", "desire": "refresh|calm|nature|body", "note": "自由記述（声入力可）" }
```

## 4. API 契約

共通: JSON。体験者は `X-Session-Token`、ガイドさんは `X-Guide-Token`（`POST /api/guide/login {passcode}` で取得。合言葉は環境変数 `GUIDE_PASSCODE`、既定 `GAIEN-GUIDE`）。
LLM を使ったら `appendEvents([{type:'llm_usage', ts, sessionId?, purpose, model, inputTokens, outputTokens, costJpy}])` を必ず記録（コスト検証のため）。

### 4.1 `POST /api/narrate`（implementer-walk）— その場で案内を組み立てる

リクエスト:
```jsonc
{
  "lang": "ja",
  "checkin": { "state": "head", "desire": "nature", "note": "植物に興味がある" },
  "trigger": "arrive",          // arrive(Spot に入った) | linger(止まって滞在中) | reply(質問への返事) | between(Spot 間)
  "spotId": "kuromatsu",        // between のときは null
  "motion": { "moving": true, "speedMps": 1.4, "dwellSec": 0, "distanceToSpotM": 12 },
  "timing": { "elapsedMin": 12, "remainingMin": 28 },
  "spokenMaterialIds": ["kuromatsu-m1"],   // この Spot で既に使った素材
  "askedAtSpot": false,         // true ならサーバーは ask を必ず null にする
  "pendingAsk": null,           // reply のとき: 直前にした質問 { text, options }
  "userReply": null,            // reply のとき: { optionId } または { text }（声）。無返事は送らない
  "history": [{ "role": "user|model", "text": "..." }],  // 直近 6 件
  "clientTime": "ISO8601"
}
```
レスポンス:
```jsonc
{
  "say": "…",                   // 読み上げる文。'' なら何も言わない。最大 3 文（速く歩いているときは 1〜2 文）
  "ask": null,                  // または { "text": "もう少し聞きますか、それとも先に進みますか？",
                                //          "options": [{ "id": "more", "label": "もっと聞く" }, { "id": "next", "label": "先に進む" }],
                                //          "defaultId": "next" }   ← options は 2〜3 個、label は短く
  "next": "wait",               // wait(何もしない) | silence | interaction | move_on(次へ促す)
  "interaction": null,          // next=interaction のとき LOOK | LISTEN | WALK | STOP | REST
  "silenceSec": null,           // next=silence のとき 20〜180
  "usedMaterialIds": ["kuromatsu-m2"],
  "fallback": false             // LLM 失敗時に素材から機械的に作った応答なら true
}
```
サーバー側の保証: JSON 以外を返さない／`ask` は askedAtSpot=true なら null／`silenceSec` を 20〜180 に丸める／`usedMaterialIds` は実在 id のみ／LLM 失敗時は未使用の素材（must→fact→sense の順）から `say` を作り `fallback:true`。

### 4.2 `POST /api/ask`（実装済み）— 体験者の自由質問
`{question, lang, spotId, checkin, history, clientTime}` → `{answer, sources, fallback?}`。spot.materials を優先知識として使う。

### 4.3 ガイドさん API（implementer-guide）
| メソッド | パス | 内容 |
|---|---|---|
| POST | `/api/guide/login` | 実装済み（routes/core.js） |
| PUT | `/api/spots` | 全件保存（実装済み） |
| PUT | `/api/guide/spots/:id` | 1 件 upsert |
| DELETE | `/api/guide/spots/:id` | 1 件削除 |
| POST | `/api/guide/transcribe` | `{audioBase64, mimeType, lang}` → `{text}`（Gemini で文字起こし。音声は保存しない） |
| POST | `/api/guide/extract` | `{transcript, lat, lng, spotId?, lang}` → `{name?, kind?, radius?, materials:[...], interactions:[...]}`（話した内容を素材に分解。**話していない事実を足さない**） |
| POST | `/api/guide/recordings` | 録音ウォーク開始 → `{recordingId}` |
| POST | `/api/guide/recordings/:rid/chunk` | `{index, startedAt, durationSec, audioBase64, mimeType, track:[{t,lat,lng,acc}]}`（約 5 分ごと。受信したら即文字起こしし、音声は破棄） |
| POST | `/api/guide/recordings/:rid/finish` | 立ち止まって話した場所を検出 → Spot 候補 `{candidates:[{lat,lng,radius,name,materials,nearestSpotId}]}` |
| GET | `/api/guide/recordings/:rid` | 状態と候補 |

音声を受ける API は `readBody(req, 25_000_000)` で上限を上げる。録音ウォークの記録（文字起こしと軌跡。音声は保存しない）は保存先（`lib/store`）の `createRecording` などで書く（Firestore 版は `envs/{ns}/recordings/{id}` と `chunks/{番号}`、ファイル版は `data/logs/recordings/`）。

## 5. 体験の流れ（クライアント, implementer-walk）

1. 購入コード → 言語 → **チェックイン**（状態・希望のチップ＋自由記述/声入力）→ 準備 → ウォーク → ふりかえり＋アンケート（既存）
2. Slow down（冒頭）と Reflect/Return（締め）は `scenario.json` の定型文。
3. Spot の手前（半径 + 60m 以内に近づいた時点）で `narrate(trigger:'arrive')` を**先読み**し、入ったら即読み上げる。
4. Spot 内で止まって 45 秒以上 → `narrate(trigger:'linger')`（1 Spot 最大 2 回）。
5. Spot から離れつつある（半径 × 1.5 を超えた）ら、その Spot の未読み上げ分は捨てる（話の途中なら文の切れ目で止める）。
6. `ask` が来たら: 読み上げ → 大きな選択ボタンを表示 → マイクを約 8 秒だけ開く（声の返事）→ `narrate(trigger:'reply')`。12 秒返事がなければ何もしない（静かに見守る）。
7. `next=silence` は既存の Silence の流れ（目安時間・「戻りました」・鐘の音）。
8. Spot 間の声かけ（between）は `scenario.json` の定型文で良い（コスト節約）。間隔は動きと希望（calm は少なめ、active は多め）で調整。
9. `narrate` が 8 秒以内に返らない／失敗 → 素材から機械的に読み上げる（オフライン耐性）。
10. **歩行シミュレーション**: 地図クリックで移動、速さボタン（止まる/ゆっくり/ふつう/はやい）、「次の Spot へ」ジャンプ。ガイドさんの登録前でも OSM 由来のデモ素材で一通り動くこと。

## 6. ログ（集計 /admin.html 用）
既存: `session_start, checkin(state,desire,note), spot_reached, interaction, silence_end, question_asked, stt_used, tts, error, session_complete, reflection, survey`
追加: `narrate(trigger, spotId, latencyMs, fallback)`, `guide_ask(spotId)`, `guide_ask_reply(via: button|voice|timeout, optionId)`

## 7. デモデータ（implementer-guide）
`scripts/seed-demo.js`: OpenStreetMap（Overpass API, 読み取りのみ）から皇居外苑周辺の名前付き地物・樹木を取得し、**タグに書かれている事実だけ**から素材（`source:"osm", verified:false`）を作る。knowledge.json の該当チャンクも素材化してよい。既存の 6 Spot は残してマージ。`--dry-run` で差分表示、既定は保存先の Spot を更新（`updateSpots` が古い版を自動で残す。Firestore 版は `envs/{SPOTS_NAMESPACE}/data/spots`）。
