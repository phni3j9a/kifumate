# 依存ライブラリの脆弱性精査（Issue #37、2026-11-18）

## Worker / Node.js

`npm audit --json`・`npm audit --omit=dev --json`・`npm ls --all`（Node.js 22.23.4 / npm 10.9.9）で確認。全依存 **6（high 6）→6（high 6）**、`--omit=dev` **0→0**。6件は [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) 1件とその親への伝播です。しかも Wrangler の staging dry-run の esbuild メタファイルで、Workerに入る npm パッケージは `@cloudflare/containers` のみと確認。以下のいずれも Worker/コンテナの実行時には読み込まず、公開HTTP・棋譜・コンテナ応答がglobに変換される経路はありません。

| 警告対象（全6件） | 実行・入力・影響／判定 |
| --- | --- |
| `picomatch` | テストホストのパス・パターン照合。インストール済み `4.0.7` は勧告対象（`<=4.0.7`）。未信頼のテスト設定やglobを処理するとReDoSでテストが停止し得る。**上流修正待ち**（勧告に修正版なし）。 |
| `tinyglobby`、`fdir` | Vitest/Viteのテストファイル探索。リポジトリ内のパスとglob設定を処理する。`tinyglobby → picomatch` と `tinyglobby → fdir → picomatch` が同じReDoSに伝播。修正待ち。 |
| `vite`、`vitest` | Vitestのテスト収集・変換（設定は `vitest.config.ts` の `test/**/*.test.ts`）。依存経由で同じReDoS。本番でViteのサーバーを公開する構成ではない。Vitest `5.1.0` は確認時点の最新版。修正待ち。 |
| `@cloudflare/vitest-plugin` | Vitestでテスト環境を作るプラグイン。Vitestの依存を介した伝播で、テストホストだけに影響。`1.8.4` へ更新後も修正待ち。 |

Wrangler `4.163.0 → 4.164.0`、Vitestプラグイン `1.8.3 → 1.8.4`、Workers型定義 `5.20261116.1 → 5.20261118.1` に更新。`npm audit fix --force` が示す Vitest 3 系への変更・プラグインの削除に相当する変更や、修正版のない依存の override はしない。未信頼のチェックアウト／テスト設定を権限やsecretを持つ環境で実行しない。picomatchの修正版が出たら Vitest/Viteの互換性を確認して再監査する。

## 解析コンテナ / Python

隔離した仮想環境の `pip-audit` で `-r container/requirements.txt` の依存解決と、実際の linux/amd64 イメージの `python -m pip list --format=freeze` の両方を確認。後者は全インストール版を控え、`pip-audit --no-deps --disable-pip -r <控え>` で、監査側のpipによる依存再解決なしに照合した。

- **cshogi `0.9.7`、NumPy `1.26.4`：既知勧告 0→0**。cshogi は本番で読み込まれ、端末が送ったSFENとUSIが到達する。中継でSFENの構造・駒数をネイティブ処理前に確認し、USIの形式・合法手を検査している（`container/bridge.py`）。未報告のネイティブ不具合まで無いとは言えない。NumPyはcshogiの推移依存で、本アプリは利用者から任意の配列ファイルを読ませない。今回は監査で修正を要する勧告がなく、cshogiの機能更新・NumPy 2系移行は行わない。
- **pip `25.0.1 → 26.3`：一意のGHSA 6→0**。更新前のイメージでは `pip-audit` が重複を含め12件報告した。pipはイメージに存在するが使用はビルド時のインストールだけ。Worker/コンテナで公開リクエストからアーカイブやパッケージ索引を受け取る処理はない。`Dockerfile` でpipを固定の修正版に上げてから、cshogi/NumPyをwheelのみでインストールする。Python `3.12.16` と解析依存の版は変更なし。

| 更新前のpipの勧告 | 影響・到達条件 |
| --- | --- |
| [GHSA-4xh5-x5gv-qwph](https://github.com/advisories/GHSA-4xh5-x5gv-qwph) | tar解凍時にリンク先が解凍先外を指し得る。PEP 706がないPython用のフォールバックだけで、このPython 3.12では当該経路を使わない。 |
| [GHSA-6vgw-5pg2-w6jp](https://github.com/advisories/GHSA-6vgw-5pg2-w6jp) | 不正なwheel展開で意図したインストール先の外へ書き出す可能性（パスの接頭辞に制約）。外部リクエストからwheelは渡らない。 |
| [GHSA-58qw-9mgm-455v](https://github.com/advisories/GHSA-58qw-9mgm-455v) | 異なるアーカイブ形式の解釈が食い違い、ビルド時に意図と異なる内容をインストールし得る。外部リクエストからアーカイブは渡らない。 |
| [GHSA-jp4c-xjxw-mgf9](https://github.com/advisories/GHSA-jp4c-xjxw-mgf9) | wheelインストール直後のpipの自己更新確認で、インストールした未信頼コードを意図せず実行し得る。外部リクエストからパッケージは渡らない。 |
| [GHSA-wf93-45jw-7689](https://github.com/advisories/GHSA-wf93-45jw-7689) | パッケージ内のスクリプトのエントリ名により、ビルド時に本来のディレクトリ外へ書き出し得る。外部リクエストからパッケージは渡らない。 |
| [GHSA-qwm4-qh6w-59xr](https://github.com/advisories/GHSA-qwm4-qh6w-59xr) | 悪意ある索引によるパッケージURLの扱いで、ビルド環境の意図しないパスに書き込み得る。外部リクエストから索引は指定させない。 |

今回の監査は npm とイメージにインストールした Python パッケージが対象。ベースOS・CPython自体・エンジンの網羅的な脆弱性監査ではない。

## 検証・反映

- `npm ci`、Vitest 133件、型検査、pytest 45件、招待管理スクリプトの検証は通過。更新イメージをビルドし、`pip check`、ローカルでの `/health` とふつう6手（7局面）も通過。
- staging（`294b480c-7e58-4367-843e-58a00b2674e8`）、本番（`2340baa0-237e-466f-943c-0cd6f889d58a`）に反映。各環境で新規端末登録1回・ふつう6手の解析1回を実行し、7局面すべてに評価があることを確認した。本番はMainがCloudflareのDNS一覧と既存Custom Domainの紐付けを確認してから、READMEの通常更新で反映（secret変更なし、`wrangler tail` 不使用）。
- ローカルの確認コンテナを停止。staging・本番は各3種の実行枠が `inactive`、`active=0 / assigned=0` に戻ったことを確認した。
