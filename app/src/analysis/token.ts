import * as SecureStore from "expo-secure-store";
// 接続先ごとに分離。iOSでも移行しないKeychain項目として保存する。
import { API_URL } from "./environment";
import { deviceStorageKey } from "./config";
const key = deviceStorageKey(API_URL);
export const tokenStore = {
  get: () => SecureStore.getItemAsync(key),
  set: (token: string) =>
    SecureStore.setItemAsync(key, token, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
};
