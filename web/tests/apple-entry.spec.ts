import { expect, test, type Page } from '@playwright/test';
import { appleRelay, emailSignIn, providerReturn, socialFixture, workspaceLink } from './social-fixture';

const origin = process.env.RAFIQ_LANDING_PENDING_ORIGIN;
const mode = process.env.RAFIQ_APPLE_FIXTURE;

test.beforeEach(() => {
  test.skip(!origin || !mode, 'Requires the isolated Apple web fixture.');
});

test('direct Apple returns use safe sign-in feedback and preserve the intended destination', async ({ request }) => {
  const response = await request.get(origin
    + '/sign-in/apple/callback?entry=readiness&redirect_url=https%3A%2F%2Foutside.example', { maxRedirects: 0 });
  expect(response.status()).toBe(307);
  expect(response.headers().location).toBe('/sign-in?entry=readiness&apple='
    + (mode === 'off' ? 'unavailable' : 'failed'));
});

function appleButton(page: Page) {
  return page.getByRole('button', { name: 'Continue with Apple' });
}

async function leaveForApple(page: Page, action = appleButton(page)) {
  await action.focus();
  await expect(action).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Synthetic Apple authorization' })).toBeVisible();
  return new URL(new URL(page.url()).searchParams.get('callback')!);
}

test('Apple and Google have independent visibility and leave email and recovery available', async ({ page }, info) => {
  await socialFixture(page, 'apple');
  await page.setViewportSize({ width: 320, height: 790 });
  await page.goto(origin + '/sign-in');
  await expect(page.getByLabel('Email address', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Recover access' })).toBeVisible();
  await expect(appleButton(page)).toHaveCount(mode === 'off' ? 0 : 1);
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(mode === 'open' ? 0 : 1);
  await page.screenshot({ path: info.outputPath('apple-p04-' + mode + '.png') });
  if (mode === 'held') {
    await expect(page.getByRole('link', { name: 'Create account' })).toHaveCount(0);
    await page.goto(origin + '/sign-up');
    await expect(page).toHaveURL(origin + '/');
    return;
  }
  await page.getByRole('link', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Create an account' })).toBeVisible();
  await expect(page.getByLabel('Email address', { exact: true })).toBeVisible();
  await expect(appleButton(page)).toHaveCount(mode === 'off' ? 0 : 1);
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(mode === 'open' ? 0 : 1);
  await page.screenshot({ path: info.outputPath('apple-p02-' + mode + '.png') });
  if (mode === 'off') {
    await page.goto(origin + '/sign-in/apple/callback');
    const notice = page.getByRole('main').getByRole('alert');
    await expect(notice).toHaveText('Apple sign-in is unavailable here. Use email and password.');
    await expect(notice).toBeFocused();
    await emailSignIn(page);
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
    await page.goto(origin + '/account/profile');
    await expect(page.getByLabel('Display name')).toHaveValue('Original owned profile');
    await expect(page.getByRole('button', { name: 'Connect Apple' })).toHaveCount(0);
    await page.goto(origin + '/account/apple/callback');
    await expect(page.getByRole('main').getByRole('alert')).toHaveText('Connecting Apple is unavailable here.');
  }
});

test('canceled and refused Apple signup return to sign-in with accessible retry and email fallback', async ({ page }, info) => {
  test.skip(mode !== 'open', 'Requires Apple test signup.');
  await socialFixture(page, 'apple');
  await page.goto(origin + '/sign-up');
  await providerReturn(page, 'cancelled', await leaveForApple(page));
  await expect(page).toHaveURL(origin + '/sign-in?apple=cancelled');
  const notice = page.getByRole('main').getByRole('alert');
  await expect(notice).toHaveText('Apple sign-in was canceled. Try again or use email and password.');
  await expect(notice).toBeFocused();
  await expect(appleButton(page)).toHaveAccessibleDescription(/was canceled/);
  await page.screenshot({ path: info.outputPath('apple-p04-cancelled.png') });
  await providerReturn(page, 'failed', await leaveForApple(page));
  await expect(page).toHaveURL(origin + '/sign-in?apple=failed');
  await expect(notice).toHaveText('Apple sign-in didn’t finish. Try again or use email and password.');
  await emailSignIn(page);
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
});

test('a genuinely new Apple driver accepts current conditions before accessing their workspace', async ({ page }, info) => {
  test.skip(mode !== 'open', 'Requires Apple test signup.');
  await socialFixture(page, 'apple');
  await page.goto(origin + '/sign-in?entry=profile');
  await providerReturn(page, 'new', await leaveForApple(page));
  await expect(page.getByRole('heading', { name: 'Controlled-use onboarding' })).toBeVisible();
  await expect(page.getByLabel('Display name')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('apple-p06-conditions.png') });
  await page.getByRole('checkbox', { name: 'I accept the current controlled-use conditions.' }).check();
  await page.getByRole('button', { name: 'Accept and continue' }).click();
  await expect(page).toHaveURL(origin + '/account/profile');
  await expect(page.getByText(appleRelay, { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /administration|staff/i })).toHaveCount(0);
  await page.goto(origin + '/account/links/' + workspaceLink);
  await expect(page.getByText('This item is unavailable.')).toBeVisible();
});

test('a driver verifies a different Apple relay on the existing account and returns to its owned workspace', async ({ page }, info) => {
  test.skip(mode === 'off', 'Requires enabled Apple.');
  await socialFixture(page, 'apple');
  await page.goto(origin + '/sign-in?entry=profile');
  if (mode === 'held') {
    await providerReturn(page, 'new', await leaveForApple(page));
    await expect(page).toHaveURL(origin + '/sign-in?entry=profile&apple=signup-held');
    await expect(page.getByRole('main').getByRole('alert')).toHaveText(/Public signup is pending release/);
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
  }

  await emailSignIn(page);
  await expect(page.getByLabel('Display name')).toHaveValue('Original owned profile');
  await expect(page.getByText('driver@example.test', { exact: true })).toBeVisible();
  const link = page.getByRole('button', { name: 'Connect Apple' });
  const refused = await leaveForApple(page, link);
  await providerReturn(page, 'cancelled', refused);
  const notice = page.getByRole('main').getByRole('alert');
  await expect(notice).toHaveText('Apple connection was canceled. You can try again.');
  await expect(notice).toBeFocused();
  await expect(link).toHaveAccessibleDescription(/was canceled/);
  await page.screenshot({ path: info.outputPath('apple-profile-cancelled.png') });

  const callback = await leaveForApple(page, link);
  expect(callback.pathname).toBe('/account/apple/callback');
  await providerReturn(page, 'link-verified', callback);
  await expect(page).toHaveURL(origin + '/account/profile?appleLink=connected');
  await expect(page.getByRole('status').filter({ hasText: 'Apple is connected to your RAFIQ account.' })).toBeVisible();
  await expect(page.getByLabel('Display name')).toHaveValue('Original owned profile');
  await expect(page.getByText('driver@example.test', { exact: true })).toBeVisible();
  await expect(link).toHaveCount(0);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.goto(origin + '/sign-in?entry=profile');
  await providerReturn(page, 'returning', await leaveForApple(page));
  await expect(page).toHaveURL(origin + '/account/profile');
  await expect(page.getByLabel('Display name')).toHaveValue('Original owned profile');
  await page.goto(origin + '/account/links/' + workspaceLink);
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
});

test('direct, expired, replayed, and switched-session Apple returns cannot complete sign-in or linking', async ({ page, request }) => {
  test.skip(mode !== 'open', 'Requires enabled Apple.');
  const { switchDriverSession } = await socialFixture(page, 'apple');
  const uuid = 'abf906df-9c96-4ccc-af9c-cf01e1f8c0f2';
  const directLink = await request.get(origin + '/account/apple/callback?attempt=' + uuid, { maxRedirects: 0 });
  expect(directLink.headers().location).toBe('/sign-in?entry=profile');
  const routing = await request.get(origin + '/sign-in/apple/callback?__clerk_redirect_url=/account', { maxRedirects: 0 });
  expect(new URL(routing.headers().location, origin).href).toBe(origin + '/sign-in?apple=failed');
  await page.goto(origin + '/sign-in/apple/callback?attempt=' + uuid + '&fixture=new');
  await expect(page).toHaveURL(origin + '/sign-in?apple=failed');
  const stale = await leaveForApple(page);
  await page.clock.setFixedTime(new Date(Date.now() + 16 * 60 * 1000));
  await providerReturn(page, 'new', stale);
  await expect(page).toHaveURL(origin + '/sign-in?apple=failed');

  await page.goto(origin + '/sign-in?entry=profile');
  await emailSignIn(page);
  const callback = await leaveForApple(page, page.getByRole('button', { name: 'Connect Apple' }));
  await providerReturn(page, 'failed', callback);
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Apple couldn’t be connected. Try again from Profile.');
  await providerReturn(page, 'link-verified', callback);
  await expect(page).toHaveURL(origin + '/account/profile?appleLink=failed');
  const link = page.getByRole('button', { name: 'Connect Apple' });
  const newer = await leaveForApple(page, link);
  await switchDriverSession();
  await providerReturn(page, 'link-verified', newer);
  await expect(page).toHaveURL(origin + '/account/profile?appleLink=failed');
  await expect(link).toBeEnabled();
});

test('P05 sends a synthetic relay address through the standard account-safe recovery route', async ({ page }, info) => {
  test.skip(mode !== 'open', 'Requires the Apple recovery fixture.');
  await socialFixture(page, 'apple');
  await page.goto(origin + '/sign-in?entry=profile');
  await page.getByRole('link', { name: 'Recover access' }).click();
  await expect(page).toHaveURL(origin + '/sign-in/recover?entry=profile');
  await page.getByLabel('Email address').fill(appleRelay);
  await page.getByRole('button', { name: 'Request reset code' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'If that address can receive a reset code' })).toBeVisible();
  await expect(page.getByLabel('Reset code')).toBeFocused();
  await page.screenshot({ path: info.outputPath('apple-p05-recovery.png') });
});
