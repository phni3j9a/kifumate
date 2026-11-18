# サイズ不明・非シーク提供元の検証

製品とは別の、合成データだけを返すAndroid DocumentsProviderです。`ParcelFileDescriptor.createPipe()`を返し、サイズ列はNULLです。製品にネイティブモジュールを組み込むものではありません。

- `backup.kifumate`：APKの `assets/backup.kifumate` に置いた架空のバックアップ。
- `bench4` / `bench16` / `bench32`：各MiB分のASCII。取り込みではなく読み込み速度測定用。
- `oversize`：256MiB＋1byte。事後サイズ拒否とキャッシュ削除用。

手元のSDKの `android.jar` で `javac` → `d8 --min-api 24`、`aapt package` でこのManifestとassetsをAPK化し、生成dexをzipに追加して検証専用の鍵で `apksigner sign` します。配布鍵は使いません。生成物は `.local/pipe-provider/` 等へ置きます。

専用エミュレータだけへインストールし、次のActivityを一度起動するとFilesの「Kifumate pipe validation」から選べます。

```sh
adb -s emulator-5562 install -r .local/pipe-provider/provider.apk
adb -s emulator-5562 shell am start -n 'com.quarterlambda.kifumate.pipevalidation/.PipeProvider$SetupActivity'
```

ログは `adb -s emulator-5562 logcat -d -s KifumatePipe:I '*:S'`。START/ENDのミリ秒時刻と、JSの読み終わり時刻でコピー/読み込み時間を確認できます。検証後はこのパッケージを削除し、エミュレータを停止します。
