# 招待・本番の検証

現在のAPI・上限・管理操作・デプロイ手順は [README](../README.md) が正本です。

## #80・#83：コンテナ障害ログの整理と旧方式の削除（2026-11-22 UTC）

- **#80**（PR #84）：準備待ち・世代更新・停止による打ち切りを `container_failure` から除いた。stagingで正常なstd・precise・コーチ・realtime（休止→hold→停止）を流した区間（15:19:45–15:23:57）と、本番へ反映（15:25:33、Version `07d4b106`）した後の端末発行・std 1局の区間で、Main がWorkers Observabilityで照合し、`container_failure` はどちらも0件だった（反映前の#77の確認では14件）。
- **#83**：旧方式（`default` policyの StandardContainer・PreciseContainer・RealtimeContainer）を削除した。手順は両環境とも次のとおり。staging（中間版 `2d08ce15`、最終 `2f2ceac4`）で確認してから本番に適用した。
  1. 旧経路と旧containersの設定だけを外した中間版をデプロイする（旧DOクラスはまだ残す）。本番では15:39:17に `a51d34b0`。
  2. 旧3アプリが `active=0 / assigned=0` であることを確認し、`wrangler containers delete` で手動で削除する。本番では15:39:20に削除し、一覧から消えたことを確認した。
  3. v5 migration（`deleted_classes`）で旧DOクラスとbindingを削除する。本番の最終版は `e065b9c1`。旧RealtimeContainerにあった11月の切り替え前のrealtime利用時間も、ここで消えた。
  4. 旧3アプリ専用のレジストリのイメージを削除する（staging 36タグ、本番18タグ）。残ったリポジトリとタグは、削除前の新方式の分と一致した。
- 本番の確認（15:41:52–15:45:39）：std 4手（5/5局面）、precise 85手（サーバー137.934秒、深読み8/8、署名あり）、realtime（休止→hold再開で深さ35→停止、使用74.310秒）。確認後に招待を取り消して `paid:false` を確認した。Main がObservabilityで照合した結果、engine_startは4件すべてAVX2（std 1/1、precise 2/2、realtimeは開始とhold再開の各1/1）、`container_failure` は0件。
- **現在の構成**：両環境とも新方式の3アプリ（standardjob・precisejob・realtimeengine）だけ。**旧方式へ切り戻す手段はない。**

## #77：本番を解析単位の専用コンテナへ切替（2026-11-22 UTC/JST）

ユーザーの承認によりJST月初を待たず切替。11月のrealtime利用時間は新しい端末別台帳で0から開始し、旧台帳は移行・削除していない。全局ジョブ・週枠・署名・招待のDO／secretは維持した。一般公開の条件 #74 と、旧applicationの削除承認は別。

| 本番操作（UTC、100%配信確認時点） | Worker Version | 確認 |
| --- | --- | --- |
| 14:39:55 旧ルートv3、受付遮断 | `1a236185-759e-4e90-94d3-f9a627d1319a` | 360秒待ち、14:46:01–10／14:46:39–47／14:47:16–24に旧3アプリがいずれもactive=0・すべてinactive。承認された時間・稼働数によるdrain判定。全DeviceのSQLiteを走査したわけではない。 |
| 14:48:02 遮断のまま新ルートv4 | `5fb4664f-d793-4fd5-a0f6-4d69fa7d0680` | 300秒待ち、14:53:09–18に旧3アプリactive=0を再確認。 |
| 14:53:40 受付再開 | `f8acd874-00da-4d8f-b1b2-bcc9504a0d89` | `ANALYSIS_DRAIN=false`。旧bindingと3つの旧applicationは残した。 |

DNSはMainが直前にCustom Domain由来AAAA `100::` 1件・本番Workerとの紐付けを確認。ビルド前に知識DB `c47df8b2…` とnn.bin `a78b7f88…` を照合。`--secrets-file` なし、secret名3件は前後同一。型検査、Vitest 245件、pytest 123件成功。

| 本番検証 | 開始–終了（UTC） | 結果 | engine_startの実測 |
| --- | --- | --- | --- |
| 端末発行・OPTIONS | 14:53:41 | 201／403、CORS許可ヘッダーなし | — |
| std 85手 | 14:53:41.812–14:54:22.730 | DO 39.468秒／観測40.821秒、86/86局面、候補1位depth中央値14 | 14:53:47.826 AVX2、processors/nproc 1/1 |
| precise 85手 | 14:54:22.852–14:56:44.767 | DO 140.193秒／観測141.849秒、86/86局面、深読み8/8、署名・全件再送・枠加算成功。depth中央値14／深読み14.5 | 14:54:24.765 AVX2、2/2 |
| AIコーチ1件 | 14:56:44.767–14:57:03.595 | 観測18.830秒、参照4件。新preciseのfacts/tools経路。`coach_responses_tools` status 200、3ターン・6呼出、入出力15,007/728 tokens、提供元16.086秒、`coach_completed` 17.990秒、failed 0 | facts/toolsはエンジンを起動せず、期間中0件 |
| realtime 1セッション | 14:57:03.607–14:58:25.365 | 初回5.890秒、depth 15→18→20、30秒休止→hold再開4.986秒、35.126秒でdepth 34、明示停止後の追加計上なし。使用75.639秒 | 14:57:05.473、hold再開14:57:49.777、ともにAVX2・1/1 |

MainがWorkers Observabilityの固定フィールドを照合。`engine_start` は4件すべて `/app/engine-avx2`・`avx2Usable=true`・AMD EPYC 7713 64-Core。1時間・1端末の確認招待を14:58:26に取消後 `paid:false`。確認端末トークンと招待ファイルは削除。15:01:55–15:03:12に本番の新旧6アプリで `active=0`・全履歴inactive（新std 1／precise 2／realtime 1、旧は各2）。stagingは変更なし、14:42:20–40に6アプリすべてactive=0・全履歴inactiveを確認。

**最終構成**：下表のapplication名は両環境で `kifumate-analysis-<環境>-<クラス名小文字>-<環境>`。サイズはvCPU／メモリ／ディスク。旧アプリは切り戻し用で、削除は観察後の別承認。

| クラス名小文字 | policy | サイズ | 用途 | 状態（本番・staging共通） |
| --- | --- | --- | --- | --- |
| standardjob | durable_object | 1／1536 MiB／2000 MB | stdジョブ別 | 現用・確認時停止 |
| precisejob | durable_object | 2／1536 MiB／2000 MB | preciseジョブ別・コーチfacts/tools | 現用・確認時停止 |
| realtimeengine | durable_object | 1／1536 MiB／2000 MB | realtimeセッション別 | 現用・確認時停止 |
| standardcontainer | default | 1／6 GiB／12 GB | 旧std固定2枠 | 停止・削除待ち |
| precisecontainer | default | 2／8 GiB／16 GB | 旧precise固定2枠 | 停止・削除待ち |
| realtimecontainer | default | 1／6 GiB／12 GB | 旧realtime固定2枠 | 停止・削除待ち |

**残事項 [#80](https://github.com/phni3j9a/kifumate/issues/80)**：14:53:30–15:00 UTCの `container_failure` は14件。readinessのError 5件（起動後196–4541ms、その後準備完了）、realtime局面更新中のforward 409が7件、forwardのErrorが2件（14:57:44・14:58:23、休止・停止と整合）。いずれも今回の利用者操作は成功した。正常系のログと障害を区別する改善は今回の本番反映に含めない。

## #69・#71：知識DBと駒組みの分岐点の本番反映（2026-11-22）

- `main` の `c275802`（PR #70・#72）と、非公開リポジトリの `main`（`3da763c`）から `npm run build` した知識DB（全7章・定跡1839局面・方針34件・手筋100問、SHA-256 `c47df8b2…`）を `server/container/knowledge/knowledge.json` に置いて反映。DBはGit管理外で、コンテナイメージにだけ同梱。反映前にVitest 230件・型検査・pytest 111件が通過。アプリとのAPI契約は変更なし。
- staging：Version `9f3b63b2-78e4-47e1-855a-0f45dc2d1d06`。開発者の実戦 `server/scripts/games/game03.kif`（88手）を署名付き精密解析（158.6秒、89局面）し、AIコーチを1回（53.1秒）。回答は15手目 ▲9六歩 を駒組みの分岐点とし、定跡の手 ▲6八玉・▲4五歩 を保存解析の候補と区別して示した。計測後、3コンテナとも `active=0 / assigned=0`。
- production：Cloudflare APIでDNSを確認した。`kifumate-api.quarterlambda.com` はWorkerのCustom Domainが管理する読み取り専用のAAAA `100::`（proxied）1件のみで、Workers Domains で `kifumate-analysis-production` に紐付き、競合なし。`--secrets-file` なしで通常更新し、secretは名前3件のまま。Version `f09747f5-f529-410f-9e0e-585a30f2e098`。09:59 UTCにstd・precise・realtimeの3コンテナがv5へのロールアウト完了。端末発行201、OPTIONS 403・CORS許可ヘッダーなし。ロールアウト中の約2分は新Workerが旧コンテナに当たり得た（利用者が少ないため許容）。
- 本番でも game03 を精密解析（154.1秒）し、AIコーチを1回（34.3秒、再試行なし）。stagingと同じ分岐点と定跡の手を示した。費用は未計測（#71の比較では1回答あたり平均約$0.056）。両環境とも確認用の1端末・翌日期限の招待を取り消し、招待原文・取消用メタデータ・確認端末のトークンは削除。確認後、3コンテナとも `active=0 / assigned=0`。
- 未実施：実機アプリからの表示確認、将棋の有識者によるDBの監修。

## #56：本番反映と配布APK 0.1.3（2026-11-21）

- `main` の `659fbe9`（PR #57・#60・#61・#63・#64・#65）を本番に反映。Mainが08:30台 UTCにCloudflare APIで確認したDNSレコードは、WorkerのCustom Domainが管理する読み取り専用のAAAA `100::`（proxied）1件のみ。同ホスト `kifumate-api.quarterlambda.com` はWorkers Domainsで `kifumate-analysis-production`（production）に紐付いており、競合なし。事前のWrangler相当のchangesetでも競合・追加・削除なし。`--secrets-file` なしで通常更新し、既存secretは変更せず、反映後も名前3件を確認。
- Worker Version `3bb071b9-0a78-4a36-b843-b95c967725c9` が100%。08:41:04 UTCにstd・precise・realtimeの3コンテナがv4にロールアウト完了と確認。5分待ち、端末発行201、OPTIONS 403 `browser_forbidden`・CORS許可ヘッダーなしを確認。

| 本番確認 | 成否・所要時間 | 道具／APIターン | 提供元費用（推計） | 週の枠・金額表示 |
| --- | --- | ---: | ---: | --- |
| サンプル棋譜85手・署名付き精密解析 | 成功（147.211秒、2段目41.863秒、深読み8/8、完了時に全86局面と署名） | — | — | — |
| リアルタイム解析1セッション | 成功（初回3.913秒、同一局面の深さ16→20→21、通常30秒で休止、`hold`で再開後40.113秒も探索継続、停止まで月の枠80.327秒使用） | — | — | — |
| AIコーチ1件（再試行なし） | 成功（18.911秒、GET待ち込み、深読み参照4件） | 未計測 | $0.0187626（$0.20以内） | 残り100% → 96.24748%、枠の応答に金額なし |

- 費用は週枠の差分からの推計（提供元の確定請求額やCloudflare利用料との突合は未実施）。$0.20は今回の確認目安で、自動遮断ではなく、設定上の理論最大は1件でも超え得ます。
- 1端末・1時間の確認招待を取り消し、同じ端末が無料に戻ることを確認。招待原文・取消用メタデータ・確認端末トークン・リアルタイム計測用の一時コピーは削除。08:51:59 UTCに3コンテナの全6枠が `inactive`（各 `active=0 / assigned=0`）と確認。
- 本番dry-run（Dockerビルド込み）、Vitest 225件、型検査、pytest 81件が通過。アプリは `npm run check`（単体234件、禁止名称・型・lint）とWeb E2E 150件が通過。
- [配布APK 0.1.3](../../app/README.md#androidの配布apkビルド)：`~/kifumate-releases/kifumate-0.1.3-1003-arm64-latest.apk`（42,433,887バイト、`com.quarterlambda.kifumate`、`versionCode=1003`、arm64-v8a専用）。SHA-256 `7f2e59c2aa6c6d9fbb9dca606f9ecc3de10fd182261492cdf374084538fda0a1`。署名検証済み、証明書は0.1.2と同じ（`3960c238…69a9`）。0.1.2は `.sha256` とともに `old-before-deep-reading` に改名して照合済み。
- Pixel 3では更新前に0.1.1（1001）と既存棋譜1件を確認。`adb install -r` はPlay プロテクトのアプリ送信確認で応答待ちとなり、更新後の版・棋譜保持・「勝負所」の表示は未確認。送信の可否は利用者が判断し、Mainが実機確認を引き継ぎます。アンインストール・データ消去はしていません。

## #55・#59：本番反映と配布APK 0.1.2（2026-11-20）

- `main` の `9e13b34` を本番に反映し、GPT-6.1 Terraの道具方式と週の費用枠を有効化。DNSは既存Custom Domainのまま（changesetの追加・削除・競合なし）。更新したsecretは `COACH_API_KEY` のみ。`COACH_SIGNING_KEY`・`INVITE_ADMIN_KEY` は維持。
- Worker Version `2fc1d997-1a0a-4a12-95b3-246e1bc6de98` が100%。std・precise・realtimeのコンテナは同じデプロイで全てv3にロールアウト完了。確認後5分待ち、端末発行201、OPTIONS 403 `browser_forbidden`・CORS許可ヘッダーなし、secret名3件を確認。

| 本番確認 | 成否・所要時間 | 道具／APIターン | 提供元費用（推計） | 週の枠・金額表示 |
| --- | --- | ---: | ---: | --- |
| 6手の棋譜・署名付き精密解析 | 成功（7局面、13.194秒） | — | — | — |
| AIコーチの解説1件（再試行なし） | 成功（36.098秒、GET待ち込み） | 10／4 | $0.0282955（$0.20以内） | 残り100% → 94.3409%、応答に金額なし |

- 道具とターンはObservabilityの `coach_responses_tools` で確認。費用は使用量で精算した週枠の差分からの推計（提供元の確定請求額との突合は未実施）。1端末・1時間の確認招待は取消済み。同じ端末が無料に戻り、16:43 UTCに3コンテナの全6枠が `inactive`（各 `active=0 / assigned=0`）と確認。
- 本番dry-run（Dockerビルド込み）、Vitest 207件、型検査、pytest 74件が通過。週の枠には[配布APK 0.1.2](../../app/README.md#androidの配布apkビルド)への上書き更新が必要。

## PR #30追補：秘密情報の内部転送撤去（2026-11-17）

- **前回、本番でも`wrangler tail --env production`を実行しました。** consoleの固定フィールドだけを抽出していましたが、内部HTTPの自動メタデータへsecretを載せる実装自体を撤去しました。今回の追補作業ではtailを実行・記録していません。
- `X-Coach-Config`と設定コピーのヘルパー／保持用フィールドを削除し、コーチ生成・精密解析の署名はDO自身のenvを直接参照します。secretだけでなく提供元・上限の設定一式も、内部HTTPヘッダー・本文へ追加しません。
- Worker→Deviceは外部ヘッダーを`Content-Type`・`Prefer`だけに限定。権利の真偽値・IPハッシュはサーバーで算出し、Device→Realtimeの端末ハッシュ・所有者・権利も上書きします。secret4種と端末トークンの値が両境界のヘッダー／本文に含まれない回帰テスト、外部からの偽装値の拒否を追加しました。
- MainがDNS一覧の競合なしを再確認後、両環境を通常手順でデプロイ。その後、両環境の`COACH_SIGNING_KEY`をそれぞれランダム32バイトの新しい値へ標準入力だけで差し替えました。新しい鍵は表示・ファイル保存していません。**両環境の差し替え前の精密解析証明は無効**です。管理鍵とDeepSeekキーは変更していません。
- 切替後のVersion：staging `9e8feee7-e5b8-40cf-80ef-3985d60e4442`、production `f400a9b6-789f-4ccf-a00f-ddf583cc524b`。デプロイ済みの`index.ts`・`coach.ts`と最終ソースの一致を確認しました。
- 公式仕様のDO更新猶予300秒を待ち、本番で1端末・1時間の確認招待を使い、新規精密解析7局面→実DeepSeekの**解説1回が31.812秒で成功**（GET待機込み、used=1／reserved=0）。finallyで招待を取り消し、無料化を確認、コード原文・取消用メタデータも削除しました。
- Vitest **133件**、pytest **45件**、型検査、`git diff --check`成功。13:21 UTCに両環境の全6 Container applicationでactive=0／assigned=0、登録済みinstanceすべてinactiveを確認しました。
- READMEに公式Secrets／DOコード更新／Bindingsへの根拠リンク、版切替の猶予、内部ヘッダーの信頼境界、tailを共有・記録しないこと、表示されたsecretを差し替える手順を追加しました。

**残事項**：漏えいしたDeepSeek旧キーは利用者による新規発行・`~/.config/kifumate/llm.env`更新待ちです。READMEの標準入力による更新・確認・旧キー失効の手順で対応してください。今回このキーは差し替えていません。

## Issue #28：AIコーチの提供元失敗の修正（初回確認、2026-11-17）

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

**残事項／運用注意**：Wranglerの`tail --format json`の自動メタデータは内部`X-Coach-Config`のsecretを含み得ます。初期調査でこのメタデータが表示されたため、生tailファイルを削除し、以後は固定consoleフィールドだけを受信直後に抽出しました。独自診断ログにはsecretを出していません。初回は既存鍵を上書きしない指示に従いローテーションを行いませんでしたが、上記の追補で内部転送の撤去と両環境の署名鍵差し替えを実施しました。DeepSeekキーのみ利用者の更新待ちです。実アプリのUI操作・長い棋譜／履歴の再評価、一般公開前の権利検証・予算遮断は今回の範囲外です。

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
