import type { ConfigContext, ExpoConfig } from "expo/config";

// Three decimal digits per component; stable releases only (0.1.0 -> 1000).
export function versionCode(version = "") {
  const parts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
    .exec(version)
    ?.slice(1)
    .map(Number);
  const [major = 0, minor = 0, patch = 0] = parts ?? [];
  if (!parts || parts.some((part) => part > 999)) {
    throw new Error(
      "Android releases require a major.minor.patch version (each component <= 999)",
    );
  }
  return major * 1_000_000 + minor * 1_000 + patch;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  if (process.env.APP_VARIANT !== "development") {
    return {
      ...config,
      android: { ...config.android, versionCode: versionCode(config.version) },
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
