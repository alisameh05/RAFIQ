import { expect, test, type Page } from '@playwright/test';
import { emailSignIn, providerReturn, socialFixture, workspaceLink } from './social-fixture';

const origin = process.env.RAFIQ_LANDING_PENDING_ORIGIN;
const mode = process.env.RAFIQ_GOOGLE_FIXTURE;

test.beforeEach(() => {
  test.skip(!origin || !mode, 'Requires the isolated Google web fixture.');
});

function googleButton(page: Page) {
  return page.getByRole('button', { name: 'Continue with Google' });
}

async function leaveForGoogle(page: Page) {
  await expect(googleButton(page)).toBeVisible();
  await googleButton(page).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Synthetic Google authorization' })).toBeVisible();
  return new URL(new URL(page.url()).searchParams.get('callback')!);
}

test('a direct Google return without an attempt goes safely to P04', async ({ request }) => {
  const response = await request.get(origin
    + '/sign-in/google/callback?entry=readiness&redirect_url=https%3A%2F%2Foutside.example', { maxRedirects: 0 });
  expect(response.headers().location).toBe('/sign-in?entry=readiness&google='
    + (mode === 'off' ? 'unavailable' : 'failed'));
  if (mode !== 'off') {
    const alternate = await request.get(origin + '/sign-in/google/callback', {
      headers: { host: '127.0.0.1:' + new URL(origin!).port }, maxRedirects: 0,
    });
    expect(alternate.headers().location).toBe('/sign-in?google=unavailable');
  }
});

test('the callback rejects an unrelated Clerk routing parameter before processing the return', async ({ request }) => {
  const response = await request.get(origin + '/sign-in/google/callback?' + new URLSearchParams({
    __clerk_redirect_url: '/account',
  }), { maxRedirects: 0 });
  expect(response.status()).toBe(307);
  expect(new URL(response.headers().location, origin).href).toBe(origin + '/sign-in?google=failed');
});

test('P02 and P04 show Google only where enabled and preserve email entry', async ({ page }, info) => {
  await socialFixture(page, 'google');
  await page.setViewportSize({ width: 320, height: 790 });
  await page.goto(origin + '/sign-in');
  await expect(page.getByLabel('Email address', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await expect(googleButton(page)).toHaveCount(mode === 'off' ? 0 : 1);
  await expect(page.getByRole('button', { name: /apple/i })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('google-p04-' + mode + '.png') });
  if (mode === 'held') {
    await expect(page.getByRole('link', { name: 'Create account' })).toHaveCount(0);
    await page.goto(origin + '/sign-up');
    await expect(page).toHaveURL(origin + '/');
    return;
  }
  await page.getByRole('link', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Create an account' })).toBeVisible();
  await expect(page.getByLabel('Email address', { exact: true })).toBeVisible();
  await expect(googleButton(page)).toHaveCount(mode === 'off' ? 0 : 1);
  await expect(page.getByRole('button', { name: /apple/i })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('google-p02-' + mode + '.png') });
  if (mode === 'off') {
    await page.goto(origin + '/sign-in');
    await emailSignIn(page);
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  }
});

test('the Google handoff keeps both sign-in actions busy until the page leaves', async ({ page }) => {
  test.skip(mode !== 'open', 'Requires enabled Google.');
  await socialFixture(page, 'google', true);
  await page.goto(origin + '/sign-in');
  await googleButton(page).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Opening Google sign-in…' })).toBeVisible();
  await expect(googleButton(page)).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event('synthetic-google-ready')));
  await expect(page.getByRole('heading', { name: 'Synthetic Google authorization' })).toBeVisible();
  await page.goBack();
  await expect(googleButton(page)).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
});

test('a canceled P02 attempt returns to P04 with announced feedback and email or Google retry', async ({ page }, info) => {
  test.skip(mode !== 'open', 'Requires Google and test signup.');
  await socialFixture(page, 'google');
  await page.setViewportSize({ width: 320, height: 790 });
  await page.goto(origin + '/sign-up');
  await providerReturn(page, 'cancelled', await leaveForGoogle(page));
  await expect(page).toHaveURL(origin + '/sign-in?google=cancelled');
  const feedback = page.getByRole('main').getByRole('alert');
  await expect(feedback).toBeFocused();
  await expect(feedback).toHaveText('Google sign-in was canceled. Try again or use email and password.');
  await expect(googleButton(page)).toHaveAccessibleDescription(/was canceled/);
  await expect(page.getByRole('main')).toMatchAriaSnapshot(`
    - heading "Sign in" [level=1]
    - textbox "Email address"
    - button "Sign in"
    - alert: Google sign-in was canceled. Try again or use email and password.
    - button "Continue with Google"
  `);
  await page.screenshot({ path: info.outputPath('google-p04-cancelled.png') });
  await providerReturn(page, 'failed', await leaveForGoogle(page));
  await expect(page).toHaveURL(origin + '/sign-in?google=failed');
  await expect(feedback).toContainText('didn’t finish');
  await emailSignIn(page);
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
});

test('a new Google driver must accept current P06 before private entry', async ({ page }) => {
  test.skip(mode !== 'open', 'Requires Google and test signup.');
  await socialFixture(page, 'google');
  await page.goto(origin + '/sign-in');
  await providerReturn(page, 'new', await leaveForGoogle(page));
  await expect(page).toHaveURL(origin + '/account');
  await expect(page.getByRole('heading', { name: 'Controlled-use onboarding' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Dashboard' })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'I accept the current controlled-use conditions.' }).check();
  await page.getByRole('button', { name: 'Accept and continue' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /administration|staff/i })).toHaveCount(0);
  await page.goto(origin + '/account/links/' + workspaceLink);
  await expect(page.getByText('This item is unavailable.')).toBeVisible();
});

test('verified linking and returning Google sign-in keep the email driver’s owned workspace', async ({ page }) => {
  test.skip(mode !== 'open', 'Requires Google and test signup.');
  await socialFixture(page, 'google');
  await page.goto(origin + '/sign-in?entry=profile');
  await emailSignIn(page);
  await expect(page.getByLabel('Display name')).toHaveValue('Original owned profile');
  for (const result of ['linked', 'returning']) {
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.goto(origin + '/sign-in?entry=profile');
    await providerReturn(page, result, await leaveForGoogle(page));
    await expect(page.getByLabel('Display name')).toHaveValue('Original owned profile');
    await expect(page).toHaveURL(origin + '/account/profile');
  }
  await page.goto(origin + '/account/links/' + workspaceLink);
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
});

test('held signup refuses Google enrollment and lets an existing driver sign in', async ({ page }, info) => {
  test.skip(mode !== 'held', 'Requires Google with signup held.');
  await socialFixture(page, 'google');
  await page.goto(origin + '/sign-in?entry=profile');
  await providerReturn(page, 'new', await leaveForGoogle(page));
  await expect(page).toHaveURL(origin + '/sign-in?entry=profile&google=signup-held');
  await expect(page.getByRole('main').getByRole('alert')).toHaveText(/Public signup is pending release/);
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create account' })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('google-p04-signup-held.png') });
  await providerReturn(page, 'returning', await leaveForGoogle(page));
  await expect(page.getByLabel('Display name')).toHaveValue('Original owned profile');
});

test('a syntactically valid uninitiated callback cannot complete Google sign-in', async ({ page }) => {
  test.skip(mode === 'off', 'Requires the enabled callback surface.');
  await socialFixture(page, 'google');
  await page.goto(origin + '/sign-in/google/callback?attempt=abf906df-9c96-4ccc-af9c-cf01e1f8c0f2&fixture=linked');
  await expect(page).toHaveURL(origin + '/sign-in?google=failed');
  await expect(page.getByRole('main').getByRole('alert')).toContainText('didn’t finish');
});
