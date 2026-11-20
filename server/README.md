# 解析サーバー（開発者向け）

全局解析・分岐中の解析・AIコーチに加え、Issue [#24](https://github.com/phni3j9a/kifumate/issues/24) の招待権利・レート制限・本番構成を実装しています。アプリ画面・ストア説明・APIにはエンジン／評価関数の固有名を渡しません。この文書の固有名は、開発・ライセンス・入手手順のための記録です。

## 構成と仕様

- TypeScript Worker：匿名端末トークンを発行し、SHA-256から利用者別DOを特定。トークン原文・対局者名は保存しません。
- `Device`：SQLite-backed DO。`jobs`・`results`・`usage`・`meta`を保存し、alarmが1局面ずつ進めます。クライアントの接続維持は不要です。
- `Invitations`：環境ごとに一つのSQLite DO。招待コードのハッシュ・期限・取消・端末枠と、短期の入力試行数を一元管理します。
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
- `sleepAfter = '10s'`。PythonはPID 1でもSIGTERMを処理して終了します。staging・productionの`max_instances`は各モード2です。

## API

全応答はJSON、`Cache-Control: no-store`。端末発行以外は`Authorization: Bearer <token>`が必要です。HTTPSで呼び出してください。

| API | 内容 |
| --- | --- |
| `POST /v1/devices` | **空の本文**で発行。201 `{ "token": "64文字のランダムhex" }`。安全な端末ストレージに保存 |
| `GET /v1/entitlements` | 現在の権利。招待のAPI契約は次節 |
| `POST /v1/invitations/redeem` | 招待コードを端末へ登録。次節参照 |
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

## 招待コード・権利（アプリ契約）

同じ端末トークンのまま、`POST /v1/invitations/redeem` に `Content-Type: application/json` と **`{"code":"ABCD-EFGH-JKMN-PQRS"}`**（Crockford Base32の16文字を4文字ずつ区切ったコード）を送ります（本文最大1 KiB・追加キー不可）。成功200：

```json
{"paid":true,"source":"invite","expiresAt":null}
```

`GET /v1/entitlements` も同じ形式です。期限付きコードの`expiresAt`はUnixミリ秒、無期限はnull。権利なしは`{"paid":false,"source":null,"expiresAt":null}`。stagingの開発許可リスト経由だけ`source:"development"`です。`GET /v1/quota`など既存の`paid`も連動します。アプリは入力成功後と起動・復帰時に権利を取得し、権利を永続的な購入済みフラグとして固定しないでください。入力コードを解析ログ・クラッシュログへ送らないでください。

| HTTP / error | 扱い |
| --- | --- |
| 400 `invalid_input` | 正規化後の形式・追加キー不正（Crockford Base32の16文字が必要） |
| 400 `invite_invalid` | 不存在・期限切れ・取消を統一。コードを再確認する |
| 409 `invite_full` | 他の端末で上限到達。発行者へ相談する |
| 401 `unauthorized` | 端末未登録／トークン不正 |
| 413 / 415 | 本文上限／JSON以外 |
| 429 `rate_limited` | 入口の公式レート制限。`Retry-After: 60`秒以上待つ |
| 429 `invite_rate_limited` | 全拠点共有の総当たり制限。`Retry-After: 900`秒以上待つ |
| 503 `rate_limit_unavailable` | 制限の設定漏れ。再試行を連打しない |

- コードは暗号学的乱数によるCrockford Base32の16文字（80ビット）、表示は`XXXX-XXXX-XXXX-XXXX`です。入力はNFKCで全角英数字を半角化し、大文字へ統一、ハイフン類・空白を除去して`O→0`・`I/L→1`を読み替えます。正規化後の16文字のSHA-256だけを保存し、原文は処理中だけ使って保存・ログ出力しません。旧64桁形式は受け付けません（端末トークン・管理鍵・取消用ハッシュの形式は変更なし）。
- 80ビットは約1.2×10²⁴通りで、既存の端末5回・IP20回／15分の厳密な試行制限と組み合わせれば、知人向けの招待配布で総当たりによる推測は現実的ではありません。
- 1コードにつき1〜100端末。期限・取消はコード全体に適用します。同じ端末の再入力は枠を消費しません。使用済み枠は取消・期限後も戻さず、端末交換時は別コードを発行します。複数コードを入力した端末はどれか一つが有効なら有料です。
- 全局解析は本文受信後、分岐は本文受信後の開始確定前、AIコーチは本文／署名検査後・実行前・成功確定前にもDOの最新権利を確認します。取消・期限は次のAPIで反映。稼働中の分岐は次の分岐API、遅くとも無操作30秒で停止します。受理済みの全局解析・保存済みの結果閲覧は取り消しません。
- 将来のRevenueCat連携は`Invitations.entitlement`に代わる照会を`Device.refreshEntitlement`と分岐側の再確認へ接続し、同期の`paid()`を入口にします。回数集計・署名・Pythonは独立です。招待権利は購入復元や端末バックアップとは別で、トークン再発行先へ自動移行しません。

### 管理スクリプト（コード原文を表示しない）

`server/`から実行します。管理APIは`INVITE_ADMIN_KEY`専用のBearer認証、端末トークンでは呼べません。発行はハッシュ・上限・期限だけのPOST、取消はハッシュのDELETEです。管理鍵ファイルは0600、コード出力先はgit管理外の`.local/`だけに制限します。**`set -x`・コードのコマンド引数・`cat`・git追加は禁止**。原文ファイルは安全な経路で対象者へ配布し、不要になれば削除してください。管理鍵は安全にバックアップしてください。

```sh
# staging初回だけ。secret listでINVITE_ADMIN_KEYが既存なら上書きせず既存の鍵ファイルを使う。
npx wrangler secret list --env staging
umask 077
mkdir -p .local
# 既存ファイルは上書きしない
(set -C; openssl rand -hex 32 > .local/invite-admin-staging.key)
npx wrangler secret put INVITE_ADMIN_KEY --env staging < .local/invite-admin-staging.key

node scripts/invitations.mjs issue --env staging --max-devices 3 \
  --expires-at 2027-01-01T00:00:00+09:00 --out .local/friends.txt
# 無期限なら --expires-at を省略。期限はISO 8601でタイムゾーンも明示する。
HASH=$(node -p "JSON.parse(require('fs').readFileSync('.local/friends.txt.json','utf8')).hash")
node scripts/invitations.mjs revoke --env staging --hash "$HASH"
# productionは --env production と --key-file "$HOME/.config/kifumate/invite-admin-production.key" を指定（後述）
```

コード原文は指定ファイル、ハッシュ・上限・期限は隣の`.json`へ0600・上書き不可で保存します。応答消失・途中失敗でも`.json`のハッシュで取消できます。管理鍵の保管先を変える場合は`--key-file <0600のファイル>`を指定してください。発行し直しても既存ハッシュの取消は復活しません。

## レート制限と費用の見張り

2026-11-17に[Cloudflare公式Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)を確認し、Wranglerの`ratelimits`を採用しました。環境ごとに別namespace IDです。いずれも拒否は429、本文や提供元呼び出しより前に制限します。

| 対象 | キー | 設定 |
| --- | --- | --- |
| 端末発行・管理API | IPのSHA-256＋用途 | 10回/60秒（用途ごと） |
| 全ての端末API（GET/DELETE含む） | 端末ハッシュ | 合計300回/60秒 |
| POST/PUT等 | 端末ハッシュ＋API種別 | 60回/60秒 |
| 招待入力 | 端末ハッシュ／IPのSHA-256（別々） | 各5回/60秒 |
| 招待入力の厳密な追加制限 | DO内で端末／IPごと | 5回／20回/15分 |

公式bindingは**拠点ごとの近似カウンター**で、同期前のバーストや複数拠点では設定値を超え得ます。請求の厳密な上限ではありません。招待の追加制限は単一DOのトランザクションで全拠点共有、形式不正や成功も数えます。窓は最初の試行から15分、古い試行行は次の試行時に削除。端末とIPはハッシュだけを保持します。IP共有のモバイル回線では他人の試行も含むので、正当な入力が拒否された場合も連打せず待ってください。端末の実在性検証は別課題です。

**今回作った見張り**：Workers Logsを全件有効化し、`api`（種別・method・status）、`api_rejected`（status・公開エラー）、`device_created`、`analysis_completed`（mode）、`coach_completed / coach_failed / coach_provider_failed / coach_responses_tools`（公開エラー・固定の発生箇所・例外種別・提供元HTTPステータス・所要時間・道具呼び出し数・ターン数）だけの構造化ログを残します。自動のinvocationログは無効にし、ヘッダー・本文・コード・キー・IP・トークン・人名を記録しません。完了イベントはクライアントが画面を離れていてもDOから出るため、利用回数の異常を追えます。

診断は`npx wrangler tail --env staging`（本番は`production`）で構造化consoleログを確認します。**tailの出力を共有・記録しないでください。** 自動メタデータにはリクエスト情報が含まれるため、報告には上記の固定診断フィールドだけを必要最小限で転記します。secretが表示された場合は閲覧だけでも漏えいとして扱い、原因の修正後に該当secretを差し替え、提供元キーは旧キーも失効させます（後述）。旧版の`X-Coach-Config`はsecretを内部ヘッダーに含めていたため撤去しました。現在はDO自身のenvから読み、設定一式をヘッダー・本文・ログへシリアライズしません。独自診断も例外のmessage・stack・任意のname、提供元本文・入力・キーを出しません。処理完了時に期限タイマーを解除し、ログや処理終了を期限まで引き延ばしません。

- 配布開始後は毎日、Cloudflare Dashboard → 対象Worker → Observabilityで`coach_completed`・`coach_failed`・`analysis_completed`の件数と429/5xx、端末発行数を前日と比較してください。最初の見直し目安は**AIコーチ成功100件/日、全局解析200局/日、端末発行30台/日、提供元失敗10件/日**。少人数向けの警戒値で、サーバーがこの値で自動停止するものではありません。
- 月の端末別上限（全局週10/100局、精密20局、分岐月300分、コーチ月100回）・最大6コンテナ・無操作停止・コーチ全体240秒・道具30回の上限で増加を抑えます。失敗でも提供元費用は発生し得るので、成功数だけでなく失敗数とLLM提供元の使用量・Cloudflare Billingも確認します。費用式は[measurement.md](docs/measurement.md)。
- 異常時は該当招待を取り消し、新規配布を止めます。LLMを緊急停止する場合は`npx wrangler secret delete COACH_API_KEY --env production`（新規要求が503、既に送信済みの要求は止まりません）。全Workerを止める判断は影響を確認してMain／利用者が行います。
- 自動の課金通知・厳密な月額USD上限・全体の自動遮断は未実装です。通知のための外部サービス追加やアカウント全体設定変更はせず、まず構造化ログ＋既存の利用上限で運用します。

## 分岐中の解析（有料限定）

### API・アプリ側の接続方法

全局解析と同じ端末トークン・招待権利（stagingでは開発許可リストも）を使います。全局解析の回数とは独立しています。

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
- 分岐専用の`RealtimeContainer`を2枠追加。全局解析のコンテナとは共有しません。端末DOのIDから固定枠を選び、その枠を一端末へ排他的に貸与します。別端末が使用中なら409 `realtime_busy`で即時拒否し、その端末の時間は減りません。別枠への待ち行列・移動はありません。`shortcut:` 同時利用2枠・ハッシュ衝突で空き枠があっても拒否する構成です。少人数配布でも混雑を観測し、枠数・振り分けを更新してください。
- 局面更新は旧HTTP要求を破棄し、中継は新しい要求を**USIロック取得前**に登録して旧探索に`stop`を送ります。旧bestmoveを読み切ってから新局面へ移り、遅延結果はsessionId・sequenceで破棄します。初回の共通起動は局面変更ではやり直しません。
- `REALTIME_IDLE_MS`の既定は`30000`（許容1000〜300000ms、不正値は既定へ）。**最後に受理したPOST/PUT**から測ります。探索完了・ポーリング・通信接続は期限を延長しません。永続alarmで休止・上限停止を行い、明示停止はコンテナをdestroyします。停止失敗時は枠と集計を保持し1秒後に再試行します。
- 数えるのは**コンテナ起動要求から停止完了までの壁時計時間**。準備・探索・結果が出た後の待機・停止処理を含み、局面数やCPU使用時間では数えません。初回要求／手動起動から料金が始まる[公式の説明](https://developers.cloudflare.com/containers/platform/pricing/)に合わせたサーバー時計による集計で、Cloudflare請求メーターとの完全一致を保証するものではありません。
- 月300分（18,000,000ms）、**JST月初0時**で区切ります。月をまたぐ稼働は両月へ分割。残り時間までのalarmを設定し、使い切ると停止します。利用上限値で集計を丸めるため、alarmの遅延や停止処理の端数を超過請求しません。翌月に勝手に再起動はせず、次の局面更新で再開します。
- `quota.low`がtrue（残り10%未満）のときだけ残りを知らせ、それ以外では上限・残りを画面に出さないでください。停止・失敗したセッションも実際の稼働時間は返却しません。全局解析の失敗時の回数返却とは別です。
- 利用量と最新セッションは分岐用Container DOのSQLiteへ永続化し、DOの再生成でも集計を継続。停止済みの結果は最終操作から7日後のアクセス時に削除し、月利用量は当月・前月を保持します。月上限になったセッションID・sequenceだけは翌月の再開用に最大40日保持します。次のセッションで上書きされるため、必要な分岐結果は端末に保存してください。
- 内部の権利・端末ヘッダーはDeviceが必ず上書きします。本文待機中の別要求での権利更新に加え、開始確定前にも招待DOを再照会します。POST/PUTの再照会で失効が分かった場合も、所有中の稼働を停止してから403を返します。稼働中の取消の能動通知は未実装（次の分岐APIか無操作休止で停止）です。

## AIコーチ（有料限定）

### アプリとの契約

全局解析と同じ匿名端末認証を使います。精密解析の**完了時**に `COACH_SIGNING_KEY` で棋譜・全結果・端末・ジョブ・期限をHMAC-SHA256署名し、既存ジョブ応答に `coachProof` を追加します。通常解析・未完了・署名鍵未設定では `null`。その他のフィールドや差分取得は変更しません。差分GETにも全体の同じ証明が付くので、アプリは全 `results` を `ply` 順に集め、`initial / moves / mode / results / coachProof` を端末へ保存してください。

証明は**発行から365日**有効。7日後にサーバーの解析結果が消えても利用できます。期限後は精密解析をやり直します。署名前の旧結果に証明を後付けしません。端末トークンを再発行・別端末へ移した結果はこの端末の証明では使えません。鍵を変更すると発行済み証明も無効になるため、永続secretとして保管してください。鍵ローテーション・購入復元と端末移行の扱いは公開前の別課題です。

| API | 内容 |
| --- | --- |
| `GET /v1/coach` | `{paid, quota, latest}`。latestは最新要求の取得応答、なければnull。POST応答消失時にもIDを回収 |
| `POST /v1/coach` | **推奨：`Prefer: respond-async` ヘッダー**で依頼し202。ヘッダーなしは従来どおり200まで待機 |
| `GET /v1/coach/:requestId` | 状態と検査済み結果を再取得。読み直しでは回数を加算しない。有料権利失効後も取得可能 |
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
- **アプリが履歴・解説・プロフィールの長期保存を担当**します。非同期実行のため入力を受理から実行期限までSQLiteへ一時保存し、成功・失敗・中止時に削除します。検査済み応答は完了から7日保存（端末トークンで保護）、以後削除。月使用数と要求ID・状態は当月・前月程度保持します。毎回署名を照合し、会話セッションは作りません。
- `requestId` は新規の解説／質問ごとのUUID。送信前に端末へ棋譜との対応を保存してください。同じIDの再POSTは409 `request_exists`で二重課金しません。応答を失ったら**同じIDのGET**（IDも失ったらGET一覧のlatest）で回収し、無条件に新しいIDで再送しないでください。
- 中止はHTTPのabortだけに頼らず**同じIDのDELETE**を送ります。本文受信より先のDELETEも墓標として保存し、遅延POSTを止めます。成功確定と中止が競合した場合は先に確定した状態を返します。DELETE自体が届かなかった場合、サーバーでは成功として数える可能性があります。

非同期の202・取得GETは次の形です（本文の契約は同期200と共通）：

```json
{"requestId":"...","status":"pending","expiresAt":1793459040000,"error":null,"quota":{}}
```

`status`は`pending / completed / failed / cancelled`。completedだけに`sections`が付きます。失敗理由は`error`（例：`coach_timeout / invalid_output / paid_required`）。時刻はUnixミリ秒、pendingのexpiresAtは実行期限、終了後は保存期限です。未知IDは404、結果保存期限後は410 `result_expired`。入力形式・署名・回数エラーはPOST時に従来のHTTPコードで返し、受理後の提供元エラーはGETのfailedで返します。

アプリは**前面で待つ間だけ2〜5秒間隔でGET**し、画面を離れる／バックグラウンドへ移るとGETだけを停止します。DELETEは送りません。復帰・再起動時に保存したIDで取得し、completedなら端末に保存してください。新規解説・質問の送信中は同時に別の質問を作りません。明示的な中止だけDELETEを使います。期限切れや失敗後の再生成は、利用者の操作で新しいUUIDを使います。

200同期応答例：

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

本文は**プレーンテキスト**で表示し、HTMLとして解釈しないでください。`facts` は解析根拠とそれに基づく解釈、`advice` は個別の学習助言です。参照の `ply` はその局面までに指した手数、`pv` はそこからの読み筋です。`position` は局面評価、`candidate:rank` は候補、`mate` だけが証明済み詰み（`provenMate:true`）です。数値は先手視点。盤面リンク・再生できる読み筋・評価値は `references` から描画します。

### アプリ側に必要な処理

- **送信前の人名の伏せ字**：アプリが持つ登録名と棋譜内の対局者名を使い、自由文中の該当する名前を伏せ字（「あなた」「相手」など）にしてください。学習プロフィール・質問だけでなく、再送する履歴の利用者／AI双方の本文にも適用します。この処理はアプリ側で実装する必要があります。名前の一覧自体はサーバーへ送らず、APIに名前の欄も追加しません。
- サーバーは人名を推測して検出しません。LLMへの指示では引き続き「あなた」「相手」（観戦では「先手」「後手」）と呼ばせますが、人名の出力検出は行いません。

**非ストリーミング＋永続alarm**：入力と予約を保存して202を返し、DOのalarmで実行します。クライアントのHTTP接続に寿命を結びつけず、未検査の文は公開しません。待機中は「解説を作っています。画面を離れても続きます」と案内できます。従来クライアントの同期POSTだけはHTTP中止で取り消します。

[Cloudflare公式のDO制限](https://developers.cloudflare.com/durable-objects/platform/limits/#wall-time-limits-by-invocation-type)を2026-11-17に確認：alarmの壁時計上限は**15分**、既定CPUは**30秒**（ネットワーク・ストレージ待機はCPUに含まない）。[waitUntil](https://developers.cloudflare.com/workers/platform/limits/#duration)は応答／切断後30秒までで、この用途には足りません。コーチの最大期限10分はalarm上限内です。同期・非同期とも、入力保存前に永続alarmを予約します（同期は実行期限のwatchdog、非同期は開始用alarmを予約して実行前に期限のwatchdogを設定）。外部API送信前に実行開始を永続化し、alarm再配送やDO再生成で**同じ要求を提供元に再送しません**。実行途中の基盤障害は結果を失う場合がありますが、期限で予約を返しfailedにします。提供元への費用が既に発生している可能性はあります。

### 回数・安全策

- 月100回（`COACH_MONTHLY_LIMIT`、1〜10000。不正値は100）。**JST月初0時**でリセット。解説も追加質問も成功ごとに一回。受理月へ予約し、検査済み応答の確定時にその月だけへ加算します。月またぎでも二重集計しません。
- 端末ごとに同時一件。予約中を除いた `remaining` と `reserved` を返します。失敗・明示中止・タイムアウトは加算しません。DO再生成で処理を失った予約も永続期限後に返却されます。`low` がtrue（残り10%未満）のときだけ残りを案内し、残り0では `resetsAt` を案内します。
- 本文は実測1 MiB、棋譜512手、学習戦法10個×40文字、目標500文字、質問1000文字、履歴20件×4000文字。既存解析APIの16 KiB上限は変更しません。
- `COACH_TIMEOUT_MS` 既定240000ms（1〜600000、受理から日本語化・道具実行・生成・検査までの全体）。期限間近では道具を打ち切って最終回答を求めます。提供元へのリダイレクトは拒否。入力・応答・道具引数・APIキーはログに出しません。
- 本文／署名検査後・生成前・成功確定前に最新招待権利を確認します。提供元・署名鍵・上限はDO自身のenvを直接参照し、内部リクエストやグローバル変数へ設定をコピーしません。開発用課金判定は本番で無効です。更新時の版の切替と猶予は下記を参照してください。
- LLMにはエンジン名・評価関数名・対局者名フィールドを渡しません。入力自由文と出力からUnicodeの書式文字（一般カテゴリ`Cf`）と既定で不可視の文字（`Default_Ignorable_Code_Point`、ゼロ幅文字等）を共通処理で除去し、NFKC正規化して既知の禁止製品名（エンジン・評価関数・他社サービス等）だけを照合します。LLMへ送る本文とアプリへ返す本文も不可視文字を除去したものです。禁止製品名を含む出力は502にして課金しません。**未知の製品名や全ての意味の正確さまでは判定しません**。日本語事実と参照を照合し、明示的な勝敗・有利側・駒と指した側・詰まされる側・宣言側・観戦の呼称の矛盾を拒否します。参照局面で確認できる駒の持ち主・位置と、符号に添えた明示的な移動方向も照合します。正しい回答の過剰拒否を避けるため、否定・仮定・目的を含む文は許可し、主語ごとに確かな断定形だけを検査します。省略・比喩・複数局面をまとめた曖昧な説明まで完全に検証できず、実モデル評価が必要です。
- `facts` の見出しと本文では対局の範囲内の手数と、提示した実戦手・候補PV・詰みPVにあるKIF符号を使えます。`advice` では一般的な練習のための着手案も示せます。「35手目 ▲2四歩」のように並べて書いた場合は実戦手との組を照合します。移動元の括弧と「打」の省略は表記差として扱います。それ以外の資料外の符号は `facts` では拒否します。資料外の参照ID、生USI、符号付き評価値はどちらの節でも拒否します。一般知識に基づく狙いや駒の働きの解釈は、盤上で起きた事実と区別します。未解析分岐の評価は作りません（分岐中の解析とは独立）。

主なエラー：400 `invalid_proof / precise_required / invalid_input / unsafe_names`、403 `paid_required`、409 `coach_busy / request_exists / cancelled`、413、415、429 `monthly_limit`、502 `provider_failed / invalid_output`、503 `provider_unavailable / signing_unavailable`、504 `coach_timeout`。コーチのエラー応答には `quota` も付きます。

### 設定と提供元

| 設定 | staging・production（このブランチ） | `openai-compatible`（未指定時・切り戻し） |
| --- | --- | --- |
| `COACH_PROVIDER` | `openai-responses-tools` | `openai-compatible` |
| `COACH_BASE_URL` | `https://api.openai.com/v1` | `https://api.deepseek.com` |
| `COACH_MODEL` | `gpt-6.1-terra` | `deepseek-flash` |
| 推論 | `COACH_REASONING_EFFORT=high`（`reasoning.effort`） | `reasoning_effort:max` 固定 |
| `COACH_MAX_TOKENS` | `5400`（`max_output_tokens`、調査ターンは最大4200） | `32768`（`COACH_TOKEN_PARAMETER`は`max_tokens`、または`max_completion_tokens`） |
| `COACH_TIMEOUT_MS` | `240000` | `240000` |

トークン設定は推論を含む**ターンごとの**出力上限（設定範囲1〜65536）。Responses方式では各応答を2 MiB、再送するリクエストを1 MiBまでに制限します。一括方式の応答は従来どおり1 MiBまで。キー未設定は503。**モデル変更と無関係に署名鍵は維持**してください。

道具方式は最初に視点・終局・要所の見出しと参照・プロフィール・重点・詳しさ・質問だけを渡し、履歴は従来どおり会話ロールではなく参考データに入れます。盤面、指し手、保存済み候補、知識はモデルが必要なときに照会します。下書き点検はWorkerで行い、他の道具は同じターンの分をまとめて、`/coach-facts` と同じ精密slotの内部 `/coach-tools` へ送ります。戦法と囲いは既存のアプリ分類器で判定します。探索エンジンは起動せず、詰み確認はcshogiで最大1万ノード・深さ15・呼び出しあたり0.75秒、バッチの調査枠は3秒です。

[OpenAIの公式手順](https://developers.openai.com/api/docs/guides/reasoning#preserve-reasoning-without-stored-responses)に沿って `store:false` と `include:["reasoning.encrypted_content"]` を送り、元の入力、応答の順序を保った項目列、呼び出しIDつきの結果を次のターンへ再送します。`previous_response_id` は使いません。道具は最大30回で、その後は `tool_choice:none` を指定します。最後は従来の `validateOutput` で判定し、仮の読み筋は内部照合にのみ使い、アプリに返す `references` は署名済みの参照のままです。`openai-compatible` は [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) の一括方式のままです。

`container/coach_facts.py` は本譜全体を簡潔な一覧にし、要所ごとに指す前の局面（側別の玉・盤上の駒・持駒）、形勢の前後、実戦の続き最大3手、実戦とは別の仮の読み筋（推奨手・応手、候補1位の冒頭5手）を付けます。本譜と読み筋には指した側から見た移動方向を付けます。応手の読み筋は双方の捕獲・王手・成りを集計します。要所は損失の大きい悪手・疑問手（自分5手、相手2手、観戦は先後各3手まで）に、質問の「N手目」、詰みの見逃し、形勢逆転の代表を加えます。推奨手と実戦手が同じ場合は代案を出しません。cshogiの省略字（杏・圭・全）は成香・成桂・成銀に補完します。形勢は絶対値150未満を互角、500未満をやや有利、1500未満を有利、3000未満を大きく有利、それ以上を勝勢とし、後手視点の不利も反転します。印は指した側の損失200以上を疑問手、500以上を悪手とする目安で、境界値や詰みスコアを数値比較しません。

盤面の詰みは勝者・敗者・終局理由を確定できますが、**既存の署名入力には投了・実際の宣言などの終局記録がありません**。その場合は勝敗・終局理由を不明とし、宣言可能という探索結果から実戦の宣言勝ちを作りません。**サーバーが解析から作る事実**には生USI・SFEN・符号付き評価を含めず、日本語化してLLMへ渡します。利用者が質問・プロフィール・履歴に書いた数値（「評価が＋600なのはなぜ？」など）は、全角・半角や符号を変えずに保持します。これは解析で確認した事実ではなく参考文です。入力自由文のUSI伏字は従来どおりです。アプリへ返す署名済み`references`のUSI・評価は従来どおりです。

提供元への送信はWorkersが対応する`redirect:manual`で行い、3xxも失敗として拒否します（キーを転送先へ送信しません）。送信前・HTTP応答・読取・出力形式の失敗と、事実生成／出力検査の失敗を別の発生箇所として記録します。

再比較の誤り・偽陽性・速度・費用は[検証記録](docs/ai-coach.md)、Issue #28の実環境確認は[production.md](docs/production.md)を参照してください。`COACH_PROVIDER=fake`は**local/stagingのみ**許可し、productionでは503で拒否します。

## ローカル開発

npm・解析コンテナのPython依存の監査結果は[依存ライブラリの脆弱性精査](docs/dependency-audit.md)を参照してください。Workerはアプリの将棋分類器を再利用するため、テスト・型検査・ビルド前に `npm ci --prefix ../app` も実行してください。

必要：Node.js 22以降、Python 3.12、Docker（linux/amd64）。ホストへのsudo操作は不要です。Dockerfileのapt操作はビルドコンテナ内だけです。

```sh
cd server
npm ci
python3 -m venv container/.venv
container/.venv/bin/pip install -r container/requirements.txt pytest==9.0.2
npm test                  # Workersランタイム・SQLite DO・公式レート制限、偽の中継
npm run test:python       # 偽USIプロセス・合法手・評価正規化・詰み
npm run typecheck
node scripts/test_invitations.mjs
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

過去のWrangler SSHは稼働中でもWebSocket 400となったため、一時的なsecret保護・staging限定入口から固定ベンチだけを実行しました。終了後に入口・RPC・secretを削除し、停止猶予を10秒へ戻しています。診断用HTTP APIは残していません。

## stagingデプロイ・検証

対象は`kifumate-analysis-staging`のみ。既存の別アプリやWorkersプランを変更しません。他の担当が使う`DEV_PAID_HASHES`など、**値を読み出せない既存secretは上書き・削除しない**でください。既存の`COACH_SIGNING_KEY`も保持します。

```sh
cd server
npx wrangler whoami
# 認証がなければ停止。対話ログインは自動実行しない。
npx wrangler secret list --env staging
npm run deploy
# 初回だけ前述の手順でINVITE_ADMIN_KEYを追加。既存なら追加しない。
node scripts/smoke_invitations.mjs
```

スモークはstagingだけに招待を一つ発行し、成功・端末枠・取消反映、公式の招待入力／端末API／発行制限、65秒後も残るDOの15分制限を確認します。**finallyで確認コードを取り消し、コンテナは起動しません**。原文と取消用メタデータは`.local/`へ0600保存。IPの15分窓を消費するため連続再実行せず、15分以上空けてください。公式bindingは近似なので瞬間並列バーストだけで判定せず、端末APIを短い間隔で直列に呼びます。

開発有料権利は`ENVIRONMENT=local/staging`かつ`ALLOW_DEV_PAID=true`のときだけ、secret `DEV_PAID_HASHES`（端末トークンのSHA-256、カンマ区切り）で許可します。Workerがenvで判定し、許可／不許可の真偽値だけを内部ヘッダーへ渡します。productionではフラグやsecretを誤って設定してもこの代替手段は無効です。通常の計測も招待を使えば共有secretを変更せずに行えます。

計測後は全三つのContainer applicationで次を確認します（対象IDは`npx wrangler containers list --env staging`で確認）。`healthy / starting`は準備済み容量で、利用者の実行中とは区別してください。

```sh
for ID in a03ecee6-a1f4-495c-ad64-4546064e7741 a03e09ba-f20f-4f24-848d-02b62c4ca73d a03b91a4-eb91-461d-ad69-219e5f5139e6; do
  npx wrangler containers instances "$ID" --env staging --json  # 使用slotはinactive
  npx wrangler containers info "$ID" --env staging             # active=0 / assigned=0
 done
```

最新の確認結果は[production.md](docs/production.md)、解析の実測は[measurement.md](docs/measurement.md)、AIコーチの検証は[ai-coach.md](docs/ai-coach.md)を参照。

## productionの準備とデプロイ

本番への反映はユーザー承認後に行います。登録済み環境の更新は「通常の更新・再デプロイ」を使い、初回登録を繰り返さないでください。

- Worker名：`kifumate-analysis-production`。DO namespace・レート制限・Containerはstagingとは別。
- 本番URL：**`https://kifumate-api.quarterlambda.com`**。同じアカウントのactiveなzone `quarterlambda.com` を確認済みです。第1階層のサブドメインで、[Workers Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)としてWranglerがDNSと証明書を構成します。workers.dev・preview URLは無効。既存DNSとの競合は勝手に置換せず停止して確認します。
- ネイティブアプリ専用。CORSヘッダーを付けず、productionで`Origin`付き要求とOPTIONSは403 `browser_forbidden`。これは端末認証の代わりではなく、HTTPクライアントによる偽装を防ぐものではありません。
- **数十人の初期配布でもstd 2・precise 2・realtime 2（合計最大6）を維持**します。全局解析は端末別キューで吸収でき、過去の85手実測はstd52秒／precise96秒程度。2枠ずつなら理想条件で毎分約2.3局／1.3局の目安となり、数十人が一斉に全局解析する前提は置きません。分岐は同時2人まで、ハッシュ衝突では空き枠があっても409です。AIコーチの日本語化は精密枠を共有。最大8 vCPU・40 GiBメモリ・80 GBディスクまでに抑え、常時その数を起動しません。混雑の409・再試行・実測を見て、コードの`% 2`と`max_instances`を必ず一緒に変更します。
- このブランチのvarsは GPT-6.1 Terra / Responses道具方式、推論high・期限240秒です。既存環境からの切り替えは「通常の更新・再デプロイ」を参照してください。偽提供元、`ALLOW_DEV_PAID`・`DEV_PAID_HASHES`による有料化は本番で無効（テストあり）。

必要な**本番専用secret**：

| 名前 | 用途 |
| --- | --- |
| `COACH_SIGNING_KEY` | 新規ランダム32バイト以上。**stagingからコピーしない**。発行済み証明を守るため以後は維持 |
| `INVITE_ADMIN_KEY` | 招待発行・取消用。署名鍵／staging管理鍵とも別の新規乱数 |
| `COACH_API_KEY` | `~/.config/kifumate/llm.env`の`OPENAI_API_KEY`（一括方式なら`DEEPSEEK_API_KEY`） |

### デプロイ前のDNS確認（初回・通常更新共通）

DNS読み取り権限のある経路（Cloudflare Dashboard → `quarterlambda.com` → DNS → Records、DNS readを持つAPIトークン、またはMCP）でDNS一覧を開き、`kifumate-api.quarterlambda.com`を検索します。別用途のA・AAAA・CNAME等がないことを確認し、Workers & Pages → `kifumate-analysis-production` → Settings → Domains & Routesでも、このホストが同WorkerのCustom Domainであることを確認してください。初回は未登録、通常更新では既存の本番Workerへの関連付けだけを許可します。競合・別Workerへの関連付け・確認できない状態ならデプロイせず停止します。Wranglerの現在のOAuth権限ではDNS一覧APIは403になるため、これだけで確認済みとは扱いません。既存の同WorkerへのCustom Domainの紐付けとWranglerの変更内容（`domains/changeset`の競合・追加・削除）も補助として照合しますが、DNS一覧の確認の代わりにはしません。確認のために認証権限を勝手に変更しないでください。

**非TTY（エージェント・CI・出力のリダイレクトを含む）では、Wrangler 4.164.0はCustom Domainの`override_existing_origin`と`override_existing_dns_record`を自動的に有効にし、既存DNSの置換を確認しません。** 対話確認に頼らず、必ず上記の一覧を事前確認してください。これは追加オプションを指定しなくても起きる挙動です（[公式Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)、インストール済みWranglerの`publishCustomDomains`実装で確認）。

### 初回登録の前提確認

以下は`server/`から実行します。上記DNS確認を済ませ、初回の一時secretファイルはまだ作りません。

```sh
npm ci
python3 -m venv container/.venv
container/.venv/bin/pip install -r container/requirements.txt pytest==9.0.2
npm test && npm run typecheck && npm run test:python
node scripts/test_invitations.mjs
npx wrangler whoami
# 本番の既存secretがあれば、読めない値を上書きせずここで停止・確認する。
npx wrangler secret list --env production
# 初回でWorker未作成のエラーなら想定内。認証／権限エラーの場合は停止する。
# ローカルだけの検査（Dockerビルドあり、リモートへのアップロードなし）
npx wrangler deploy --env production --dry-run
```

### 初回登録・実デプロイ（承認後、一度だけ）

**以下のブロック全体をまとめて実行**します。OpenAIキーの原本は`~/.config/kifumate/llm.env`（0600）だけです。デプロイ直前にリポジトリ外の`~/.config/kifumate/production-deploy.XXXXXX/secrets.json`を0600で作り、登録後は削除します。trapにより途中失敗でも一時ファイルを残しません。この初回登録用のファイルには、初回に設定する三つのsecretを含めます。

```sh
(
  set -eu
  set +x
  umask 077
  CONFIG_DIR="$HOME/.config/kifumate"
  mkdir -p "$CONFIG_DIR"
  DEPLOY_DIR=$(mktemp -d "$CONFIG_DIR/production-deploy.XXXXXX")
  trap 'rm -f "$DEPLOY_DIR/secrets.json"; rmdir "$DEPLOY_DIR"' EXIT
  export KIFUMATE_DEPLOY_DIR="$DEPLOY_DIR"
  set -a
  . "$CONFIG_DIR/llm.env"
  set +a
  node --input-type=module <<'JS'
import {randomBytes} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
if (!process.env.OPENAI_API_KEY) throw new Error('OpenAIキーが未設定です');
const secrets = {
  COACH_SIGNING_KEY: randomBytes(32).toString('hex'),
  INVITE_ADMIN_KEY: randomBytes(32).toString('hex'),
  COACH_API_KEY: process.env.OPENAI_API_KEY,
};
writeFileSync(join(process.env.KIFUMATE_DEPLOY_DIR, 'secrets.json'), JSON.stringify(secrets), {mode:0o600, flag:'wx'});
// 管理APIのBearer認証に必要なため、この鍵だけはローカルに保持する。
writeFileSync(join(homedir(), '.config/kifumate/invite-admin-production.key'), secrets.INVITE_ADMIN_KEY+'\n', {mode:0o600, flag:'wx'});
JS
  unset DEEPSEEK_API_KEY OPENAI_API_KEY
  npx wrangler deploy --env production --secrets-file "$DEPLOY_DIR/secrets.json"
  npx wrangler secret list --env production
)
```

- **署名鍵のローカル保存・バックアップはしません。** 初回登録後はCloudflareの`COACH_SIGNING_KEY`だけを維持し、通常のデプロイで再生成・上書きしません。Workerやsecretの削除で失うと既存の証明を復元できないため、削除前には必ず確認してください。
- **管理鍵だけは保持が必要**です。Cloudflareから値を読み出せず、後の招待発行・取消で使うため、`~/.config/kifumate/invite-admin-production.key`（0600）へ保存します。管理スクリプトには`--key-file "$HOME/.config/kifumate/invite-admin-production.key"`を渡します。署名鍵・LLM提供元キーのコピーはこのファイルに入れません。
- 失敗した場合も一時ファイルは削除されます。Cloudflareへ登録済みの可能性があるので**初回ブロックを無条件に再実行しない**でください。既存secretとデプロイ状態を確認し、登録済みなら次節の通常デプロイで再開します。残った管理鍵ファイルも勝手に上書き・削除しません。
- 旧手順で`.local/production-secrets.json`などのコピーを作っていた場合は再利用せず削除し、キーの原本とCloudflareの登録値を正とします。

### 通常の更新・再デプロイ

通常更新はテスト・型検査と「デプロイ前のDNS確認」の後に `npx wrangler deploy --env production`。署名鍵・管理鍵は再生成せず、キーを変えない更新では `--secrets-file` は付けません。

**Terraへの切り替えは承認後、まずstagingで行います。** 新Workerには新コンテナの `/coach-tools` が必要なので、必ず同じ更新でWorkerとコンテナを反映し、コンテナのロールアウト完了とWorker/DOの版切り替えを確認してからAIコーチを試します。ロールアウト中は旧コンテナに届く可能性があるため、利用の少ない時間帯を選びます。`secret put` 単体は即デプロイするため、旧DeepSeek設定へOpenAIキーだけ先行適用しないでください。以下では新しいvars・コードと同じデプロイで **`COACH_API_KEY` のみ**更新します（stagingで確認できたら、承認後 `--env production` に変更）。

```sh
(
  set -eu
  set +x
  umask 077
  deploy_dir=$(mktemp -d)
  trap 'rm -f "$deploy_dir/secrets.json"; rmdir "$deploy_dir"; unset OPENAI_API_KEY DEEPSEEK_API_KEY' EXIT
  set -a; . "$HOME/.config/kifumate/llm.env"; set +a
  node -e 'if (!process.env.OPENAI_API_KEY) throw new Error("OpenAIキーが未設定です"); process.stdout.write(JSON.stringify({COACH_API_KEY: process.env.OPENAI_API_KEY}))' > "$deploy_dir/secrets.json"
  npx wrangler deploy --env staging --secrets-file "$deploy_dir/secrets.json"
)
```

確認は精密解析からコーチを通し、待ち時間・中止・成功時のみの回数加算・使用量を確認します。切り戻す場合は表の一括方式のvars一式と `DEEPSEEK_API_KEY` を同じデプロイに含めます。既存の `COACH_SIGNING_KEY`・`INVITE_ADMIN_KEY` は切り替え前後で維持します。

### envとsecret更新の反映・漏えい時の差し替え

[公式Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)によると、`wrangler secret put/delete`はWorkerの新しい版を作成して即デプロイします。[公式DOコード更新](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/)では、停止中のDOは次回起動時に最新版を使い、実行中のDOは既定で最大300秒まで旧版を継続してからリセットされます。更新直後に全DOが即切替とは扱わず、secret更新後は5分の猶予を置き、新規精密解析・コーチで確認してください。旧版が切り替わるまで旧鍵が有効な場合もあります。

[公式Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/#making-changes-to-bindings)は、bindingだけの更新でWorker isolateが再利用され、グローバルに保存した派生値が古いままになる点も注意しています。この実装では設定の派生コピーを作らず、DOへ与えられるenvを直接参照します。envを同期するためにsecretを内部HTTPヘッダー・本文・ログへ載せる必要はありません。中断を伴う緊急の即時更新が必要な場合だけ、影響を確認して公式の`--durable-objects-code-update-mode immediate`を検討します（通常更新には追加しません）。

内部ヘッダーは認証情報ではありません。Worker→Deviceは`Content-Type`と`Prefer`だけを外部から許可し、`Authorization`や外部指定の内部ヘッダーは転送しません。`X-Dev-Paid`はサーバー判定の真偽値、`X-Invite-IP`はCloudflareが付与する[`CF-Connecting-IP`](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip)のSHA-256です（認証には使わず、招待試行制限用）。Device→Realtimeは`X-Realtime-Owner`を自身のDO ID、`X-Device-Hash`を登録済み端末ハッシュ、`X-Dev-Paid`／`X-Dev-Entitlement`を自身の権利判定で必ず上書きします。DOは公開HTTPエンドポイントではなくbinding経由だけで呼びます。これらは鍵・トークン原文ではなく、値だけでAPI認証や有料化はできません。ただし識別用の仮名値であるため、tailの共有・記録禁止は同じです。

署名鍵が表示された場合は、原因修正のデプロイ後、影響を受けた環境だけで次を実行します。**保存済みの精密解析の証明はすべて無効**になり、再解析が必要です。承認なしに通常更新で実行しないでください。新しい鍵は標準入力で渡し、ファイル・引数・ログへ残しません。

```sh
# 対象環境を確認してから実行。本番は staging を production へ変更する。
(set -eu; set +x; openssl rand -hex 32 | npx wrangler secret put COACH_SIGNING_KEY --env staging)
# 5分の版切替猶予後、新規精密解析で確認する。
```

LLM提供元のキーが表示された場合は、利用者が提供元で新規発行し、`~/.config/kifumate/llm.env`を0600のまま更新します。新しい値をチャット・引数・出力で受け渡しません。影響環境の設定先とキーの提供元を確認し、「通常の更新・再デプロイ」の `COACH_API_KEY` だけの更新手順を適用します。切替後に実LLMを確認し、提供元で旧キーを失効させます。署名鍵と管理鍵は変更しません。

### デプロイ後の確認

```sh
npx wrangler secret list --env production
curl --fail --silent --show-error -X POST https://kifumate-api.quarterlambda.com/v1/devices -o /dev/null
# ブラウザ経由が403、Access-Control-Allow-Originがないこと
curl --silent --show-error -i -X OPTIONS https://kifumate-api.quarterlambda.com/v1/devices \
  -H 'Origin: https://example.com'
```

初回は少数の期限付き招待から配布し、`GET /v1/entitlements`・AIコーチの実提供元・ログ・CloudflareとLLM提供元の使用量を確認してください。確認用コードは取消し、Containerがinactive・active=0/assigned=0になったことを確認してから終了します。実施済みのデプロイ・実LLM確認の結果は[production.md](docs/production.md)を参照してください。

## 一般公開前に必要なこと

- `shortcut:` App Attest / Play Integrityは未実装。匿名トークンの再発行・IP変更による無料枠の回避を完全には防げません。今回は知人向けの少人数配布で、一般公開の安全性を保証しません。
- ストア購入権利検証と端末移行・購入復元の設計。招待はRevenueCatの購入状態とは別です。
- 多利用者の負荷試験とプール枠／`max_instances`の調整。混雑時の45秒タイムアウト・最大5回再試行は最終的に失敗となり、枠を返却します。
- Cloudflareの`default` scheduling policyは現在非推奨ですが、既存の固定プールを維持しました。将来の`durable_object` policy移行は別作業です。
- アプリ本体、RevenueCat連携、能動的な失効通知、全体予算の自動停止、請求メーターとの突合は範囲外です。
