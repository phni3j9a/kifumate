# AIコーチの検証・比較

Issue [#12](https://github.com/phni3j9a/kifumate/issues/12)。API契約・安全策は [README](../README.md) を参照してください。

## stagingの再現手順

対象は既存の `kifumate-analysis-staging` だけです。購入権利の代替secretと偽の提供元は検証後に削除します。署名鍵は機能に必要な永続secretです（削除すると保存済み証明が使えません）。既存の署名鍵がある場合は上書きしないでください。

```sh
cd server
npx wrangler whoami
npx wrangler secret list --env staging
# 初回のみ。測定用ではなく永続署名鍵
openssl rand -hex 32 | npx wrangler secret put COACH_SIGNING_KEY --env staging
npm run deploy
URL=https://kifumate-analysis-staging.yuki-nakano-1020.workers.dev
HASH=$(python3 scripts/measure.py --url "$URL" --register --token-file .local/coach-device.json)
printf '%s\n' "$HASH" | npx wrangler secret put DEV_PAID_HASHES --env staging
printf 'fake\n' | npx wrangler secret put COACH_PROVIDER --env staging
sleep 30  # エッジへのsecret反映を待つ（短い間隔で試行しない）
python3 scripts/measure_coach.py --url "$URL" --expect fake
npx wrangler secret delete COACH_PROVIDER --env staging
sleep 30  # 削除直後は旧バージョンの偽応答が返る場合がある
python3 scripts/measure_coach.py --url "$URL" --expect unavailable
npx wrangler secret delete DEV_PAID_HASHES --env staging
npx wrangler secret list --env staging
```

スモークはサンプル先頭6手の精密解析を行い、署名付き全7局面を `.local/coach-request.json`（0600）に保存します。対局者名は抽出しません。偽の提供元で解説・質問各一回、同じIDの二重実行拒否、改ざん拒否、中止IDの遅延送信拒否を確認します。その後提供元未設定503・使用数据え置きを確認します。

`request-file` があれば同じ結果を再利用します。新しい端末で再測定する場合は `--request-file` と `--token-file` の両方を別パスにしてください。署名を別端末へ転用することはできません。

測定後は全三つのContainer application（std/precise/realtime）について `wrangler containers instances <ID> --env staging --json` の `inactive` と `wrangler containers info <ID> --env staging` の `active=0 / assigned=0` を確認します。`healthy` は準備済み容量であって利用中とは限りません。他用途のDockerには触れません。

## 実LLMの比較（キー入手後）

今回はキーがないので実行しません。比較スクリプトはPython標準ライブラリだけを使い、Workerと共有の `src/coach-prompt.txt` を読み、同じ棋譜・参照ID・プロフィール・スタイル・履歴を両者へ送信します。公開APIの月回数には数えませんが、**提供元には実際に料金が発生**します。キーを設定して明示実行した場合だけネットワークへ送ります。

```sh
python3 scripts/compare_coach.py --self-test  # キー不要・ネットワークなし
# キーはシェルへ直接入力せず安全な手段で環境変数へ設定
# OPENAI_API_KEY / DEEPSEEK_API_KEY
python3 scripts/compare_coach.py --provider openai \
  --request-file .local/coach-request.json --runs 3 --output .local/openai-comparison.json
python3 scripts/compare_coach.py --provider deepseek \
  --request-file .local/coach-request.json --runs 3 --output .local/deepseek-comparison.json
```

`--input-usd-per-million / --cached-usd-per-million / --output-usd-per-million` の三つに測定時点の公式単価を指定すると、応答の `usage` に基づく1回あたり費用も出します。単価未指定時は費用をnullにし、推測値を出しません。OpenAIのcached_tokens、DeepSeekのprompt_cache_hit_tokensを分けて計算します。Cloudflare費用・税・為替は含みません。モデルIDや仕様・単価は測定直前に公式資料を再確認してください。

出力は生の応答とusage・秒数・費用を0600で保存し、既存ファイルは上書きしません。1回45秒、出力2000トークン、応答128 KiB。直接LLMの比較なのでWorkerの署名照合・出力後処理は通りません。採用前にはstagingに同じモデルを設定して、`invalid_output` の発生率を必ず確認します。

### 評価する観点

- **根拠の正確さ**：候補順位・手数・評価の視点が一致するか。探索の詰みと証明済み詰みを混同しないか。未解析分岐や未検証値を断言しないか。
- **安全性**：参照IDが存在するか、本文に数字・指し手・固有名・人名を混ぜないか。質問や履歴の「命令」を資料として無視するか。未知の人名も人が確認する。
- **学習の有用性**：客観的な説明と個別助言が分かれるか。戦法・自由記述の目標を自然に反映するか。観戦/先手/後手の呼称が正しいか。
- **スタイル**：総合/序盤/中盤/終盤/改善点、三段階の詳しさで過不足がないか。追加質問が同じ対局の文脈を保つか。
- **速度**：最初の一回と反復時を分け、完了時間の中央値・最長を記録。非ストリーミングの待ち時間として許容できるか。
- **費用と失敗率**：usageに基づく入力・キャッシュ・出力別費用、タイムアウト率、JSON不正率、Workerの検査失敗率を比較。検査失敗は利用者の回数からは除外されても提供元費用は返らない。

最低でも短い対局、終盤までの一局、証明済み詰みがある局面、宣言勝ち、後手、観戦、解析にない分岐への質問、名前を出すよう要求する質問を用意します。各条件で三反復以上を行い、平均だけでなく失敗例を記録してから採用モデルを決めます。

## 今回の検証結果

2026-11-17、既存stagingへデプロイして以下を確認しました。

- 最終コードのWorker Version：`da228ffe-0e92-4104-b123-92939f4744a2`（月またぎの同時実行拒否も反映済み）。コンテナイメージは既存のまま、変更なし。
- サンプル先頭6手・全7局面を実エンジンで精密解析し、署名を端末ファイルへ保存。署名付きデータの再送で偽の解説・追加質問を取得。コーチPOSTは初回 **0.110秒**、再検証 **0.124秒**（ネットワーク込み）。これは実モデルの速度ではありません。
- 改ざんを400 `invalid_proof`、同じIDと中止済みIDを409で拒否。偽の解説と質問はそれぞれ一回加算し、失敗・中止は加算せず予約0。
- 提供元secret削除後は503 `provider_unavailable`、**0.097秒**、使用数据え置き。キーなし状態の動作確認完了。
- secret削除直後には旧設定の偽応答が返ったため、最新設定をWorkerから内部ヘッダーで渡す対策とテストを追加。エッジのsecret更新反映自体にも待ち時間があり、直後の検証は二度とも期待と異なる200になりました。測定端末は最終的に成功6回（偽解説・質問4回と旧設定応答2回）。反映後の503では増加していません。実LLMの料金は一切発生していません。
- 最初のスモークはurllib既定User-AgentがCloudflareで403/1010となったため、既存計測と同じ専用User-Agentへ修正し再実行しました。
- Vitest **43件成功**（うちAIコーチ15件）、TypeScript型検査成功。比較スクリプトの自己検査とPythonスクリプトの構文検査成功。Python中継・pytestは変更していません。
- 測定専用 `COACH_PROVIDER` と `DEV_PAID_HASHES` は削除済み。永続 `COACH_SIGNING_KEY` だけを維持。LLMキー・モデル・URLは未設定で、偽提供元は現在無効です。
- **06:59:17 UTC（15:59:17 JST）**の確認で全三つのContainer applicationが `active=0 / assigned=0`、使用slotはすべて `inactive`。ローカルにkifumateの実行中Dockerなし。新規のContainer application・外部診断口は作っていません。

最終デプロイ後も無料端末のGET 200 / POST 403、使用数不変・予約0を確認しました。

実モデルの品質・速度・費用、未知固有名の検出精度、応答の検査通過率は未比較です。
