// ストア版への変更時はenvironment.tsの配布種別と購入処理を一緒に切り替える。
export function planCopy(distribution: "invite" | "store") {
  return distribution === "invite"
    ? {
        heading: "招待コードで使えます",
        action: "招待コードを入力",
        restore: null,
        note: "招待コードはこの端末だけで使えます。期限が切れたり、取り消されたりすると無料プランに戻ります。保存した解析結果と解説は、そのあとも読めます。",
      }
    : {
        heading: "有料プラン",
        action: "プランに登録する",
        restore: "購入を復元",
        note: "料金と期間は購入前にストアで確認できます。購入の管理・解約はストアの設定から行えます。",
      };
}
