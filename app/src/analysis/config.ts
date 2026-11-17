export const STAGING_URL =
  "https://kifumate-analysis-staging.yuki-nakano-1020.workers.dev";
export const PRODUCTION_URL = "https://kifumate-api.quarterlambda.com";
export function analysisUrl(development: boolean, override?: string) {
  return development
    ? (override || STAGING_URL).replace(/\/+$/, "")
    : PRODUCTION_URL;
}
export function deviceStorageKey(base: string) {
  return (
    "analysis-device-" +
    encodeURIComponent(base).replace(/[^a-zA-Z0-9._-]/g, "_")
  );
}
