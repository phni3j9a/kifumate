# kifumate

将棋の棋譜を記録・解析し、対局の振り返りを支援するアプリです。

- [製品要求仕様](kifumate-spec.md)
- [UIモックと決定事項](mock/README.md)
- [解析サーバー：API・開発・デプロイ](server/README.md)
- [stagingの実測と費用見積もり](server/docs/measurement.md)

現状：UIモックと全局解析サーバーを実装済み。サーバーはstagingで通常・精密の全局解析を検証済みです。アプリ本体、ストア購入権利の検証、分岐中の解析、AIコーチは未実装です。公開前には端末認証・不正利用対策と本番向けの負荷検証が必要です。
