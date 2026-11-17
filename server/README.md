# 解析サーバー（開発者向け）

Issue [#2](https://github.com/phni3j9a/kifumate/issues/2) の全局解析を実装しています。アプリ画面・ストア説明・APIにはエンジン／評価関数の固有名を渡しません。この文書の固有名は、開発・ライセンス・入手手順のための記録です。

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
- 候補がない終局では`candidates: []`。非詰みの終局で探索値がなければ`score: null`です。

主なエラー：400（入力・カーソル）、401（端末未登録／認証）、403（精密に有料権利が必要）、404、413（本文過大）、415（JSON必須）、429（週上限、`quota.resetsAt`付き）。内部の例外やUSIの`id`・`info string`はAPIに返しません。

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

[Cloudflare公式の対応イメージ](https://developers.cloudflare.com/containers/get-started/#the-container-image)は`linux/amd64`です。一方、AVX2/BMI2などの拡張命令の保証は公式資料では確認できませんでした。したがって`TARGET_CPU=OTHER`（`NO_SSE`スカラー実装）と`-march=x86-64 -mtune=generic`を選び、x86-64ベースライン以上を要求しません。公式Makefileの`NO_SSE`ターゲットは32bit用なので指定しません。AVX2専用ビルドより遅くなり得ますが、命令セットの非互換を避けます。stagingの実機でも両モードの動作を確認しました。

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
```

`.local/`の端末ファイルは権限0600で作られ、gitignoreされています。繰り返しの計測で既存ジョブを再利用すると時間を測れないため、スクリプトは重複時に止まります。新しい端末ファイルか異なる手数を選んでください。

計測後は`wrangler containers instances <アプリID> --env staging --json`で**inactive**、`containers info`で**active=0 / assigned=0**を確認してください。準備済み容量の`healthy / starting`とは区別します。実測値・費用式・作成資源一覧は[measurement.md](docs/measurement.md)にあります。

## 公開前に必要なこと

- `shortcut:`：App Attest / Play Integrity、入口の発行・利用レート制限は未実装。匿名トークンを作り直す不正利用は防げません。staging検証用であり、そのまま一般公開しません。
- ストア購入権利検証と端末移行・購入復元の設計。開発許可リストは本番の課金判定ではありません。
- 多利用者の負荷試験とプール枠／`max_instances`の調整。混雑時の45秒タイムアウト・最大5回再試行は最終的に失敗となり、枠を返却します。
- Cloudflareの`default` scheduling policyは現在非推奨ですが、今回は要求された`@cloudflare/containers`・`max_instances`による小さなstagingを採用しました。将来の`durable_object` policy移行は別作業です。
- 分岐中の解析・AIコーチ・アプリ本体はIssue #2の範囲外です。
