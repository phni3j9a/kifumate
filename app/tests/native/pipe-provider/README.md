# サイズ不明・非シーク提供元の検証

製品とは別の、合成データだけを返すAndroid DocumentsProviderです。`ParcelFileDescriptor.createPipe()`を返し、サイズ列はNULLです。製品にネイティブモジュールを組み込むものではありません。

- `backup.kifumate`：APKの `assets/backup.kifumate` に置いた架空のバックアップ。
- `bench4` / `bench16` / `bench32`：各MiBの合法な合成バックアップ。同じ見本を繰り返し、重複の検証も含めて所要時間を測定します。
- `oversize`：256MiB＋1byte。事後サイズ拒否とキャッシュ削除用。

手元のSDKの `android.jar` で `javac` → `d8 --min-api 24`、`aapt package` でこのManifestとassetsをAPK化し、生成dexをzipに追加して検証専用の鍵で `apksigner sign` します。配布鍵は使いません。生成物は `.local/pipe-provider/` 等へ置きます。

専用エミュレータだけへインストールし、次のActivityを一度起動するとFilesの「Kifumate pipe validation」から選べます。

```sh
adb -s emulator-5562 install -r .local/pipe-provider/provider.apk
adb -s emulator-5562 shell 'am start -n com.quarterlambda.kifumate.pipevalidation/.PipeProvider\$SetupActivity'
```

ログは `adb -s emulator-5562 logcat -d -s KifumatePipe:I '*:S'`。START/ENDのミリ秒時刻と、JSの読み終わり時刻でコピー/読み込み時間を確認できます。検証後はこのパッケージを削除し、エミュレータを停止します。

Fabricの連続イベントで通常のuiautomatorがidleを待てない場合は、検証専用の `.PipeProvider\$Dump` Instrumentationで現在のアクセシビリティ階層を取得できます（パイプ転送中には起動しないこと）。
