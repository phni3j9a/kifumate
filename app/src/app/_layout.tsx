import { Suspense } from "react";
import { Stack, type ErrorBoundaryProps } from "expo-router";
import { SQLiteProvider } from "expo-sqlite";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { colors, Button, Label, Page } from "../components/ui";
import { migrate } from "../storage/schema";
export const unstable_settings = { anchor: "(tabs)" };
export function ErrorBoundary({ retry }: ErrorBoundaryProps) {
  return (
    <Page>
      <Label title>開けませんでした</Label>
      <Label>端末内のデータは消していません。もう一度お試しください。</Label>
      <Button onPress={retry}>もう一度</Button>
    </Page>
  );
}
export default function Layout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <Suspense
        fallback={
          <Page>
            <Label>棋譜を読み込んでいます…</Label>
          </Page>
        }
      >
        <SQLiteProvider databaseName="kifumate.db" onInit={migrate} useSuspense>
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: colors.background },
              headerTintColor: colors.ink,
              headerTitleStyle: { fontWeight: "800" },
              contentStyle: { backgroundColor: colors.background },
              headerBackButtonDisplayMode: "minimal",
            }}
          >
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen
              name="import"
              options={{ title: "棋譜を取り込む", presentation: "modal" }}
            />
            <Stack.Screen name="game/[id]" options={{ title: "対局" }} />
            <Stack.Screen name="names" options={{ title: "自分の対局者名" }} />
            <Stack.Screen name="info" options={{ title: "対局情報" }} />
            <Stack.Screen
              name="export"
              options={{ title: "KIFを書き出す", presentation: "modal" }}
            />
            <Stack.Screen name="licenses" options={{ title: "ライセンス" }} />
          </Stack>
        </SQLiteProvider>
      </Suspense>
    </SafeAreaProvider>
  );
}
