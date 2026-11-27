import { defineConfig } from '@playwright/test';

const localLanding = process.env.RAFIQ_LANDING_LOCAL === '1';
const landingOrigin = 'http://localhost:3128';
if (localLanding) process.env.RAFIQ_LANDING_PENDING_ORIGIN = landingOrigin;

export default defineConfig({
  testDir: './tests',
  use: { browserName: 'chromium', channel: process.env.RAFIQ_BROWSER_CHANNEL },
  webServer: localLanding ? {
    command: 'node node_modules/next/dist/bin/next start --hostname localhost --port 3128',
    url: landingOrigin + '/healthz',
    reuseExistingServer: !process.env.CI,
    env: {
      RAFIQ_ACCOUNT_ENTRY: 'true', RAFIQ_SIGNUP_MODE: 'closed', NEXT_TELEMETRY_DISABLED: '1',
      CLERK_TELEMETRY_DISABLED: '1', CLERK_SECRET_KEY: 'sk_fixture-only',
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_live_' + Buffer.from('clerk.example.test$').toString('base64'),
    },
  } : undefined,
});
