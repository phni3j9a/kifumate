import { Text } from "react-native";
import { MIT, OFL } from "../components/license-texts";
import { colors, font } from "../components/theme";
import {
  Card,
  PageHeader,
  PageScroll,
  Screen,
  SectionTitle,
} from "../components/ui";
const items = [
  [
    "将棋のルールと棋譜の読み書き：tsshogi（MIT）",
    "Copyright (c) 2023 Kubo, Ryosuke",
  ],
  [
    "文字コードの変換：encoding-japanese（MIT）",
    "Copyright (c) 2012-present polygonplanet",
  ],
  [
    "盤・駒・アイコンの描画：react-native-svg（MIT）",
    "Copyright (c) [2015-2016] [Horcrux]",
  ],
  [
    "書体：Zen Maru Gothic（SIL Open Font License 1.1）",
    "Copyright 2021 The Zen Maru Gothic Project Authors",
  ],
];
export default function Licenses() {
  const body = font(500, 11, 1.6, colors.ink2);
  return (
    <Screen>
      <PageHeader title="ライセンス" />
      <PageScroll>
        <Card style={{ paddingVertical: 11, paddingHorizontal: 14, gap: 8 }}>
          {items.map(([title, copyright]) => (
            <Text key={title} selectable style={font(700, 12.5, 1.5)}>
              {title}
              {"\n"}
              <Text style={body}>{copyright}</Text>
            </Text>
          ))}
        </Card>
        <SectionTitle>MIT License</SectionTitle>
        <Text selectable style={[body, { marginHorizontal: 4 }]}>
          {MIT}
        </Text>
        <SectionTitle>SIL Open Font License 1.1</SectionTitle>
        <Text selectable style={[body, { marginHorizontal: 4 }]}>
          {OFL}
        </Text>
      </PageScroll>
    </Screen>
  );
}
