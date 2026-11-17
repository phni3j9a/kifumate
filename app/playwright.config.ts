import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/web',
  timeout: 90000,
  expect: { timeout: 15000 },
  workers: 1,
  outputDir: '.local/playwright',
  use: { baseURL: 'http://localhost:8081', viewport: { width: 393, height: 852 }, screenshot: 'only-on-failure', video: 'retain-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'npx expo start --web --port 8081', url: 'http://localhost:8081', reuseExistingServer: true, timeout: 120000 },
});
