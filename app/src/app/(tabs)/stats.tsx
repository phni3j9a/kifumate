import { Empty, Page } from "../../components/ui";
export default function Stats() {
  return (
    <Page>
      <Empty
        title="ここに、あなたの戦績を"
        detail="戦績の集計は準備中です。棋譜の記録・再生はオフラインで使えます。"
      />
    </Page>
  );
}
