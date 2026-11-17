import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
export default defineConfig({
  plugins: [cloudflareTest({
    main: './src/index.ts',
    miniflare: {
      compatibilityDate: '2026-11-01', compatibilityFlags: ['nodejs_compat'],
      durableObjects: {DEVICES: {className: 'Device', useSQLite: true}},
      bindings: {ENVIRONMENT: 'staging', ALLOW_DEV_PAID: 'true', COACH_SIGNING_KEY: 'test-only-signing-key', COACH_PROVIDER: 'fake'},
    },
  })],
  test: {include: ['test/**/*.test.ts']},
});
