import { defineConfig } from "@playwright/test";
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
    baseURL: "http://localhost:8081",
    viewport: { width: 393, height: 852 },
    screenshot: "only-on-failure",
    video: "on",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npx expo start --web --port 8081",
    url: "http://localhost:8081",
    reuseExistingServer: true,
    timeout: 120000,
  },
});
