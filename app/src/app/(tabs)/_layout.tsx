import { Tabs } from "expo-router";
import { colors, Icon } from "../../components/ui";
export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.ink,
        headerTitleStyle: { fontSize: 24, fontWeight: "900" },
        sceneStyle: { backgroundColor: colors.background },
        tabBarActiveTintColor: colors.ink,
        tabBarInactiveTintColor: colors.muted,
        tabBarActiveBackgroundColor: "#FFF0BB",
        tabBarStyle: {
          backgroundColor: colors.white,
          borderTopWidth: 2,
          borderTopColor: colors.ink,
        },
        tabBarLabelStyle: { fontSize: 12, fontWeight: "700" },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "棋譜",
          tabBarIcon: ({ color }) => (
            <Icon
              name="notebook-outline"
              color={typeof color === "string" ? color : colors.ink}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="stats"
        options={{
          title: "戦績",
          tabBarIcon: ({ color }) => (
            <Icon
              name="chart-bar"
              color={typeof color === "string" ? color : colors.ink}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "設定",
          tabBarIcon: ({ color }) => (
            <Icon
              name="cog-outline"
              color={typeof color === "string" ? color : colors.ink}
            />
          ),
        }}
      />
    </Tabs>
  );
}
