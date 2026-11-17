# staging実測と費用見積もり

計測日：2026-11-17（JST）。Issue [#2](https://github.com/phni3j9a/kifumate/issues/2)。**両モードの全局解析をstagingで完了**しました。料金は見積もりであり、Cloudflare請求の実績値ではありません。

## 条件

- Worker：`https://kifumate-analysis-staging.yuki-nakano-1020.workers.dev`
- アカウント：`0c28583a22fe4051144d6efdb783d3b0`。既存のOAuth認証を利用。プラン変更・対話ログイン・他アプリの資源操作はしていません。
- 計測コードのWorker Version：`117c8ac1-03f9-452c-96f2-d504b63ea7e4`。
- `mock/data/sample-game.json`の**85手（開始局面を含め86局面）**。100手前後の実棋譜として指定サンプルを全局使用。送信したのは開始局面・USI指し手列・モードだけです。
- `scripts/measure.py`で新規端末を作り、通常・精密を順に依頼。クライアントは2秒間隔で差分取得します。端末の開発有料許可は計測終了後にsecretごと削除しました。
- モード別の固定2枠プール、`max_instances=2`、`sleepAfter='10s'`。中継・エンジンは1枠内で直列実行。
- コンテナイメージdigest：`sha256:01f90415799a892f970e40be70d8e563acd01468bb40cde106c4da728d947420`。
- `TARGET_CPU=OTHER`、x86-64ベースライン。固定ソース・評価関数SHA-256・ライセンスは[README](../README.md)参照。

## 結果

| モード | vCPU / Threads / MultiPV | DO受理→完了 | クライアント計測 | 局面 | 結果JSONの大きさ |
| --- | --- | ---: | ---: | ---: | ---: |
| std | 1 / 1 / 1 | **52.196秒** | 54.247秒 | 86/86 | 21,679 bytes |
| precise | 2 / 2 / 3 | **95.963秒** | 未取得（下記） | 86/86 | 55,621 bytes |

DO時刻による所要時間は、永続化された`finishedAt - createdAt`です。起動待ち・alarm・中継往復・探索・詰み検査を含み、クライアント通信や最終ポーリングの待ちは含みません。探索時間だけの下限はstd 21.5秒、precise 86秒です。stdでは初回の配置・起動待ちも含むため、探索時間との差が大きくなります。preciseのコンテナ配置先は`kix03`でした。

preciseの実行中にエージェントの実行時間上限で計測クライアントが終了しましたが、**サーバーは継続し、同じジョブを完了**しました。再解析は行わず、後から結果とDOの終了時刻を回収しました。これがクライアント切断後の継続確認も兼ねています。存在しないクライアント完了時刻は補間していません。

| モード | ジョブID | createdAt（Unix ms） | finishedAt（Unix ms） |
| --- | --- | ---: | ---: |
| std | `2fa61c47-8426-4d9c-a8a6-6f0212e322ab` | 1794875439224 | 1794875491420 |
| precise | `0475b421-ec86-493e-9f24-913e857488bb` | 1794875493443 | 1794875589406 |

検証内容：

- 全結果の`ply`が0〜85まで連続し、全局面で評価値を取得。stdは候補最大1、preciseは最大3です。
- 両モードで80・82・84手目の詰みを確認。APIの詰み手順はcshogiで検証したものだけです。
- API結果にエンジン・評価関数の名前が含まれていないことを検査。
- 成功2局を1回ずつ集計。計測途中では精密を予約として保持し、失敗・中止時は返却する挙動をテスト。
- Worker/SQLite DO：Vitest **14件成功**。JST週境界、予約・上限・返却、待ち取り消し、中止後の遅延結果破棄、同時重複、モード差、障害とDO再生成からの再開、7日削除、本文制限、認証と内部権利ヘッダー偽装を確認。
- Python：pytest **15件成功**。偽USIプロセス、先手視点・詰みスコア・上下限の正規化、全応手付き1手/3手詰み、不正棋譜・個人情報フィールド拒否、内部エラーの秘匿。
- `npm run typecheck`成功、`npm audit`は脆弱性0件。DockerビルドとWrangler dry-runも成功。

### ローカルDockerスモーク

Intel Core i5-8500B / Ubuntu、Dockerを2 CPU・2 GiBに制限。実際のイメージ・評価関数を使い、サンプル先頭6手・7局面を直接中継へ渡しました。

| モード | 所要時間 | 局面 |
| --- | ---: | ---: |
| std | 3.037秒 | 7/7 |
| precise | 7.165秒 | 7/7 |

Dockerの`stop -t 3`は0.617秒で終了しました。これはCloudflare料金の計測には使っていません。

## 費用見積もり（USD、1局）

2026-11-17に確認した[Cloudflare Containers公式料金](https://developers.cloudflare.com/containers/platform/pricing/)（ページ更新2026-11-13）：

- CPU：**$0.000020 / vCPU秒**（実際に使ったCPU時間）
- メモリ：**$0.0000025 / GiB秒**（予約容量）
- ディスク：**$0.00000007 / GB秒**（予約容量）
- Workers Paidは月$5、月内にCPU 375 vCPU分・メモリ25 GiB時・ディスク200 GB時を含みます。
- [公式インスタンス表](https://developers.cloudflare.com/containers/platform/limits/)：standard-2は1 vCPU / 6 GiB / 12 GB、standard-3は2 vCPU / 8 GiB / 16 GB。

実測のジョブ時間に、起動・停止観測の丸めと終了後の待機として**30秒**を加える保守的モデルです。設定は10秒ですが、一覧のinactiveへの遷移は完了の約21秒後だったため、10秒だけで見積もりません。実CPU使用量や請求の稼働秒は取得していないため、CPUもその全時間で上限vCPUを使ったと仮定します。待機中CPUは通常小さく、実費はこの値を下回り得ます。これはプラットフォーム障害・再試行・混雑を含む厳密な上限ではありません。

```text
T = DOの受理から完了までの実測秒 + 30秒
CPU    = T × vCPU × 0.000020
Memory = T × 予約GiB × 0.0000025
Disk   = T × 予約GB × 0.00000007
```

| モード | T | CPU | メモリ | ディスク | 合計概算 |
| --- | ---: | ---: | ---: | ---: | ---: |
| std | 82.196秒 | $0.00164392 | $0.00123294 | $0.00006904 | **約$0.00295/局** |
| precise | 125.963秒 | $0.00503852 | $0.00251926 | $0.00014108 | **約$0.00770/局** |

月内無料枠の控除前、Containersの計算資源だけです。Workers・DOのリクエスト/CPU/稼働/SQLite保存・読書き、通信、ログ、月$5の固定費は別です。DOとWorkerは[各公式料金](https://developers.cloudflare.com/durable-objects/platform/pricing/)で追加見積もりが必要です。為替換算・税込み価格・多数利用者での単価を保証するものではありません。回数制限や7日保存は費用上限そのものではなく、公開前にレート制限が必要です。

## 作成したCloudflare資源

**すべてkifumateのstaging専用**です。本番Workerは作っていません。既存の他アプリには触れていません。

| 名前 | 種類 | ID／備考 |
| --- | --- | --- |
| `kifumate-analysis-staging` | Worker | 上記workers.dev URL |
| `kifumate-analysis-staging_Device` | SQLite DO namespace | `a6fa06c884da47fdac4a31b6d56e3ee9`、利用者別ジョブ・結果・回数 |
| `kifumate-analysis-staging_StandardContainer` | SQLite + Container DO namespace | `e5a4981ed0b34dac81da2032212b8ee5`、std固定プール |
| `kifumate-analysis-staging_PreciseContainer` | SQLite + Container DO namespace | `85c1a5cab7254dc6ac5efedcc6a12157`、precise固定プール |
| `kifumate-analysis-staging-standardcontainer-staging` | Container application | `a03ecee6-a1f4-495c-ad64-4546064e7741`、standard-2、max 2 |
| `kifumate-analysis-staging-precisecontainer-staging` | Container application | `a03e09ba-f20f-4f24-848d-02b62c4ca73d`、standard-3、max 2 |
| 上記Container applicationと同名の2リポジトリ | アカウント内Container Registryイメージ | `registry.cloudflare.com/0c28583a22fe4051144d6efdb783d3b0/…`、公開配布しない |
| `DEV_PAID_HASHES` | 計測用Worker secret | **計測後に削除済み**。トークン原文はsecretにも保存しない |

初期の端末ごとContainer方式では、端末を増やした計測で割当失敗が発生しました。端末数に依存した割当を避けるため、利用者DOは維持し、Containerだけ固定2枠へ変更しました。今回作成した旧Container application 2個は削除し、上表のIDで作り直しました。旧アプリやその実行中インスタンスは残していません。

## 停止・後片付け

2026-11-17 **00:33:53 UTC（09:33:53 JST）**、両アプリについて以下を確認しました。

- `wrangler containers info <ID>`：`active=0`、`assigned=0`。
- `wrangler containers instances <ID> --json`：使用した`slot-1`が**inactive**、location/versionがnull。
- stdのinactive記録：00:31:52 UTC。precise：00:33:30 UTC。
- `healthy / starting`はCloudflare側の準備済み容量で、利用者の実行中コンテナとは区別しました。
- ローカルDockerにも`kifumate`の実行中コンテナなし。

初期イメージはPID 1のSIGTERM明示処理がなく、停止が遅れました。修正後はローカルの短時間停止とstagingのinactiveを両方確認しました。**稼働中の解析コンテナは残していません**。Worker・DO・レジストリと保存結果はレビュー・再検証のため残しています。結果は7日で自動削除されます。

## 残る限界

- 1局ずつの計測です。多利用者の同時負荷・請求メーターとの突合・長期運用は未検証。
- 匿名端末の再発行による制限回避と、購入権利の検証は公開前の別課題です。
- モード別2枠はstaging用の小さな構成です。公開時は負荷計測してプールと上限を一緒に調整してください。
