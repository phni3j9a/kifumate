# 招待・本番準備の検証

Issue [#24](https://github.com/phni3j9a/kifumate/issues/24)。現在のAPI・上限・管理操作・承認後に実行する本番手順は [README](../README.md) が正本です。

## 構成の判断

- 招待コードは256ビットの乱数。管理端末の0600ファイル以外では原文を保持せず、管理APIもSHA-256だけを受け取ります。端末APIが入力をハッシュ化し、環境別の単一SQLite DOで端末枠・期限・取消を判定します。
- 無効コードの不存在・期限切れ・取消は同じ`invite_invalid`です。再入力は冪等、枠の再利用はしません。複数のコードのうち一つが有効なら有料です。
- 権利照会と利用量を分離。本文受信後の再確認、コーチ実行前／成功確定前の照会、分岐開始直前の照会を追加し、既存の中止・回数返却・保存済み結果の閲覧は維持しました。
- Cloudflare公式Rate Limiting bindingを端末発行・全API・書き込み・コード入力へ適用。これは拠点ごとの近似なので、招待には別途DOの全拠点共有15分制限を置きました。端末5回・IP20回、形式不正・成功も数えます。
- 数十人向けの初期productionも各モード2枠、最大6コンテナに留めます。全局キューを維持し、分岐は最大同時2人・ハッシュ衝突時は空きがあっても409です。公平な動的配分・負荷試験・請求との突合は次の段階です。
- 費用監視は本文や秘密情報を含まない構造化ログと既存の利用上限を採用。外部通知基盤や厳密な金額上限は追加していません。READMEに毎日の観測対象・警戒値・LLM停止方法を記載しました。

## ローカル検証（2026-11-17）

- `npm test`：**113件成功**。招待成功・保存ハッシュ・並列上限・重複入力・期限・取消・複数招待・端末／IP試行制限・窓の回復・公開API連携・本文受信中の失効を確認。
- 既存の分岐・コーチの競合テストに加え、外部権利照会で分岐を起動せず拒否し、コーチ生成中の失効では回答も使用数も保存しないテストを追加。
- 公式bindingの実ランタイムでキー別拒否を確認し、入口の端末発行・API全体・書き込み・招待入力のキーと拒否をテスト。
- 本番設定の専用Worker／DO／Container／domain、開発判定を誤設定しても無効、有効な招待は本番でも利用可、Origin／OPTIONSの拒否、偽提供元の拒否を確認。
- `npm run test:python`：**45件成功**。
- `npm run typecheck`、`node scripts/test_invitations.mjs`、`npm audit`：成功、脆弱性0件。
- `wrangler deploy --env production --dry-run`：Workerの構成検査・実Dockerビルド成功。**アップロード・production資源の作成はしていません**。
- Cloudflare APIの読み取りで、同一accountのzone `quarterlambda.com`（`5cd90ea023a048c177bb1399fdc6a8f1`）がactiveと確認。

## staging検証（2026-11-17）

最終Worker Version：`3ca02056-995f-49d0-9888-4bbc307fa872`。

`node scripts/smoke_invitations.mjs`が最後まで成功しました。

- 管理スクリプトで1端末・1時間の招待を発行。無料端末へ入力して権利とquotaの有料化、別端末の409 `invite_full`、管理取消後の権利／quotaの無料化を確認。
- 公式の招待入力制限を429で確認。65秒待って公式窓が戻った後も、DOの`invite_rate_limited`が残ることを確認。
- 端末APIの連続GETとIP単位の端末発行を429で確認。別の直列測定ではGET **303件目／24.8秒**、発行 **22件目**で拒否されました。近似なので値ぴったりでの拒否を保証しません。
- 瞬間の並列500リクエストでは拒否を観測できなかったため、スモークは短い間隔の直列呼び出しに変更しました。公式の説明どおり、近似制限を請求の厳密な上限として扱いません。
- 実環境ではDO応答のheadersがimmutableで、429へヘッダーを追記すると500になったため、Responseを複製して修正。再デプロイ後、`invite_rate_limited`の429を確認しました。ローカルにもRetry-Afterの回帰検査を追加。
- 中断した試行を含め、**確認用の招待3件はすべて取消済み**。最終スモークはfinallyで取消し、解析・LLMは起動しません。
- 既存の`COACH_SIGNING_KEY`を維持。新規`INVITE_ADMIN_KEY`だけを追加し、既存secretは上書き・削除していません。確認時のstaging secretsはこの2件です。管理鍵はworktreeの`server/.local/invite-admin-staging.key`（0600、git管理外）に保管。worktreeを整理する前に安全な場所へ移してください。

**11:16:33 UTC（20:16:33 JST）**に、std・precise・realtimeの全三つのContainer applicationで`active=0 / assigned=0`、全6スロットが`inactive`（location/version=null）と確認。ローカルにもkifumateの実行中コンテナはありません。他担当の処理を停止する操作はしていません。

## 残事項

- productionの実デプロイ・DNS／証明書・本番専用secret登録・実LLMスモークは、ユーザー確認後にMainが実施します。署名鍵は新規乱数にし、stagingからコピーしません。
- Play Integrity / App Attest、RevenueCat、能動的な失効通知、動的なコンテナ配分、一般公開の負荷試験、自動課金通知／全体予算の自動遮断は範囲外です。
- 公式レート制限は近似かつ拠点別、IP変更・端末再発行による無料枠回避は完全には防げません。今回の対象は少人数への招待配布です。
