import type { ComponentProps } from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Tabs } from "expo-router";
import { Icon, type IconName } from "../../components/icons";
import { colors, font, line, radius } from "../../components/theme";

const icons: Record<string, IconName> = {
  index: "kifu",
  stats: "chart",
  settings: "gear",
};
type TabBarProps = Parameters<
  NonNullable<ComponentProps<typeof Tabs>["tabBar"]>
>[0];
/** タブバー（.tb）。選ばれているタブはアイコンが黄色いピルに入る */
function TabBar({ state, descriptors, emitter, navigateToTab }: TabBarProps) {
  const insets = useSafeAreaInsets();
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: "row",
        height: 58 + insets.bottom,
        paddingBottom: insets.bottom,
        backgroundColor: colors.white,
        borderTopWidth: line.ol,
        borderTopColor: colors.ink,
      }}
    >
      {state.routes.map((route, i) => {
        const on = state.index === i;
        const title = descriptors[route.key]?.options.title ?? route.name;
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            aria-selected={on}
            accessibilityLabel={title}
            onPress={() => {
              const event = emitter.emit({
                type: "tabPress",
                target: route.key,
                canPreventDefault: true,
              });
              if (!on && !event.defaultPrevented) navigateToTab(route.key);
            }}
            style={{
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              gap: 3,
            }}
          >
            <View
              style={{
                width: 48,
                height: 26,
                borderRadius: radius.pill,
                borderWidth: line.ol,
                borderColor: on ? colors.ink : "transparent",
                backgroundColor: on ? colors.you : "transparent",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon
                name={icons[route.name] ?? "kifu"}
                size={19}
                strokeWidth={2.1}
                color={on ? colors.ink : colors.ink2}
              />
            </View>
            <Text
              style={font(
                on ? 900 : 700,
                10.5,
                1,
                on ? colors.ink : colors.ink2,
              )}
            >
              {title}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
export default function TabLayout() {
  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "棋譜" }} />
      <Tabs.Screen name="stats" options={{ title: "戦績" }} />
      <Tabs.Screen name="settings" options={{ title: "設定" }} />
    </Tabs>
  );
}
