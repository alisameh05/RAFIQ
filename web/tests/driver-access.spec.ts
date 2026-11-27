import { expect, test } from '@playwright/test';

const origin = process.env.RAFIQ_LANDING_PENDING_ORIGIN;
const known = 'driver@example.net';

test.beforeEach(async ({ page }) => {
  test.skip(process.env.RAFIQ_LANDING_LOCAL !== '1' || !origin, 'Requires the isolated local web fixture.');
  await page.route('https://clerk.example.test/**', (route) => route.abort());
  await page.addInitScript(({ known }) => {
    class ProviderError {
      static kind = 'ClerkAPIResponseError';
      errors;
      constructor(code: string, readonly status = 400, readonly retryAfter = 0) {
        this.errors = [{ code }];
      }
    }
    let requested = '';
    let sends = 0;
    const ok = { error: null };
    const fail = (code: string, status?: number, retryAfter?: number) => ({ error: new ProviderError(code, status, retryAfter) });
    const signIn = {
      status: 'needs_identifier',
      supportedSecondFactors: [{ strategy: 'email_code', safeIdentifier: known }],
      async password({ emailAddress, password }: { emailAddress: string; password: string }) {
        if (emailAddress === 'verified@example.net' && password === 'Verified-Road-42') {
          signIn.status = 'complete';
          return ok;
        }
        if (emailAddress !== known || password !== 'Fixture-Road-42') return fail('form_password_incorrect');
        signIn.status = 'needs_second_factor';
        return ok;
      },
      async reset() { signIn.status = 'needs_identifier'; return ok; },
      async create({ identifier }: { identifier: string }) {
        requested = identifier;
        return identifier === 'unknown@example.net' || identifier === known ? ok : fail('form_identifier_not_found');
      },
      mfa: {
        async sendEmailCode() { return ok; },
        async verifyEmailCode() { signIn.status = 'complete'; return ok; },
      },
      async finalize({ navigate }: { navigate: (state: { session: object; decorateUrl: (path: string) => string }) => void }) {
        navigate({ session: {}, decorateUrl: (path) => path });
        return ok;
      },
      resetPasswordEmailCode: {
        async sendCode() {
          if (requested === 'unknown@example.net') return { error: { constructor: { kind: 'ClerkRuntimeError' }, code: 'factor_not_found' } };
          if (requested === known && ++sends === 2) return fail('verification_code_too_many_requests', 429, 45);
          return ok;
        },
        async verifyCode({ code }: { code: string }) {
          if (code === '222222') return fail('verification_expired');
          if (code !== '424242') return fail('form_code_incorrect');
          signIn.status = 'needs_new_password';
          return ok;
        },
        async submitPassword() {
          signIn.status = 'complete';
          return ok;
        },
      },
    };
    const client = { signIn, sessions: [] };
    const resources = { client, session: null, user: null, organization: null };
    const snapshot = { signIn, fetchStatus: 'idle', errors: {} };
    Object.defineProperty(window, 'Clerk', { value: {
      loaded: true, ...resources,
      __internal_lastEmittedResources: resources,
      __internal_state: {
        signInSignal: () => snapshot,
        __internal_effect(effect: () => void) { effect(); return () => {}; },
      },
      on(event: string, listener: (status: string) => void) {
        if (event === 'status') queueMicrotask(() => listener('ready'));
      },
      off() {},
      addListener(listener: (resources: object) => void) {
        queueMicrotask(() => listener(resources));
        return () => {};
      },
    } });
  }, { known });
});

test('a signed-out private entry resumes sign-in and an email challenge can restart', async ({ page }) => {
  await page.goto(origin + '/account');
  await expect(page).toHaveURL(origin + '/sign-in?entry=account');
  await expect(page.getByRole('link', { name: 'Create account' })).toHaveCount(0);
  const email = page.getByLabel('Email address', { exact: true });
  const password = page.getByLabel('Password', { exact: true });
  await email.fill(known);
  await password.fill('rejected-fixture-password');
  await password.press('Enter');
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Check your email and password, then try again.');
  await expect(page.getByRole('main').getByRole('alert')).not.toContainText('rejected-fixture-password');
  await expect(email).toHaveValue(known);
  await expect(password).toHaveValue('');
  await password.fill('Fixture-Road-42');
  await password.press('Enter');
  await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeFocused();
  await expect(page.getByText(known, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Send verification code' }).press('Enter');
  await expect(page.getByLabel('Verification code')).toBeFocused();
  await page.getByRole('button', { name: 'Change email' }).press('Enter');
  await expect(email).toBeFocused();
  await expect(email).toHaveValue(known);

  await email.fill('typo@example.net');
  await password.fill('Fixture-Road-42');
  await password.press('Enter');
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Check your email and password, then try again.');
  await email.fill(known);
  await password.fill('Fixture-Road-42');
  await password.press('Enter');
  await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeFocused();
  await page.getByRole('button', { name: 'Send verification code' }).press('Enter');
  await page.getByLabel('Verification code').fill('424242');
  const gateRequest = page.waitForRequest((request) => request.url() === origin + '/account?entry=account&verified=1');
  await page.getByLabel('Verification code').press('Enter');
  await gateRequest;
  await expect(page).toHaveURL(origin + '/sign-in?entry=account');
});

test('recovery uses generic feedback and restores focus after expiry and throttling', async ({ page }) => {
  await page.clock.install();
  await page.setViewportSize({ width: 320, height: 760 });
  await page.goto(origin + '/sign-in?entry=account');
  await page.getByRole('link', { name: 'Recover access' }).press('Enter');
  await expect(page).toHaveURL(origin + '/sign-in/recover?entry=account');
  const email = page.getByLabel('Email address', { exact: true });
  const code = page.getByLabel('Reset code');
  const status = page.getByRole('main').getByRole('status');
  await email.fill('unknown@example.net');
  await email.press('Enter');
  await expect(code).toBeFocused();
  const genericReply = await status.innerText();
  await code.fill('111111');
  await code.press('Enter');
  const incorrect = await page.getByRole('main').getByRole('alert').innerText();
  await page.getByRole('button', { name: 'Use a different email' }).press('Enter');
  await expect(email).toBeFocused();
  await email.fill(known);
  await email.press('Enter');
  await expect(code).toBeFocused();
  await expect(status).toHaveText(genericReply);
  await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
  await code.fill('111111');
  await code.press('Enter');
  await expect(page.getByRole('main').getByRole('alert')).toHaveText(incorrect);
  await code.fill('222222');
  await code.press('Enter');
  await expect(page.getByRole('main').getByRole('alert')).toContainText('expired');
  const resend = page.getByRole('button', { name: 'Resend code' });
  await expect(resend).toBeFocused();
  await expect(resend).toHaveAttribute('aria-disabled', 'true');
  await page.clock.fastForward(31_000);
  await resend.press('Enter');
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Too many attempts');
  await page.clock.fastForward(31_000);
  await expect(resend).toHaveAttribute('aria-disabled', 'true');
  await page.clock.fastForward(15_000);
  await resend.press('Enter');
  await expect(code).toBeFocused();
  await expect(code).toHaveValue('');
  await code.fill('424242');
  await code.press('Enter');
  const password = page.getByLabel('New password');
  await expect(password).toBeFocused();
  await expect(password).toHaveAccessibleDescription(/Clerk checks the password requirements/);
  await expect(page.getByRole('main')).toMatchAriaSnapshot(`
    - heading "Choose a new password" [level=1]
    - status: Code accepted.
  `);
  await page.setViewportSize({ width: 640, height: 760 });
  await page.locator('html').evaluate((root) => { root.style.zoom = '2'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(640);
  await password.fill('New-Fixture-Road-42');
  await password.press('Enter');
  await expect(status).toHaveText('Password reset.');
  await expect(page.getByRole('heading')).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(640);
  await page.getByRole('link', { name: 'Sign in', exact: true }).press('Enter');
  await expect(page).toHaveURL(origin + '/sign-in?entry=account');
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
});

test('the public sign-in entry and verified password submit use the account gate', async ({ page }) => {
  await page.goto(origin!);
  await page.getByRole('banner').getByRole('link', { name: 'Sign in' }).press('Enter');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  await page.goto(origin + '/sign-in?entry=https%3A%2F%2Foutside.example');
  await expect(page.getByRole('link', { name: 'Recover access' })).toHaveAttribute('href', '/sign-in/recover');
  await page.getByLabel('Email address', { exact: true }).fill('verified@example.net');
  const password = page.getByLabel('Password', { exact: true });
  await password.fill('Verified-Road-42');
  const gateRequest = page.waitForRequest((request) => request.url() === origin + '/account');
  await password.press('Enter');
  await gateRequest;
  await expect(page).toHaveURL(origin + '/sign-in?entry=account');
});
