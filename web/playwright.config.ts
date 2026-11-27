import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { defineConfig } from '@playwright/test';

const localLanding = process.env.RAFIQ_LANDING_LOCAL === '1';
const landingPort = Number(process.env.RAFIQ_LANDING_LOCAL_PORT ?? 3128);
const landingOrigin = 'http://localhost:' + landingPort;
if (localLanding) {
  process.env.RAFIQ_LANDING_PENDING_ORIGIN = landingOrigin;
  process.env.RAFIQ_LOCAL_CLERK_KEY ??= generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
}

export default defineConfig({
  testDir: './tests',
  use: { browserName: 'chromium', channel: process.env.RAFIQ_BROWSER_CHANNEL },
  webServer: localLanding ? {
    command: 'node node_modules/next/dist/bin/next start --hostname localhost --port ' + landingPort,
    url: landingOrigin + '/healthz',
    reuseExistingServer: !process.env.CI,
    env: {
      RAFIQ_ACCOUNT_ENTRY: 'true', RAFIQ_SIGNUP_MODE: 'closed', NEXT_TELEMETRY_DISABLED: '1',
      CLERK_TELEMETRY_DISABLED: '1', CLERK_SECRET_KEY: 'sk_fixture-only',
      CLERK_JWT_KEY: process.env.RAFIQ_LOCAL_CLERK_KEY
        ? createPublicKey(process.env.RAFIQ_LOCAL_CLERK_KEY).export({ type: 'spki', format: 'pem' }).toString()
        : '',
      RAFIQ_ACCOUNT_API_ORIGIN: 'https://accounts.example.test',
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_live_' + Buffer.from('clerk.example.test$').toString('base64'),
    },
  } : undefined,
});
