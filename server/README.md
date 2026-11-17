# 解析サーバー（開発者向け）

Issue [#2](https://github.com/phni3j9a/kifumate/issues/2) の全局解析と [#8](https://github.com/phni3j9a/kifumate/issues/8) の分岐中の解析、Issue [#12](https://github.com/phni3j9a/kifumate/issues/12) のAIコーチを実装しています。アプリ画面・ストア説明・APIにはエンジン／評価関数の固有名を渡しません。この文書の固有名は、開発・ライセンス・入手手順のための記録です。

## 構成と仕様

- TypeScript Worker：匿名端末トークンを発行し、SHA-256から利用者別DOを特定。トークン原文・対局者名は保存しません。
- `Device`：SQLite-backed DO。`jobs`・`results`・`usage`・`meta`を保存し、alarmが1局面ずつ進めます。クライアントの接続維持は不要です。
- モード別Container：各2枠の固定プール。端末DOのIDで振り分け、中継のロックがUSI操作を直列化します。別端末の棋譜・結果は混ぜません。局面ごとに開始局面と指し手列を再設定します。
- Python + cshogi中継：棋譜全体の合法手検証、USI、先手視点の評価値、1手・3手詰めの確認。詰み候補は全応手を再検証し、証明できた手順だけを返します。

| モード | 1局面の探索 | Threads | MultiPV | インスタンス |
| --- | --- | --- | --- | --- |
| `std` | 250ms | 1 | 1 | `standard-2`（1 vCPU、6 GiB、12 GB） |
| `precise` | 1000ms | 2 | 3 | `standard-3`（2 vCPU、8 GiB、16 GB） |

入力上限は512手、JSONは16 KiB。開始局面（0手目）と全着手後を解析するため、結果は「手数+1」局面です。

### ジョブ・回数・保存期間

- 利用者ごとに実行は1局。追加依頼は順番待ちです。中止・待ちの取り消しは同じDELETE APIです。
- 同じ正規化済み開始局面文字列・USI指し手列・モードの重複は、保存中の既存ジョブを返します。開始局面の空白は正規化しますが、同じ盤面の異なるSFEN表現までは同一視しません。
- 無料は週10局。有料は合計週100局、そのうち精密20局。月曜0時JSTで区切ります。精密だけ上限に達してもstdは使えます。
- 受理した週の枠を予約し、成功時だけその週の使用数に振り替えます。週をまたぐジョブも受理週に属します。`remaining`は実行中・待ちの予約を除いた数です。
- 失敗・中止は予約を返却します。再依頼は新しいIDでやり直せます。完了ジョブの重複依頼は再集計しません。
- 通信断でもalarmで継続。コンテナ障害時は保存済み`cursor`から最大5回まで再試行します。watchdogは60秒、1回のコンテナ呼び出しは45秒で打ち切ります。結果と使用数の確定はSQLiteの同一トランザクションです。
- 完了7日後にジョブ・結果・指し手列を削除します。失敗・中止も終了7日後に削除。使用数は別テーブルなので結果削除では戻りません。端末には結果を永続保存してください。
- `sleepAfter = '10s'`。PythonはPID 1でもSIGTERMを処理して終了します。stagingの`max_instances`は各モード2です。

## API

全応答はJSON、`Cache-Control: no-store`。端末発行以外は`Authorization: Bearer <token>`が必要です。HTTPSで呼び出してください。

| API | 内容 |
| --- | --- |
| `POST /v1/devices` | **空の本文**で発行。201 `{ "token": "64文字のランダムhex" }`。安全な端末ストレージに保存 |
| `GET /v1/quota` | `paid`, `weekStart`, `resetsAt`, `totalRemaining`, `preciseRemaining`, `completed`, `reserved` |
| `POST /v1/jobs` | ジョブ作成。新規202、重複200。下記本文のみ許可 |
| `GET /v1/jobs` | 保存中のジョブ一覧（結果本体なし）と`quota` |
| `GET /v1/jobs/:id?from=n` | `n`局面目以降の差分結果とジョブ状態・`quota` |
| `DELETE /v1/jobs/:id` | 実行中／待ちを中止。終了済みには何もしない |

作成本文：

```json
{"initial":"startpos","moves":["7g7f","3c3d"],"mode":"std"}
```

`initial`は`startpos`または**`sfen `という接頭辞なし**のSFEN文字列。`moves`はUSI配列。対局者名等の追加キーは拒否します。形式は入口で検査し、駒配置や棋譜全体の合法性は中継で検査します。不正な棋譜はジョブの`failed / invalid_position_or_move`となり、回数には数えません。

ジョブ応答には`id`, `mode`, `status`, `next`, `total`, `createdAt`, `finishedAt`, `expiresAt`, `error`, `results`があります。時刻はUnixミリ秒。状態は`queued / running / completed / cancelled / failed`です。`next`を次の`from`に渡してください。通信断後も最後に保存した`from`から再取得でき、結果の`ply`で重複を排除できます。

各結果：

```json
{
  "ply": 0,
  "score": {"kind":"cp","value":25},
  "candidates": [
    {"rank":1,"depth":10,"score":{"kind":"cp","value":25},"move":"7g7f","pv":["7g7f","3c3d"]}
  ],
  "mate": null
}
```

- `cp`は先手有利が正、後手有利が負。`bound`があれば`lowerbound / upperbound`も先手視点です。
- 詰みスコアは`kind: "mate"`、符号も先手視点、`winner: "sente" | "gote"`で勝つ側を示します。距離不明の`+ / -`は`value: null`。すでに詰んだ局面は距離0です。
- `score.kind === "mate"`は探索スコアであり、詰みの証明ではありません。画面で「詰みあり」と出せるのは`mate`があるときだけです。
- 証明結果は`mate: {plies: 1 | 3, pv: [...], branches: [{reply, mate}, ...]}`。`branches`は初手に対する全応手とその詰め手です。`null`は今回証明できていないという意味で、詰みなしの断定ではありません。王手されている局面はこの短手数検出の対象外です。
- 入玉宣言は**27点ルール（`EnteringKingRule=CSARule27`）**です。`bestmove win`は`score: {kind: "declaration", value: null, winner: "sente" | "gote"}`とし、候補は`declarationWin: true, pv: []`で`move`を持ちません。通常の着手や証明済みの詰みではないので`mate`はnullです。
- 候補がない終局では`candidates: []`。非詰みの終局で探索値がなければ`score: null`です。

主なエラー：400（入力・カーソル）、401（端末未登録／認証）、403（精密に有料権利が必要）、404、413（本文過大）、415（JSON必須）、429（週上限、`quota.resetsAt`付き）。内部の例外やUSIの`id`・`info string`はAPIに返しません。

## 分岐中の解析（有料限定）

### API・アプリ側の接続方法

全局解析と同じ端末トークン・開発用有料判定を使います。全局解析の回数とは独立しています。

| API | 内容 |
| --- | --- |
| `GET /v1/realtime` | 現在のセッション・最新結果・月の残りを取得。コンテナを起動せず、休止期限も延長しない |
| `POST /v1/realtime` | 最初の局面 `{initial,moves}` を送り開始。202 とサーバー生成の `sessionId` を返す |
| `PUT /v1/realtime/:sessionId` | `{initial,moves,sequence}` で局面を変更・休止から再開。202。`sequence` は1以上の単調増加整数 |
| `DELETE /v1/realtime/:sessionId` | オフ・分岐を出る・対局を閉じる・アプリのバックグラウンド移行で停止。停止完了後200。休止中でもオフになる |

POST/PUTには`mode`・対局者名など追加キーを渡せません。開始局面とUSI配列・上限は全局解析と同じです。指し手列の**最後の局面だけ**を解析し、`result.ply`はその手数です。セッション中は端末側で`sequence`を増やし、返った`sessionId / sequence`が現在表示中の局面と一致するときだけ結果を表示してください。古い・重複のsequenceは409 `stale_sequence`、停止済み・古いsessionIdは409 `stale_session`です。

応答例（時刻はUnixミリ秒）：

```json
{
  "sessionId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "sequence": 2,
  "status": "ready",
  "result": {"ply":2,"score":{"kind":"cp","value":25},"candidates":[],"mate":null},
  "error": null,
  "idleMs": 30000,
  "quota": {"monthStart":1793458800000,"resetsAt":1796050800000,"limitMs":18000000,"usedMs":12000,"remainingMs":17988000,"low":false}
}
```

`result`の実際の候補・評価・詰みの形式は全局解析と共通で、固有名を含みません。最初の準備中や新しい局面の解析中は`result: null`です。

| status | アプリ側の扱い |
| --- | --- |
| `preparing` | オン・準備中（初回／休止後） |
| `analyzing` | オン・解析中 |
| `ready` | オン・最新結果を表示 |
| `paused` | オンのまま休止。次のPUTで再開。結果は取得可能 |
| `off` | オフ。再び指すときPOSTで新規セッション |
| `limit` | 残り0分。`quota.resetsAt`を案内。翌月のPUTで再開可能 |
| `failed` | 失敗。理由は`error`。再試行は新規POST |

通信なしはサーバー状態ではなく、アプリが通信エラーから表示します。GETだけは無料端末も利用でき、`paid`を返します。作成／更新は403 `paid_required`、月の上限は429 `monthly_limit`（`quota.resetsAt`付き）です。DELETEは有料権利がなくても可能です。無料への変更を検知した端末の稼働は停止します。

アプリは202の後、前面で結果を待つ間だけ**250〜500ms間隔のGET**を行い、readyで止めます。次の操作では直ちにPUTし、前のHTTP応答を待たないでください。POSTの応答を失った場合はGETでsessionIdを回収します（再POSTは409 `session_exists`）。アプリを裏に回すときはGETを止めてDELETEを試み、通信断などで届かなければ自動休止に任せます。復帰時にGETし、pausedならsequenceを進めてPUT、off/failedならPOSTします。

**HTTPを採用した理由**：1局面250msの探索に短いGETポーリングを足しても連続操作に十分速く、既存の認証・HTTP・Python中継を再利用できます。WebSocketは途中情報をより速く流せますが、モバイルのバックグラウンドで維持できず、切断／再接続と課金寿命の管理が増えます。接続状態ではなく局面操作で寿命を更新するHTTPの方が、通信断でも30秒で休止する仕様を小さく実装できます。

### 探索・休止・時間の数え方

- **250ms / Threads 1 / MultiPV 1 / standard-2（1 vCPU、6 GiB、12 GB）**を採用。分岐では最善手1手と読み筋を素早く返し、精密全局解析の1000ms・3候補と区別します。既存の通常解析と同設定・同イメージを再利用し、費用と探索時間を増やしません。実測・費用は[measurement.md](docs/measurement.md)を参照。
- 分岐専用の`RealtimeContainer`を2枠追加。全局解析のコンテナとは共有しません。端末DOのIDから固定枠を選び、その枠を一端末へ排他的に貸与します。別端末が使用中なら409 `realtime_busy`で即時拒否し、その端末の時間は減りません。別枠への待ち行列・移動はありません。`shortcut:` 同時利用2枠・ハッシュ衝突で空き枠があっても拒否するstaging構成です。一般公開前に利用実測をもとに枠数・振り分けを更新してください。
- 局面更新は旧HTTP要求を破棄し、中継は新しい要求を**USIロック取得前**に登録して旧探索に`stop`を送ります。旧bestmoveを読み切ってから新局面へ移り、遅延結果はsessionId・sequenceで破棄します。初回の共通起動は局面変更ではやり直しません。
- `REALTIME_IDLE_MS`の既定は`30000`（許容1000〜300000ms、不正値は既定へ）。**最後に受理したPOST/PUT**から測ります。探索完了・ポーリング・通信接続は期限を延長しません。永続alarmで休止・上限停止を行い、明示停止はコンテナをdestroyします。停止失敗時は枠と集計を保持し1秒後に再試行します。
- 数えるのは**コンテナ起動要求から停止完了までの壁時計時間**。準備・探索・結果が出た後の待機・停止処理を含み、局面数やCPU使用時間では数えません。初回要求／手動起動から料金が始まる[公式の説明](https://developers.cloudflare.com/containers/platform/pricing/)に合わせたサーバー時計による集計で、Cloudflare請求メーターとの完全一致を保証するものではありません。
- 月300分（18,000,000ms）、**JST月初0時**で区切ります。月をまたぐ稼働は両月へ分割。残り時間までのalarmを設定し、使い切ると停止します。利用上限値で集計を丸めるため、alarmの遅延や停止処理の端数を超過請求しません。翌月に勝手に再起動はせず、次の局面更新で再開します。
- `quota.low`がtrue（残り10%未満）のときだけ残りを知らせ、それ以外では上限・残りを画面に出さないでください。停止・失敗したセッションも実際の稼働時間は返却しません。全局解析の失敗時の回数返却とは別です。
- 利用量と最新セッションは分岐用Container DOのSQLiteへ永続化し、DOの再生成でも集計を継続。停止済みの結果は最終操作から7日後のアクセス時に削除し、月利用量は当月・前月を保持します。月上限になったセッションID・sequenceだけは翌月の再開用に最大40日保持します。次のセッションで上書きされるため、必要な分岐結果は端末に保存してください。
- 権利判定はWorkerで最新secretを評価し、Deviceが内部ヘッダーを必ず上書きします。本文受信中に同じ端末の別の分岐API呼び出しで権利が更新された場合も、解析開始の確定直前に最新の判定を再確認します。RevenueCat連携時は既存のWorker有料判定とDeviceの`paid()`を差し替え、分岐の時間集計・Pythonには変更不要です。公開前には権利失効の能動通知も必要です（現状は当該端末の次の分岐API呼び出し、遅くとも無操作休止で停止）。

## AIコーチ（有料限定）

### アプリとの契約

全局解析と同じ匿名端末認証を使います。精密解析の**完了時**に `COACH_SIGNING_KEY` で棋譜・全結果・端末・ジョブ・期限をHMAC-SHA256署名し、既存ジョブ応答に `coachProof` を追加します。通常解析・未完了・署名鍵未設定では `null`。その他のフィールドや差分取得は変更しません。差分GETにも全体の同じ証明が付くので、アプリは全 `results` を `ply` 順に集め、`initial / moves / mode / results / coachProof` を端末へ保存してください。

証明は**発行から365日**有効。7日後にサーバーの解析結果が消えても利用できます。期限後は精密解析をやり直します。署名前の旧結果に証明を後付けしません。端末トークンを再発行・別端末へ移した結果はこの端末の証明では使えません。鍵を変更すると発行済み証明も無効になるため、永続secretとして保管してください。鍵ローテーション・購入復元と端末移行の扱いは公開前の別課題です。

| API | 内容 |
| --- | --- |
| `GET /v1/coach` | `{paid, quota}`。無料でも残量を取得可能 |
| `POST /v1/coach` | 解説または質問を一件生成。200で検査済みJSONを返す |
| `DELETE /v1/coach/:requestId` | 中止。無料へ変更後も可能。既に成功した回答は取り消さない |

POST本文（追加キー・人名フィールドは拒否）：

```json
{
  "requestId": "端末で生成したUUID",
  "analysis": {"initial":"startpos","moves":["7g7f"],"mode":"precise","results":["全局解析APIの全結果（ここでは省略）"]},
  "proof": {"発行済みcoachProofをそのまま送る":"ここでは省略"},
  "perspective": "sente",
  "profile": {"practice":["四間飛車"],"goal":"終盤に強くなる"},
  "style": {"focus":"総合","detail":"ふつう"},
  "history": []
}
```

- `perspective`: `sente / gote / observer`。自分が後手なら `gote`、他者の対局なら `observer`。
- `focus`: `総合 / 序盤の駒組み / 中盤の攻防 / 終盤 / 悪手・改善点`。`detail`: `かんたん / ふつう / くわしく`。
- 追加質問は同じ棋譜・結果・証明に `question` を付け、`history: [{role:"user"|"assistant",content:"本文"}]` を送ります。systemロールは禁止。解説の作り直しではquestionを省略しhistoryを空にします。
- **履歴・解説・プロフィールはアプリだけに保存**します。サーバーは月使用数と要求ID・状態・期限だけを当月と前月程度保持し、会話や応答本文は永続化しません。毎回署名で棋譜を特定できるのでサーバーの会話セッションは不要です。自由文には対局者名・他社名を入力せず、端末側でも送信前に「あなた」「相手」へ置換してください。
- `requestId` は新規の解説／質問ごとのUUID。同じIDは409 `request_exists`となり二重課金しません（応答再取得はできません）。応答を失った場合はGETで使用数を確認し、無条件に新しいIDで再送しないでください。
- 中止はHTTPのabortだけに頼らず**同じIDのDELETE**を送ります。本文受信より先のDELETEも墓標として保存し、遅延POSTを止めます。成功確定と中止が競合した場合は先に確定した状態を返します。DELETE自体が届かなかった場合、サーバーでは成功として数える可能性があります。

200応答例：

```json
{
  "requestId":"...",
  "sections":[
    {"kind":"facts","title":"対局の振り返り","text":"解析の候補を確かめましょう。",
     "references":[{"id":"0:candidate:1","ply":0,"score":{"kind":"cp","value":25},"pv":["7g7f","3c3d"],"provenMate":false}]},
    {"kind":"advice","title":"次の練習","text":"気になった局面を盤の上で確かめましょう。","references":[]}
  ],
  "quota":{"monthStart":1793458800000,"resetsAt":1796050800000,"limit":100,"used":1,"reserved":0,"remaining":99,"low":false}
}
```

本文は**プレーンテキスト**で表示し、HTMLとして解釈しないでください。`facts` は解析根拠、`advice` は個別の学習助言として区別。参照の `ply` は指す前の局面、`pv` はそこからの読み筋です。`position` は局面評価、`candidate:rank` は候補、`mate` だけが証明済み詰み（`provenMate:true`）です。数値は先手視点。盤面リンク・読み筋・評価値は自由文でなく `references` から描画します。

**非ストリーミングを採用**：本文の固有名・参照を全部検査してから公開でき、失敗や中止時の回数確定も単純です。未検査の文を逐次表示しません。初期表示ではアプリで「考え中」を出してください。体感速度・生成時間はキー入手後の比較対象です。

### 回数・安全策

- 月100回（`COACH_MONTHLY_LIMIT`、1〜10000。不正値は100）。**JST月初0時**でリセット。解説も追加質問も成功ごとに一回。受理月へ予約し、検査済み応答の確定時にその月だけへ加算します。月またぎでも二重集計しません。
- 端末ごとに同時一件。予約中を除いた `remaining` と `reserved` を返します。失敗・明示中止・タイムアウトは加算しません。DO再生成で処理を失った予約も永続期限後に返却されます。`low` がtrue（残り10%未満）のときだけ残りを案内し、残り0では `resetsAt` を案内します。
- 本文は実測1 MiB、棋譜512手、学習戦法10個×40文字、目標500文字、質問1000文字、履歴20件×4000文字。既存解析APIの16 KiB上限は変更しません。
- `COACH_MAX_TOKENS` 既定2000（1〜8000）、`COACH_TIMEOUT_MS` 既定45000ms（1〜120000）。JSON応答は128 KiBまで。提供元へのリダイレクトは拒否。入力・応答・APIキーはログに出しません。
- Workerの最新権利判定とDeviceの`paid()`を再利用し、本文受信・署名検証後と成功確定前に権利を再確認します。現在の開発用課金判定は本番で無効です。
- LLMにはエンジン名・評価関数名・対局者名フィールドを渡しません。入力自由文と出力に対し既知の内部名・サービス名・敬称付き人名等を検査し、疑わしい出力は502にして課金しません。**未知の固有名を完全判定する機構ではありません**。自由文中の未知人名・婉曲な手順・根拠に合わない形勢説明までの完全な意味検証はできず、実モデル評価が必要です。
- 指し手はLLMに自由生成させず、署名済み参照IDのみを選択させます。候補PV・詰みPVは既存Python中継で各手の合法性を検査済み。出力後に参照の存在を照合し、数字・棋譜表記が本文に混ざる場合は失敗とします。このため任意の未解析分岐は解説できません（分岐中の解析とは独立）。

主なエラー：400 `invalid_proof / precise_required / invalid_input / unsafe_names`、403 `paid_required`、409 `coach_busy / request_exists / cancelled`、413、415、429 `monthly_limit`、502 `provider_failed / invalid_output`、503 `provider_unavailable / signing_unavailable`、504 `coach_timeout`。コーチのエラー応答には `quota` も付きます。

### 設定と提供元

キーは `wrangler secret` で保存します。署名鍵はプロバイダーのキーとは別のランダム32バイト以上を用意します。

```sh
# 永続鍵（ログに表示・gitへ保存しない）
openssl rand -hex 32 | npx wrangler secret put COACH_SIGNING_KEY --env staging
# APIキー入手後。標準はOpenAI互換の非ストリーミングChat Completions + JSON出力
npx wrangler secret put COACH_API_KEY --env staging
```

| 設定 | 第一候補 | 比較対象 |
| --- | --- | --- |
| `COACH_PROVIDER` | `openai-compatible`（省略時も同じ） | 同左 |
| `COACH_BASE_URL` | `https://api.openai.com/v1` | `https://api.deepseek.com` |
| `COACH_MODEL` | `gpt-6-luna` | `deepseek-flash` |
| `COACH_TOKEN_PARAMETER` | `max_completion_tokens`（既定） | `max_tokens` |

両者に `reasoning_effort:none`、`response_format:{type:json_object}` を送ります。2026-11-17に [OpenAIモデル公式](https://platform.openai.com/docs/models/gpt-6-luna)、[DeepSeek変更履歴](https://api-docs.deepseek.com/updates/)、[Chat Completions公式](https://api-docs.deepseek.com/api/create-chat-completion/) を確認しました。DeepSeekの仕様上の呼称はV4.1 Flash 1017、API IDは`deepseek-flash`です。利用可能なアカウント・応答互換性は実キーで未検証のため、候補を固定採用したわけではありません。

`COACH_PROVIDER=fake` は **local/stagingだけ**に許可し、production等では503にします。既定では偽物を使わず、キー・URL・モデル未設定なら503（使用数0増加）です。

staging検証と実モデルの比較手順・実測は [ai-coach.md](docs/ai-coach.md) を参照してください。

## ローカル開発

必要：Node.js 22以降、Python 3.12、Docker（linux/amd64）。ホストへのsudo操作は不要です。Dockerfileのapt操作はビルドコンテナ内だけです。

```sh
cd server
npm ci
python3 -m venv container/.venv
container/.venv/bin/pip install -r container/requirements.txt pytest==9.0.2
npm test                  # 実際のWorkersランタイム・SQLite DO、偽の中継
npm run test:python       # 偽USIプロセス・合法手・評価正規化・詰み
npm run typecheck
npm audit
```

### 評価関数の配置（コミット禁止）

水匠11 Plusの評価関数は利用者が正規の入手権限を用意してください。[公式案内](https://yaneuraou.yaneu.com/2026/10/14/tsuyou-11-mini-micro-released-under-mit-license/)から頒布元を確認できます。**このリポジトリ・公開イメージで再配布しません。** 今回の取得元はユーザー指定のローカル保管物です：

```sh
mkdir -p container/eval
cp /home/server/projects/sekirei-weight/data/raw/teacher/suisho11plus/ee23379ab3bb0422e7d2f3f8df4feb297a77e6cbada6a350926fd4757bea9478/eval/nn.bin container/eval/nn.bin
```

- SHA-256：`a78b7f889843037d344f482623b3febd124ead5c1f34f134d9f1c2c78cd0f829`
- アーキテクチャ：`SFNN_halfka2_1024_7_64_k3k3`、USIオプション`FV_SCALE = 40`。
- `container/eval/`全体をgitignoreしています。Dockerビルド内でもSHA-256が一致しなければ失敗します。エンジンのバイナリもGitへ追加しないでください。

### エンジン・CPU・ライセンス

Dockerfileは[やねうら王公式ソースのV9.70コミット](https://github.com/yaneurao/YaneuraOu/commit/76d58ef2e4cf64116784f41fd4816425ab6817ee)を固定し、公式の生成スクリプトで該当ヘッダーを作り、`YANEURAOU_ENGINE_SFNN_halfka2_1024_7_64_k3k3`でビルドします。

[Cloudflare公式の対応イメージ](https://developers.cloudflare.com/containers/get-started/#the-container-image)は`linux/amd64`です。将来の配置先までAVX2/BMI2を保証する資料はないため、**互換版とAVX2版を同梱し、起動時に実機の命令セットを確認**します。

- 互換版：`TARGET_CPU=OTHER`（`NO_SSE`スカラー実装）、`-march=x86-64 -mtune=generic`。公式Makefileの`NO_SSE`ターゲットは32bit用なので使いません。
- 高速版：同じコミット・アーキテクチャの`TARGET_CPU=AVX2`。公式Makefileの`corei7-avx`とBMI1/BMI2の前提に合わせ、`avx avx2 xsave bmi1 bmi2 popcnt ssse3 sse4_1 sse4_2 aes pclmulqdq cx16`をすべて必要とします。
- `/proc/cpuinfo`の**全vCPUの共通flags**が揃う場合のみAVX2版を使います。取得失敗・欠落・1 CPUでも非対応なら互換版へ戻します。CPUモデル名だけでは判断しません。
- 両版は同じ評価関数・`FV_SCALE=40`・探索設定を使用します。時間制限は変えず、AVX2で同時間内の探索量を増やします。実機のモデル／flagsと局面数・深さの比較は[measurement.md](docs/measurement.md)に記録しています。

中継はGPL-3.0-only、cshogiおよびエンジンはGPL-3.0系です。`container/LICENSE`が本文です。Worker部分と評価関数の利用条件とは別です。イメージを第三者へ配布する場合はソース提供を含むGPLおよび評価関数の条件を別途確認してください。既存の別アプリのコードは参照・コピーしていません。

### 実エンジンスモークとWorker起動

```sh
docker build --platform linux/amd64 -t kifumate-analysis:local container
docker run -d --rm --name kifumate-smoke --cpus=2 --memory=2g \
  -p 127.0.0.1:18080:8080 kifumate-analysis:local
curl -fsS --retry 5 --retry-all-errors --retry-delay 1 http://127.0.0.1:18080/health
python3 scripts/measure.py --direct --url http://127.0.0.1:18080 --plies 6
docker stop -t 3 kifumate-smoke
npm run dev
```

中継は外部に直接公開しません。ローカルのポートも上記のようにloopbackへ限定してください。テストの`measure.py`は`mock/data/sample-game.json`から指し手だけを抽出します。

CPU確認・探索量比較には、HTTP非公開の`container/benchmark.py`を同じイメージ内で実行します。`--cpu-only`でモデル・flags・自動選択結果、`--sfen '<局面>' --modes std`で互換版/AVX2版の3反復中央値を出力します。各探索は新規プロセス・空ハッシュで、バイナリの順序を反復ごとに入れ替えます。ローカルは`docker run --rm --cpus=1 ... python /app/benchmark.py ...`、精密は2 CPUです。stagingでは公式のContainer実行APIを使用してください。

今回のWrangler SSHは稼働中でもWebSocket 400となったため、一時的なsecret保護・staging限定入口から`ctx.container.exec(['python', '/app/benchmark.py', ...])`で比較しました。任意コマンドは受け付けず、固定ベンチだけを実行しました。比較中だけ停止猶予を90秒へ延長し、終了後に入口・RPC・secretを削除して10秒へ戻しました。診断用HTTP APIは残していません。

## stagingデプロイ・実測

対象は`kifumate-analysis-staging`のみです。既存の別アプリやWorkersプランを変更しません。

```sh
npx wrangler whoami
# 認証がなければここで停止。対話ログインは自動実行しない。
npm run deploy
```

開発有料権利は`ENVIRONMENT=local/staging`かつ`ALLOW_DEV_PAID=true`のときに限り、secret `DEV_PAID_HASHES`（端末トークンのSHA-256、カンマ区切り）で許可します。Workerが最新secretを判定し、内部ヘッダーを必ず上書きします。productionではこの代替手段は無効です。

```sh
URL=https://kifumate-analysis-staging.yuki-nakano-1020.workers.dev
HASH=$(python3 scripts/measure.py --url "$URL" --register)
printf '%s\n' "$HASH" | npx wrangler secret put DEV_PAID_HASHES --env staging
python3 scripts/measure.py --url "$URL"   # 85手、両モード
# 必要に応じ --modes precise / --plies 6 / --token-file .local/another-device.json
npx wrangler secret delete DEV_PAID_HASHES --env staging

# 分岐中の解析（新規の計測端末を有料にした後で実行）
HASH=$(python3 scripts/measure.py --url "$URL" --register --token-file .local/realtime-device.json)
printf '%s\n' "$HASH" | npx wrangler secret put DEV_PAID_HASHES --env staging
python3 scripts/measure_realtime.py --url "$URL"
npx wrangler secret delete DEV_PAID_HASHES --env staging
```

`.local/`の端末ファイルは権限0600で作られ、gitignoreされています。繰り返しの計測で既存ジョブを再利用すると時間を測れないため、スクリプトは重複時に止まります。新しい端末ファイルか異なる手数を選んでください。

計測後は`wrangler containers instances <アプリID> --env staging --json`で**inactive**、`containers info`で**active=0 / assigned=0**を確認してください。準備済み容量の`healthy / starting`とは区別します。実測値・費用式・作成資源一覧は[measurement.md](docs/measurement.md)にあります。

## 公開前に必要なこと

- `shortcut:`：App Attest / Play Integrity、入口の発行・利用レート制限は未実装。匿名トークンを作り直す不正利用は防げません。staging検証用であり、そのまま一般公開しません。
- ストア購入権利検証と端末移行・購入復元の設計。開発許可リストは本番の課金判定ではありません。
- 多利用者の負荷試験とプール枠／`max_instances`の調整。混雑時の45秒タイムアウト・最大5回再試行は最終的に失敗となり、枠を返却します。
- Cloudflareの`default` scheduling policyは現在非推奨ですが、今回は要求された`@cloudflare/containers`・`max_instances`による小さなstagingを採用しました。将来の`durable_object` policy移行は別作業です。
- アプリ本体、RevenueCat連携は今回の範囲外です。分岐用プールの多利用者負荷・請求メーターとの突合は公開前に別途必要です。
