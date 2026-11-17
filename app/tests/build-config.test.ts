import configure from "../app.config";
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
const eas = JSON.parse(
  readFileSync(new URL("../eas.json", import.meta.url), "utf8"),
);

test("配布APKと将来のAABはリリース・本番・EAS署名と連番を使う", () => {
  assert.equal(app.version, "0.1.0");
  assert.equal(app.android.package, "com.quarterlambda.kifumate");
  assert.equal(app.owner, "asitaka.k");
  assert.match(app.extra.eas.projectId, /^[0-9a-f-]{36}$/);
  assert.equal(eas.cli.appVersionSource, "remote");
  assert.equal(eas.build.development.developmentClient, true);
  assert.equal(eas.build.development.env.EXPO_PUBLIC_ANALYSIS_URL, STAGING_URL);
  assert.equal(eas.build.apk.developmentClient, undefined);
  assert.equal(eas.build.apk.autoIncrement, true);
  assert.equal(eas.build.apk.android.buildType, "apk");
  assert.equal(eas.build.apk.android.credentialsSource, "remote");
  assert.equal(eas.build.apk.env.EXPO_PUBLIC_ANALYSIS_URL, PRODUCTION_URL);
  assert.equal(analysisUrl(false, STAGING_URL), PRODUCTION_URL);
  assert.equal(eas.build.production.extends, "apk");
  assert.equal(eas.build.production.android.buildType, "app-bundle");
  assert.equal(app.android.versionCode, undefined);
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
  ]) {
    assert.ok(
      app.android.blockedPermissions.includes(
        `android.permission.${permission}`,
      ),
    );
  }
});

test("開発プロファイルだけ別IDにし、既定と配布版のID・名前を保つ", () => {
  const previous = process.env.APP_VARIANT;
  try {
    for (const profile of [undefined, ...Object.keys(eas.build)]) {
      const variant =
        profile === undefined ? undefined : eas.build[profile].env?.APP_VARIANT;
      if (variant === undefined) delete process.env.APP_VARIANT;
      else process.env.APP_VARIANT = variant;
      const config = configure({
        config: app,
        projectRoot: "",
        staticConfigPath: null,
        packageJsonPath: null,
      });
      const development = profile === "development";
      const id = development
        ? "com.quarterlambda.kifumate.development"
        : "com.quarterlambda.kifumate";
      assert.equal(config.android?.package, id);
      assert.equal(config.ios?.bundleIdentifier, id);
      assert.equal(config.name, development ? "kifumate（開発）" : "kifumate");
    }
  } finally {
    if (previous === undefined) delete process.env.APP_VARIANT;
    else process.env.APP_VARIANT = previous;
  }
});
