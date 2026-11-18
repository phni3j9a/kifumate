import { Suspense, useEffect } from "react";
import * as SplashScreen from "expo-splash-screen";
import { useFonts } from "expo-font";
import {
  Stack,
  router,
  usePathname,
  type ErrorBoundaryProps,
} from "expo-router";
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
import { ClassificationsProvider } from "../components/classifications-provider";
import { migrate } from "../storage/schema";
import { DataProvider, useAppData } from "../components/data-provider";
void SplashScreen.preventAutoHideAsync();
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
  useEffect(() => {
    if (loaded || failed) void SplashScreen.hideAsync();
  }, [loaded, failed]);
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
          <DataProvider>
            <DataRoutes />
          </DataProvider>
        </SQLiteProvider>
      </Suspense>
      <ToastHost />
      <DialogHost />
    </SafeAreaProvider>
  );
}
function DataRoutes() {
  const { completed } = useAppData();
  const path = usePathname();
  useEffect(() => {
    if (!completed && path !== "/onboarding" && path !== "/backup")
      router.replace("/onboarding");
  }, [completed, path]);
  return (
    <ClassificationsProvider>
      <AnalysisProvider>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.bg },
          }}
        >
          <Stack.Screen name="(tabs)" />
          {[
            "about",
            "legal",
            "licenses",
            "names",
            "profile",
            "info",
            "invitation",
            "plan",
            "records",
            "game/[id]",
          ].map((name) => (
            <Stack.Screen key={name} name={name} />
          ))}
          <Stack.Screen
            name="import"
            options={{ animation: "slide_from_bottom" }}
          />
          <Stack.Screen
            name="onboarding"
            options={{ gestureEnabled: false, animation: "none" }}
          />
          <Stack.Screen name="backup" />
        </Stack>
      </AnalysisProvider>
    </ClassificationsProvider>
  );
}
