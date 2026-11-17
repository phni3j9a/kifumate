# 招待・本番の検証

現在のAPI・上限・管理操作・デプロイ手順は [README](../README.md) が正本です。

## Issue #28：AIコーチの提供元失敗の修正（2026-11-17）

- 原因：`fetch`に指定していた`redirect:'error'`をCloudflare Workersが受理せず、外部送信前に`TypeError`になっていました。stagingのtailで`provider_fetch / TypeError / elapsedMs:0`を確認し、同じオプションをWorkersネイティブ`Request`へ渡す回帰テストでも再現。`redirect:'manual'`へ変更し、3xxを既存の非2xx検査で拒否するため、転送先へのAPIキー送信は引き続き防ぎます。DeepSeekのモデル・要求本文・安全検査は変更していません。
- 診断：提供元のHTTPステータス、固定の発生箇所・例外種別、所要時間だけを構造化ログへ追加。本文・例外のmessage/stack・任意のname・キー・利用者の文は記録しません。期限タイマーはfinallyで解除し、処理終了／診断ログの確定が240秒まで延びる問題も解消しました。
- staging varsは本番と同じ提供元設定に統一。既存secretは署名鍵・管理鍵だけで、他担当の一時的な提供元secretはありませんでした。確認用の`COACH_API_KEY`と自分の端末用`DEV_PAID_HASHES`だけを標準入力で登録し、確認後に削除。既存`COACH_SIGNING_KEY`・`INVITE_ADMIN_KEY`は変更していません。
- 本番はユーザー承認とMainによるDNS一覧確認後、READMEの通常更新どおり`npx wrangler deploy --env production`で反映。DNS一覧では対象のAAAA `100::`が同WorkerのCustom Domain由来で、別用途の競合がないことを確認しました。Wrangler OAuthのDNS一覧403を回避するための権限変更は行っていません。本番の全3secretは上書きしていません。

同じ6手・7局面の署名付き精密解析から、実DeepSeek（`deepseek-flash`、`reasoning_effort:max`、32768 tokens／240秒）を使いました。

| 環境 | 成功確認したWorker Version | 解説／質問（GET待機込み秒） | 回数 |
| --- | --- | --- | --- |
| staging | `4c8377b7-2bef-412b-b198-e3b9e9530c08` | 50.478／47.228 | used=2、reserved=0 |
| production | `e3aab913-4046-494e-86fa-a0c812d96bdb` | 54.621／75.682 | used=2、reserved=0 |

- 両環境で署名改変の拒否、同一要求の再取得・重複拒否、中止済みIDの再送拒否、回数の二重消費なしも確認。stagingで提供元修正後に一度だけ`validate_output / invalid_output`になりましたが、既存の出力安全検査を緩めず、失敗時の回数消費0を維持しています。
- 本番は1端末・1時間の確認用招待を発行して実行し、finallyで取消。`GET /v1/entitlements`の無料化も確認し、コード原文ファイルを削除しました。
- 調査・スモーク全体のDeepSeek残高表示は**$4.40 → $4.39（表示差$0.01）**。残高APIは小数2桁なので概算であり、確定請求額／各要求の厳密な費用ではありません。
- 終了時、staging／productionの全6 Container applicationで`active=0 / assigned=0`、登録済み全instanceが`inactive`、location/version=nullと確認しました（13:05 UTC以前）。他アプリのコンテナには停止操作も設定変更も行っていません。
- 最終ローカル検証：Vitest **132件**、pytest **45件**、型検査、招待管理スクリプト自己検査、変更Pythonの構文検査、`git diff --check`が成功。ネイティブRequestの回帰テストは修正前失敗・修正後成功を確認しました。

**残事項／運用注意**：Wranglerの`tail --format json`の自動メタデータは内部`X-Coach-Config`のsecretを含み得ます。初期調査でこのメタデータが表示されたため、生tailファイルを削除し、以後は固定consoleフィールドだけを受信直後に抽出しました。独自診断ログにはsecretを出していません。既存鍵を上書きしない指示に従いローテーションはしていないため、必要性・影響は管理者が判断してください。実アプリのUI操作・長い棋譜／履歴の再評価、一般公開前の権利検証・予算遮断は今回の範囲外です。

以下はIssue [#24](https://github.com/phni3j9a/kifumate/issues/24)時点の記録です。

## 構成の判断

- 招待コードは80ビットの乱数をCrockford Base32の16文字・4文字区切りで表示します。大小文字・全角英数字・ハイフン類・空白・O/I/Lを正規化してからハッシュ化します。管理端末の0600ファイル以外では原文を保持せず、管理APIもSHA-256だけを受け取ります。端末APIが入力をハッシュ化し、環境別の単一SQLite DOで端末枠・期限・取消を判定します。
- 無効コードの不存在・期限切れ・取消は同じ`invite_invalid`です。再入力は冪等、枠の再利用はしません。複数のコードのうち一つが有効なら有料です。
- 権利照会と利用量を分離。本文受信後の再確認、コーチ実行前／成功確定前の照会、分岐開始直前の照会を追加し、既存の中止・回数返却・保存済み結果の閲覧は維持しました。
- Cloudflare公式Rate Limiting bindingを端末発行・全API・書き込み・コード入力へ適用。これは拠点ごとの近似なので、招待には別途DOの全拠点共有15分制限を置きました。端末5回・IP20回、形式不正・成功も数えます。
- 数十人向けの初期productionも各モード2枠、最大6コンテナに留めます。全局キューを維持し、分岐は最大同時2人・ハッシュ衝突時は空きがあっても409です。公平な動的配分・負荷試験・請求との突合は次の段階です。
- 費用監視は本文や秘密情報を含まない構造化ログと既存の利用上限を採用。外部通知基盤や厳密な金額上限は追加していません。READMEに毎日の観測対象・警戒値・LLM停止方法を記載しました。

## ローカル検証（2026-11-17）

- `npm test`：**128件成功**。Crockford生成・大小文字／全角／ハイフン類／空白／O/I/Lの正規化・旧64桁形式の拒否と、招待成功・保存ハッシュ・並列上限・重複入力・期限・取消・複数招待・端末／IP試行制限・窓の回復・公開API連携・本文受信中の失効を確認。
- 既存の分岐・コーチの競合テストに加え、外部権利照会で分岐を起動せず拒否し、コーチ生成中の失効では回答も使用数も保存しないテストを追加。POST/PUTの本文待機中に外部照会の権利が失効した場合は、所有セッションを停止してから403にし、停止後の時間を加算しない回帰テストも確認。別端末の稼働は止めません。
- 公式bindingの実ランタイムでキー別拒否を確認し、入口の端末発行・API全体・書き込み・招待入力のキーと拒否をテスト。
- 本番設定の専用Worker／DO／Container／domain、開発判定を誤設定しても無効、有効な招待は本番でも利用可、Origin／OPTIONSの拒否、偽提供元の拒否を確認。
- `npm run test:python`：**45件成功**。
- `npm run typecheck`、`node scripts/test_invitations.mjs`、`npm audit`：成功、脆弱性0件。
- レビュー修正では、READMEの初回登録・通常更新手順をbash/zshと偽のWranglerでオフライン実行し、0600/0700の権限・成功／失敗時の一時ファイル削除・キー更新後のsecretファイルなし再デプロイを確認。署名鍵は初回登録後Cloudflareだけに維持し、管理APIに必要な管理鍵だけを`~/.config/kifumate/invite-admin-production.key`へ0600で保持します。
- `wrangler deploy --env production --dry-run`：Workerの構成検査・実Dockerビルド成功。**アップロード・production資源の作成はしていません**。
- Cloudflare APIの読み取りで、同一accountのzone `quarterlambda.com`（`5cd90ea023a048c177bb1399fdc6a8f1`）がactiveと確認。

## staging検証（2026-11-17）

最終Worker Version：`8c4261d5-e2b4-422c-b855-a326386db44e`。形式変更後はWorkerだけを反映し、新形式の発行・全角／小文字／空白を含む入力・同一コードの再入力・取消後の無料化を最小確認しました。確認コードは取消し、原文ファイルは削除済みです。

レビュー指摘の停止処理・secret運用手順の修正はローカルで確認し、依頼どおりstagingへは再デプロイしていません。

前回Version `3ca02056-995f-49d0-9888-4bbc307fa872`では`node scripts/smoke_invitations.mjs`が最後まで成功しました。レート制限・期限・権利判定は今回変更していません。

- 管理スクリプトで1端末・1時間の招待を発行。無料端末へ入力して権利とquotaの有料化、別端末の409 `invite_full`、管理取消後の権利／quotaの無料化を確認。
- 公式の招待入力制限を429で確認。65秒待って公式窓が戻った後も、DOの`invite_rate_limited`が残ることを確認。
- 端末APIの連続GETとIP単位の端末発行を429で確認。別の直列測定ではGET **303件目／24.8秒**、発行 **22件目**で拒否されました。近似なので値ぴったりでの拒否を保証しません。
- 瞬間の並列500リクエストでは拒否を観測できなかったため、スモークは短い間隔の直列呼び出しに変更しました。公式の説明どおり、近似制限を請求の厳密な上限として扱いません。
- 実環境ではDO応答のheadersがimmutableで、429へヘッダーを追記すると500になったため、Responseを複製して修正。再デプロイ後、`invite_rate_limited`の429を確認しました。ローカルにもRetry-Afterの回帰検査を追加。
- 中断した試行を含め、**確認用の招待4件はすべて取消済み**。最終スモークはfinallyで取消し、解析・LLMは起動しません。
- 既存の`COACH_SIGNING_KEY`を維持。新規`INVITE_ADMIN_KEY`だけを追加し、既存secretは上書き・削除していません。確認時のstaging secretsはこの2件です。管理鍵はworktreeの`server/.local/invite-admin-staging.key`（0600、git管理外）に保管。worktreeを整理する前に安全な場所へ移してください。

**11:16:33 UTC（20:16:33 JST）**に、std・precise・realtimeの全三つのContainer applicationで`active=0 / assigned=0`、全6スロットが`inactive`（location/version=null）と確認。ローカルにもkifumateの実行中コンテナはありません。他担当の処理を停止する操作はしていません。

## 残事項

- Issue #24時点で保留した本番登録・実LLM確認は、現在は実施済みです。最新の確認は上記Issue #28の節を参照してください。
- Play Integrity / App Attest、RevenueCat、能動的な失効通知、動的なコンテナ配分、一般公開の負荷試験、自動課金通知／全体予算の自動遮断は範囲外です。
- 公式レート制限は近似かつ拠点別、IP変更・端末再発行による無料枠回避は完全には防げません。今回の対象は少人数への招待配布です。
