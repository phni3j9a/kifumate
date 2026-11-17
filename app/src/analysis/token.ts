import * as SecureStore from "expo-secure-store";
// 接続先ごとに分離。iOSでも移行しないKeychain項目として保存する。
const key =
  "analysis-device-" +
  encodeURIComponent(process.env.EXPO_PUBLIC_ANALYSIS_URL || "").replace(
    /[^a-zA-Z0-9._-]/g,
    "_",
  );
export const tokenStore = {
  get: () => SecureStore.getItemAsync(key),
  set: (token: string) =>
    SecureStore.setItemAsync(key, token, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
};
