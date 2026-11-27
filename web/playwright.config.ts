import { defineConfig } from '@playwright/test';

const localLanding = process.env.RAFIQ_LANDING_LOCAL === '1';
const landingOrigin = 'http://127.0.0.1:3125';
if (localLanding) process.env.RAFIQ_LANDING_PENDING_ORIGIN = landingOrigin;

export default defineConfig({
  testDir: './tests',
  use: { browserName: 'chromium', channel: process.env.RAFIQ_BROWSER_CHANNEL },
  webServer: localLanding ? {
    command: 'node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3125',
    url: landingOrigin + '/healthz',
    env: { RAFIQ_ACCOUNT_ENTRY: 'true', RAFIQ_SIGNUP_MODE: 'closed', NEXT_TELEMETRY_DISABLED: '1' },
  } : undefined,
});
