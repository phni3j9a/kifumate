import { analysisUrl, STAGING_URL } from "./config";
export const API_URL = analysisUrl(
  __DEV__,
  process.env.EXPO_PUBLIC_ANALYSIS_URL,
);
export const ALLOW_DEVELOPMENT_ACCESS = __DEV__ && API_URL === STAGING_URL;
// ストア配布時に切り替える。購入処理の実装は別途必要。
export const DISTRIBUTION: "invite" | "store" = "invite";
