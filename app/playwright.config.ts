import { defineConfig } from "@playwright/test";
const url = process.env.APP_URL || "http://localhost:8081";
export default defineConfig({
  testDir: "./tests/web",
  timeout: 90000,
  expect: { timeout: 15000 },
  workers: 1,
  projects: [360, 393, 430].map((width) => ({
    name: String(width),
    use: { viewport: { width, height: 852 } },
  })),
  outputDir: ".local/playwright",
  use: {
    baseURL: url,
    viewport: { width: 393, height: 852 },
    screenshot: "only-on-failure",
    video: "on",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `EXPO_PUBLIC_ANALYSIS_URL=http://127.0.0.1:18090 npx expo start --web --port ${new URL(url).port}`,
    url,
    reuseExistingServer: true,
    timeout: 120000,
  },
});
