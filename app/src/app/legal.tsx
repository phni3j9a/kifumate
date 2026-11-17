import { Text } from "react-native";
import { useLocalSearchParams } from "expo-router";
import {
  Card,
  Hint,
  PageHeader,
  PageScroll,
  Screen,
  SectionTitle,
} from "../components/ui";
import { colors, font } from "../components/theme";
const terms = [
  [
    "招待配布版について",
    "この版は、発行者から受け取った招待コードで有料機能を試すためのものです。アプリ内での購入や自動課金はありません。コードの権利は端末ごとに管理され、バックアップには含まれません。",
  ],
  [
    "棋譜とバックアップ",
    "取り込む棋譜を利用・送信する権利を確認してください。棋譜・設定は端末内に保存します。アンインストールすると失われるため、バックアップを安全な場所に保管してください。自動同期はありません。",
  ],
  [
    "解析とAIコーチ",
    "解析や解説は振り返りを助けるもので、正確性を保証するものではありません。AIの助言には誤りが含まれることがあります。通信・回数の上限があり、通信できなくても保存した結果は読めます。",
  ],
];
const privacy = [
  [
    "端末内に保存するもの",
    "棋譜、登録した名前、手で直した結果・先後・分類、解析結果、AIコーチの文章と質問履歴、学習プロフィール、設定を端末内に保存します。棋譜の削除では関連する解析・解説も削除されます。",
  ],
  [
    "通信するときに送るもの",
    "解析には開始局面と指し手を送ります。KIFヘッダー・対局者名・登録名は送りません。AIコーチには解析結果・学習プロフィール・質問と直近の履歴を送ります。自由文中の登録名と対局者名を端末側で伏せますが、1文字の名前など見分けられない表記があります。個人情報は質問・目標に入力しないでください。",
  ],
  [
    "端末の登録と利用権",
    "通信の認証に匿名の端末トークンを使い、端末ごとの利用権・回数をサーバーで管理します。トークン・招待コードの権利・購入情報はバックアップに含めません。",
  ],
  [
    "ファイルの取り扱い",
    "バックアップは暗号化していないファイルです。名前・目標・質問などが含まれます。保存先と共有先はご自身で選び、第三者が読めない場所で保管してください。アプリから自動でクラウドへ送ることはありません。",
  ],
];
export default function Legal() {
  const { kind } = useLocalSearchParams<{ kind?: string }>(),
    isPrivacy = kind === "privacy";
  return (
    <Screen>
      <PageHeader title={isPrivacy ? "プライバシーポリシー" : "利用規約"} />
      <PageScroll>
        <Hint>
          招待配布版の利用案内です。ストアでの販売・購入機能はまだ提供していません。
        </Hint>
        {(isPrivacy ? privacy : terms).map(([title, body]) => (
          <TextSection key={title} title={title!} body={body!} />
        ))}
      </PageScroll>
    </Screen>
  );
}
function TextSection({ title, body }: { title: string; body: string }) {
  return (
    <>
      <SectionTitle>{title}</SectionTitle>
      <Card style={{ padding: 14 }}>
        <Text selectable style={font(500, 12.5, 1.75, colors.ink2)}>
          {body}
        </Text>
      </Card>
    </>
  );
}
