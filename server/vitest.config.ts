import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
export default defineConfig({
  plugins: [cloudflareTest({
    main: './src/index.ts',
    miniflare: {
      compatibilityDate: '2026-11-01', compatibilityFlags: ['nodejs_compat'],
      durableObjects: {DEVICES: {className: 'Device', useSQLite: true}, INVITATIONS: {className: 'Invitations', useSQLite: true}},
      ratelimits: {TEST_LIMITER: {simple: {limit: 2, period: 60}, namespace_id: '99'}, ...Object.fromEntries(['REGISTRATION_LIMITER', 'API_LIMITER', 'WRITE_LIMITER', 'INVITE_LIMITER'].map((name, i) => [name, {simple: {limit: 10000, period: 60}, namespace_id: String(i + 1)}]))},
      bindings: {ENVIRONMENT: 'staging', ALLOW_DEV_PAID: 'true', COACH_SIGNING_KEY: 'test-only-signing-key', COACH_PROVIDER: 'fake'},
    },
  })],
  test: {include: ['test/**/*.test.ts']},
});
