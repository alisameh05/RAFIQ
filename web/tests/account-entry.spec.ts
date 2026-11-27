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
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create account' })).toHaveCount(0);
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

test('returning driver resets a password and signs into the same account again', async ({ page }) => {
  test.skip(!base || mode !== 'open', 'Requires the isolated Open Clerk development instance.');
  test.setTimeout(90_000);
  await setup(page);

  const id = randomUUID();
  const email = 'returning+clerk_test_' + id + '@example.net';
  const password = 'Original-Road-' + id;
  const newPassword = 'Updated-Road-' + id;
  const account = async () => {
    const response = await page.waitForResponse((reply) =>
      reply.request().method() === 'GET' && reply.url().endsWith('/api/v1/account') && reply.ok());
    return (await response.json()).accountId;
  };

  await page.goto(new URL('/sign-up', base).href);
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Verification code', { exact: true }).fill('424242');
  const originalAccount = account();
  await page.getByRole('button', { name: 'Verify email' }).click();
  const originalId = await originalAccount;
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create account' })).toBeVisible();

  await page.goto(new URL('/account', base).href);
  await expect(page).toHaveURL(/\/sign-in\?entry=account$/);
  await page.setViewportSize({ width: 320, height: 740 });
  const address = page.getByLabel('Email address', { exact: true });
  await address.fill(email);
  await page.getByLabel('Password', { exact: true }).fill('Wrong-password-42');
  await page.getByLabel('Password', { exact: true }).press('Enter');
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Check your email and password');
  await expect(address).toHaveValue(email);
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');

  await page.getByRole('link', { name: 'Recover access' }).click();
  await expect(page).toHaveURL(/\/sign-in\/recover\?entry=account$/);
  await address.fill('unknown+clerk_test_' + id + '@example.net');
  await address.press('Enter');
  await expect(page.getByLabel('Reset code')).toBeVisible();
  const unknownNotice = await page.getByRole('main').getByRole('status').innerText();
  await page.getByRole('button', { name: 'Use a different email' }).click();
  await expect(address).toBeFocused();
  await address.fill(email);
  await address.press('Enter');
  const code = page.getByLabel('Reset code');
  await expect(code).toBeFocused();
  await expect(page.getByRole('main').getByRole('status')).toHaveText(unknownNotice);
  await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await code.fill('111111');
  await code.press('Enter');
  await expect(page.getByRole('main').getByRole('alert')).toContainText('incorrect');
  await code.fill('424242');
  await code.press('Enter');
  const replacement = page.getByLabel('New password');
  await expect(replacement).toBeFocused();
  await replacement.fill(newPassword);
  await replacement.press('Enter');
  await expect(page.getByRole('main').getByRole('status')).toHaveText('Password reset.');
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in\?entry=account$/);
  await address.fill(email);
  await page.getByLabel('Password', { exact: true }).fill(newPassword);
  const freshAccount = account();
  await page.getByLabel('Password', { exact: true }).press('Enter');
  expect(await freshAccount).toBe(originalId);
  await expect(page.getByRole('heading', { name: 'Controlled-use onboarding' })).toBeVisible();
});

test('an unverified returning identity verifies its registered email before account access', async ({ page }) => {
  const email = process.env.RAFIQ_ACCOUNT_E2E_UNVERIFIED_EMAIL;
  const password = process.env.RAFIQ_ACCOUNT_E2E_UNVERIFIED_PASSWORD;
  test.skip(!base || !email || !password, 'Requires a freshly provisioned unverified Clerk test identity.');
  await setup(page);
  await page.goto(new URL('/account', base!).href);
  await page.getByLabel('Email address', { exact: true }).fill(email!);
  await page.getByLabel('Password', { exact: true }).fill(password!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeFocused();
  await page.getByRole('button', { name: 'Change email' }).press('Enter');
  const address = page.getByLabel('Email address', { exact: true });
  await expect(address).toBeVisible();
  await address.fill(email!);
  await page.getByLabel('Password', { exact: true }).fill(password!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  const submitCode = async () => {
    await page.getByRole('button', { name: 'Send verification code' }).press('Enter');
    const code = page.getByLabel('Verification code');
    await expect(code).toBeFocused();
    await code.fill('424242');
    await code.press('Enter');
  };
  await submitCode();
  // An email challenge at Clerk sign-in can precede the primary-email gate.
  await expect(page).toHaveURL(/\/account/);
  const gate = page.getByRole('heading', { name: 'Verify your email' })
    .or(page.getByRole('heading', { name: 'Controlled-use onboarding' }));
  await expect(gate).toBeVisible();
  if (await page.getByRole('heading', { name: 'Verify your email' }).isVisible()) {
    await expect(page.getByText(email!, { exact: true })).toBeVisible();
    await submitCode();
  }
  await expect(page.getByRole('heading', { name: 'Controlled-use onboarding' })).toBeVisible();
  await expect(page.getByRole('main').getByRole('status')).toHaveText('Email verified');
});
