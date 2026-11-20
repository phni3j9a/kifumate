import configure, { versionCode } from "../app.config";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PRODUCTION_URL,
  STAGING_URL,
  analysisUrl,
} from "../src/analysis/config";

const app = JSON.parse(
  readFileSync(new URL("../app.json", import.meta.url), "utf8"),
).expo;

function configFor(variant?: string) {
  const previous = process.env.APP_VARIANT;
  try {
    if (variant === undefined) delete process.env.APP_VARIANT;
    else process.env.APP_VARIANT = variant;
    return configure({
      config: app,
      projectRoot: "",
      staticConfigPath: null,
      packageJsonPath: null,
    });
  } finally {
    if (previous === undefined) delete process.env.APP_VARIANT;
    else process.env.APP_VARIANT = previous;
  }
}

test("配布APKはリリースID・本番URL・版から算出したversionCodeを使う", () => {
  assert.equal(app.version, "0.1.2");
  assert.equal(app.android.package, "com.quarterlambda.kifumate");
  assert.equal(app.android.versionCode, undefined);
  assert.equal(analysisUrl(false, STAGING_URL), PRODUCTION_URL);
  assert.equal(configFor("production").android?.versionCode, 1002);
  assert.equal(versionCode("1.2.3"), 1_002_003);
  for (const bad of ["0.1", "0.1.0-rc.1", "01.0.0", "0.1000.0", ""]) {
    assert.throws(() => versionCode(bad));
  }
  const script = readFileSync(
    new URL("../scripts/build-android-release.sh", import.meta.url),
    "utf8",
  );
  assert.ok(script.includes(`EXPO_PUBLIC_ANALYSIS_URL=${PRODUCTION_URL}`));
  assert.match(script, /APP_VARIANT=production/);
});

test("起動画面・通常/アダプティブアイコンと不要権限の除外を設定する", () => {
  const splash = app.plugins.find(
    (plugin: unknown) =>
      Array.isArray(plugin) && plugin[0] === "expo-splash-screen",
  )[1];
  for (const file of [
    app.icon,
    app.android.adaptiveIcon.foregroundImage,
    splash.image,
  ]) {
    const png = readFileSync(new URL(`../${file}`, import.meta.url));
    assert.equal(png.toString("ascii", 1, 4), "PNG");
    assert.ok(png.readUInt32BE(16) >= 600);
  }
  assert.equal(app.android.allowBackup, false);
  for (const permission of [
    "READ_EXTERNAL_STORAGE",
    "WRITE_EXTERNAL_STORAGE",
    "RECORD_AUDIO",
    "SYSTEM_ALERT_WINDOW",
    "READ_MEDIA_IMAGES",
    "READ_MEDIA_VIDEO",
    "READ_MEDIA_AUDIO",
    "VIBRATE",
    "USE_BIOMETRIC",
    "USE_FINGERPRINT",
  ]) {
    assert.ok(
      app.android.blockedPermissions.includes(
        `android.permission.${permission}`,
      ),
    );
  }
});

test("開発版だけ別IDにし、既定と配布版のID・名前を保つ", () => {
  for (const variant of [undefined, "production", "development"]) {
    const config = configFor(variant);
    const development = variant === "development";
    const id = development
      ? "com.quarterlambda.kifumate.development"
      : "com.quarterlambda.kifumate";
    assert.equal(config.android?.package, id);
    assert.equal(config.ios?.bundleIdentifier, id);
    assert.equal(config.name, development ? "kifumate（開発）" : "kifumate");
    const buildProperties = config.plugins?.find(
      (plugin) =>
        Array.isArray(plugin) && plugin[0] === "expo-build-properties",
    );
    assert.deepEqual(
      buildProperties,
      development
        ? undefined
        : [
            "expo-build-properties",
            { android: { buildArchs: ["arm64-v8a"] } },
          ],
    );
  }
});

test("既定の起動はExpo Go・開発クライアントは明示した別コマンドだけ", () => {
  const { scripts } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  for (const name of ["start", "android", "web"]) {
    assert.match(scripts[name], /\bexpo start\b.*--go\b/);
    assert.doesNotMatch(scripts[name], /--dev-client\b/);
  }
  assert.match(
    scripts["start:dev"],
    /^APP_VARIANT=development expo start --dev-client$/,
  );
});
