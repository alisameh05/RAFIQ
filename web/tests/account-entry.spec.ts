import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const base = process.env.RAFIQ_ACCOUNT_E2E_URL;
const mode = process.env.RAFIQ_ACCOUNT_E2E_MODE;
const providerOrigin = process.env.RAFIQ_ACCOUNT_E2E_CLERK_ORIGIN;
const testingToken = process.env.RAFIQ_ACCOUNT_E2E_CLERK_TOKEN;

function setup(page: Page) {
  if (!base || !providerOrigin || !testingToken) throw new Error('Configure the isolated account entry browser run.');
  const origin = new URL(providerOrigin);
  if (origin.origin !== providerOrigin || origin.protocol !== 'https:' || !origin.hostname.endsWith('.clerk.accounts.dev')) {
    throw new Error('Use a Clerk development Frontend API origin.');
  }
  return page.route(providerOrigin + '/v1/**', async (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set('__clerk_testing_token', testingToken);
    await route.continue({ url: url.href });
  });
}

test('an external driver corrects and verifies email and resolves the same account after reload', async ({ page, context }) => {
  test.skip(!base || mode !== 'open', 'Requires the isolated Open Clerk development instance.');
  test.setTimeout(90_000);
  await setup(page);
  const id = randomUUID();
  const firstEmail = 'first+clerk_test_' + id + '@example.net';
  const correctedEmail = 'driver+clerk_test_' + id + '@example.net';
  await page.setViewportSize({ width: 320, height: 760 });
  await page.goto(base!);
  await page.getByRole('link', { name: 'Create account' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Create an account' })).toBeVisible();
  await page.getByLabel('Email address', { exact: true }).fill(firstEmail);
  await page.getByLabel('Password', { exact: true }).fill('a');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Email address', { exact: true })).toHaveValue(firstEmail);
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  await page.getByLabel('Password', { exact: true }).fill('Open-Road-' + id);
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
  await expect(page.getByText(firstEmail, { exact: true })).toBeVisible();
  const code = page.getByRole('textbox', { name: 'Verification code' });
  await expect(code).toBeFocused();
  await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
  expect(await code.evaluate((field) => getComputedStyle(field).outlineStyle)).toBe('solid');
  await expect(page.getByRole('button', { name: 'Resend verification' })).toHaveAttribute('aria-disabled', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);

  await code.fill('111111');
  await page.getByRole('button', { name: 'Verify email' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('incorrect');
  await page.getByRole('button', { name: 'Change email' }).click();
  await page.getByLabel('Corrected email address').fill(correctedEmail);
  await page.getByRole('button', { name: 'Send code', exact: true }).click();
  await expect(page.getByText(correctedEmail, { exact: true })).toBeVisible();
  await expect(page.getByText(firstEmail, { exact: true })).toHaveCount(0);
  await expect(code).toHaveValue('');
  await expect(code).toBeFocused();

  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => navigator.clipboard.writeText('424 242'));
  await code.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
  await expect(code).toHaveValue('424242');
  await expect(page.getByRole('link', { name: /dashboard|sessions|workspace/i })).toHaveCount(0);
  const firstResolution = page.waitForResponse((response) =>
    response.request().method() === 'GET' && response.url().endsWith('/api/v1/account') && response.ok());
  await code.press('Enter');
  const first = await (await firstResolution).json();
  await expect(page.getByRole('heading', { name: 'Controlled-use onboarding' })).toBeVisible();
  await expect(page.getByRole('main').getByRole('status')).toHaveText('Email verified');
  const retriedResolution = page.waitForResponse((response) =>
    response.request().method() === 'GET' && response.url().endsWith('/api/v1/account') && response.ok());
  await page.reload();
  const retried = await (await retriedResolution).json();
  expect(retried.accountId).toEqual(first.accountId);
  await expect(page.getByRole('heading', { name: 'Controlled-use onboarding' })).toBeVisible();
  await expect(page.getByText('Email verified', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /dashboard|sessions|workspace/i })).toHaveCount(0);
});

test('closed signup preserves sign in and Clerk declines direct enrollment', async ({ page }) => {
  test.skip(!base || mode !== 'closed', 'Requires the isolated Invite-only Clerk development instance.');
  await setup(page);
  await page.goto(base!);
  const header = page.getByRole('banner');
  await expect(header.getByText('Public signup is pending release.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create account' })).toHaveCount(0);
  await page.goto(new URL('/sign-up', base).href);
  await expect(header.getByText('Public signup is pending release.')).toBeVisible();
  await header.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  await expect(page.getByRole('button', { name: /continue/i }).first()).toBeVisible();
  const outcome = await page.evaluate(async (emailAddress) => {
    const clerk = (window as unknown as { Clerk: {
      client: { signUp: { create: (fields: { emailAddress: string; password: string }) => Promise<unknown> } };
    } }).Clerk;
    try {
      await clerk.client.signUp.create({ emailAddress, password: 'Synthetic-Account-Password!42' });
      return 'accepted';
    } catch (error) {
      return (error as { errors?: { code?: string }[] }).errors?.[0]?.code;
    }
  }, 'closed+clerk_test_' + randomUUID() + '@example.net');
  expect(outcome).toBe('sign_up_mode_restricted');
});
