import { Suspense } from "react";
import { useFonts } from "expo-font";
import { Stack, type ErrorBoundaryProps } from "expo-router";
import { SQLiteProvider } from "expo-sqlite";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ZenMaruGothic_500Medium } from "@expo-google-fonts/zen-maru-gothic/500Medium";
import { ZenMaruGothic_700Bold } from "@expo-google-fonts/zen-maru-gothic/700Bold";
import { ZenMaruGothic_900Black } from "@expo-google-fonts/zen-maru-gothic/900Black";
import { DialogHost, ToastHost } from "../components/overlay";
import { colors } from "../components/theme";
import { Button, Problem, Screen } from "../components/ui";
import { AnalysisProvider } from "../analysis/provider";
import { migrate } from "../storage/schema";
export const unstable_settings = { anchor: "(tabs)" };
export function ErrorBoundary({ retry }: ErrorBoundaryProps) {
  return (
    <SafeAreaProvider>
      <Screen>
        <Problem text="開けませんでした。端末内のデータは消していません。もう一度お試しください。">
          <Button onPress={retry}>もう一度</Button>
        </Problem>
      </Screen>
    </SafeAreaProvider>
  );
}
export default function Layout() {
  // 書体が入るまで何も描かない（別の書体で一瞬出て、行の高さが変わるのを避ける）。
  const [loaded, failed] = useFonts({
    ZenMaruGothic_500Medium,
    ZenMaruGothic_700Bold,
    ZenMaruGothic_900Black,
  });
  if (!loaded && !failed) return null;
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <Suspense
        fallback={
          <Screen>
            <Problem text="棋譜を読み込んでいます…" />
          </Screen>
        }
      >
        <SQLiteProvider databaseName="kifumate.db" onInit={migrate} useSuspense>
          <AnalysisProvider>
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: colors.bg },
              }}
            >
              <Stack.Screen name="(tabs)" />
              <Stack.Screen
                name="import"
                options={{ animation: "slide_from_bottom" }}
              />
            </Stack>
          </AnalysisProvider>
        </SQLiteProvider>
      </Suspense>
      <ToastHost />
      <DialogHost />
    </SafeAreaProvider>
  );
}
