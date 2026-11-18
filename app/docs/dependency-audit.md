# 依存ライブラリの脆弱性精査（Issue #37、2026-11-18）

Node.js 22.23.4 / npm 10.9.9 で `npm audit --json`、`npm audit --omit=dev --json`、`npm ls --all` を比較。npm の件数は**勧告数ではなく、依存先の警告が伝播したものも含むパッケージ数**です。`--omit=dev` は npm のインストール区分で、APKに同梱・実行されるかとは別です。

| npm の集計 | 更新前 | 更新後 |
| --- | ---: | ---: |
| 全依存 | 44（high 42、moderate 2） | 42（high 42） |
| `--omit=dev` | 36（high 34、moderate 2） | 34（high 34） |

## 直接の勧告（2件）

| 勧告 | 実行・入力・影響 | 対処 |
| --- | --- | --- |
| [GHSA-g3hv-75wg-m249（minimatch）](https://github.com/advisories/GHSA-g3hv-75wg-m249) | `expo → @expo/fingerprint → minimatch@10.2.6`。ホスト上のExpo指紋計算で使う。入力はリポジトリの除外設定・パスで、棋譜やAPI応答ではない。勧告の影響はパターン前処理でのDoS。`@expo/fingerprint@0.21.10` は `{dot: true}` で既定の `optimizationLevel: 1` のまま（`build/Options.js`）なので、勧告の前提である `optimizationLevel >= 2` を満たさない。 | 既知の影響範囲を依存表からも外すため、`@expo/fingerprint` の下だけ `11.0.9` に限定（修正版は `11.0.1` 以降）。依存の `10.x` 指定を越えるので、[v11の変更点](https://github.com/isaacs/minimatch/blob/v11.0.9/changelog.md#110)と実際の呼び出し（`new Minimatch`、`.match`、`.pattern`、`.negate`）を照合。Node 22で通常の除外・ドットファイル・否定・ブレースの判定、および同じプロジェクトで v10/v11 のAndroid/iOSの入力一覧とハッシュが一致することを確認した。Expoが修正版を採用したら override を外す。 |
| [GHSA-fc5q-39xc-vjpf（picomatch）](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) | Expo CLI／Metro／Codegen／ESLint がホストでファイル探索・監視・変換に使う。例えばMetroの監視対象のパターンや依存の `package.json` の `sideEffects`。未信頼のチェックアウト・依存・ビルド設定を処理する場合は、正規表現の計算でCPUが占有され、ビルドや開発が止まる可能性がある。配布APKの棋譜取込・バックアップ復元・ディープリンク・API応答からはこのマッチャーを呼ばない。 | **上流修正待ち**。`npm ls` で `2.3.2` と `4.0.7` が残る。公式勧告は `<=4.0.7`、修正版なし。別メジャーへの一括 override、`npm audit fix --force` によるExpo/RNのダウングレードはしない。開発サーバーを外部公開せず、信頼済みのソース・設定・依存だけでビルドする。修正版公開後にExpo SDK 58/RNの互換範囲と監査を再確認する。 |

## 伝播の一覧

同じ入力・影響で判断できる行をまとめています。`npm audit` が示す親パッケージ名に、別個の脆弱性があるという意味ではありません。配布APKを生成した Gradle のリリース用 Hermes ソースマップでも、`picomatch`、`minimatch`、`tinyglobby`、`fdir`、`micromatch`、Metro・Codegen・Expo指紋計算が実行用JSの入力にないことを確認しました。

| 警告対象（更新前の全44件を網羅） | 実行・入力・影響／判定 |
| --- | --- |
| `minimatch`、`@expo/fingerprint` | 上記の指紋計算（ホストだけ、除外パターン）に該当する2件。更新で解消。 |
| `picomatch`、`tinyglobby`、`fdir`、`micromatch`、`jest-util`、`jest-worker` | ファイルの列挙・照合・変換ワーカーの推移依存。Metroの `metro-file-map → micromatch → picomatch@2`、Codegen等の `tinyglobby → fdir/picomatch@4`、変換ワーカーの `jest-worker → jest-util → picomatch@2` など。ホスト上のファイル・glob設定を処理し、APKの利用者データには使われない。上記ReDoSの修正待ち。 |
| `@expo/cli`、`@expo/config`、`@expo/config-plugins`、`@expo/inline-modules`、`@expo/local-build-cache-provider`、`@expo/metro`、`@expo/metro-config`、`@expo/metro-file-map`、`@expo/prebuild-config`、`babel-preset-expo` | Expoの設定評価・プリビルド・キャッシュ・バンドル生成。入力はプロジェクト設定、ソース、依存パッケージ。脆弱な推移依存はホストだけ。開発・ビルド時のDoS、修正待ち。 |
| `@react-native/babel-plugin-codegen`、`@react-native/babel-preset`、`@react-native/codegen`、`@react-native/community-cli-plugin`、`@react-native/metro-babel-transformer`、`@react-native/metro-config`、`metro`、`metro-config`、`metro-file-map`、`metro-transform-worker` | RNのCLI・型からのネイティブコード生成・JS変換・ファイル探索。`@react-native/codegen → tinyglobby` など。開発・ビルド時にソースとglobを扱うが、実機のJS/ネイティブ実行時には起動しない。開発・ビルド時のDoS、修正待ち。 |
| `expo`、`expo-modules-core`、`expo-sharing`、`expo-splash-screen`、`react-native`、`@react-native/virtualized-lists`、`react-native-reanimated`、`react-native-worklets` | 実行用コードも持つパッケージだが、今回の警告は `expo → CLI/Metro`、共有・スプラッシュの設定プラグイン、`expo-modules-core → Worklets → RN`、`RN → Codegen/CLI/tinyglobby` などへの伝播。棋譜や表示・共有データはこれらの実行用コードに届き得るが、脆弱なマッチャーには届かない。配布APKの到達経路は確認されず、修正待ち。 |
| `eslint-config-expo`、`eslint-plugin-expo`、`eslint-import-resolver-typescript`、`@typescript-eslint/eslint-plugin`、`@typescript-eslint/parser`、`@typescript-eslint/type-utils`、`@typescript-eslint/typescript-estree`、`@typescript-eslint/utils` | 開発時だけ。lintのソース・設定を起点に `typescript-estree`／TSリゾルバーから `tinyglobby` に到達し得る。APKには入らず、開発時のDoS、修正待ち。 |

## 更新

`npx expo install --check` の推奨に合わせ、Expo `58.0.26`、FileSystem `58.0.14`、Router `58.0.32`、SQLite `58.0.18` に更新。SDK 58のまま。React Native `0.88.1`・React `19.3.0`・その他のSDK指定版は変更していない。上記の picomatch 勧告はSDKのパッチだけでは解消しない。

## 検証

- `npm ci`、`npx expo install --check`、`npm run check`（単体205件・型・lint・禁止名称）が通過。
- READMEどおり署名済みAPKをローカルでビルド。表示版0.1.0、EAS連番17、arm64-v8aのみ、同一署名、本番IDと本番URL、非デバッグ、配布アセットの禁止名称なし。正本は `~/kifumate-releases/kifumate-0.1.0-17-arm64-latest.apk`、版16は `old` に改名。SHA-256：`33848134fd80656e9ae605890b13da756a5caf47f2c904a3d0f5140a2755031f`。
- 他のPiMateによる実機・Gradleの使用がないことを作業直前に確認。Pixel 3（Android 11）で通信を止め、`adb install -r` で版16→17に更新。コールド起動、初回インストール日時の維持、既存棋譜一覧が更新前と同じ表示であることを確認。アプリを停止し、通信設定を元に戻した。iOSの実機は対象外。
