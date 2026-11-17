import type { ConfigContext, ExpoConfig } from "expo/config";

export default ({ config }: ConfigContext): ExpoConfig => {
  if (process.env.APP_VARIANT !== "development") {
    return {
      ...config,
      plugins: [
        ...(config.plugins ?? []),
        ["expo-build-properties", { android: { buildArchs: ["arm64-v8a"] } }],
      ],
    } as ExpoConfig;
  }
  return {
    ...config,
    name: "kifumate（開発）",
    slug: "kifumate",
    android: {
      ...config.android,
      package: "com.quarterlambda.kifumate.development",
    },
    ios: {
      ...config.ios,
      bundleIdentifier: "com.quarterlambda.kifumate.development",
    },
  };
};
