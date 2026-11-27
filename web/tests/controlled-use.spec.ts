import { sign } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const origin = process.env.RAFIQ_LANDING_PENDING_ORIGIN;
const api = 'https://accounts.example.test/api/v1/account';

async function signInFixture(page: Page, driver: string, session = driver) {
  const userId = 'user_' + driver;
  const sessionId = 'sess_' + session;
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = encode({ alg: 'RS256', typ: 'JWT', kid: 'synthetic', cat: 'cl_B7d4PD111AAA' }) + '.' + encode({
    sub: userId, sid: sessionId, iss: 'https://clerk.example.test', azp: origin,
    iat: now, nbf: now - 10, exp: now + 300, sts: 'active',
  });
  const token = data + '.' + sign('RSA-SHA256', Buffer.from(data), process.env.RAFIQ_LOCAL_CLERK_KEY!).toString('base64url');
  await page.context().addCookies([
    { url: origin!, name: '__session', value: token },
    { url: origin!, name: '__client_uat', value: String(now) },
  ]);
  await page.route('https://clerk.example.test/**', (route) => route.abort());
  await page.addInitScript(({ userId, sessionId, token }) => {
    const authority = (userId: string, sessionId: string, token: string) => {
      const session = {
        id: sessionId, status: 'active', getToken: async () => token,
        lastActiveToken: { jwt: { claims: { sub: userId, sid: sessionId, sts: 'active' } } },
      };
      return {
        client: { sessions: [session] }, session, organization: null,
        user: {
          id: userId, deleteSelfEnabled: false,
          primaryEmailAddress: { id: 'idn_synthetic', emailAddress: 'verification@example.test' },
        },
      };
    };
    let resources = authority(userId, sessionId, token);
    const listeners = new Set<(resources: object) => void>();
    const clerk = {
      loaded: true, ...resources,
      __internal_lastEmittedResources: resources,
      on(event: string, listener: (status: string) => void) {
        if (event === 'status') queueMicrotask(() => listener('ready'));
      },
      off() {},
      addListener(listener: (resources: object) => void) {
        listeners.add(listener);
        queueMicrotask(() => listener(resources));
        return () => listeners.delete(listener);
      },
      mountUserProfile(node: HTMLElement) {
        node.textContent = 'Synthetic Clerk identity settings';
      },
      unmountUserProfile(node: HTMLElement) {
        node.textContent = '';
      },
      async signOut({ redirectUrl }: { redirectUrl: string }) {
        if (document.documentElement.dataset.fixtureSignOut === 'hold') {
          await new Promise<void>((resolve) => {
            window.addEventListener('rafiq-fixture-release-sign-out', () => resolve(), { once: true });
          });
          throw new Error('Synthetic Clerk sign-out failure');
        }
        document.cookie = '__session=; path=/; max-age=0';
        document.cookie = '__client_uat=; path=/; max-age=0';
        window.location.assign(redirectUrl);
      },
    };
    Object.defineProperty(window, 'Clerk', { value: clerk });
    window.addEventListener('rafiq-fixture-switch', (event) => {
      const detail = (event as CustomEvent<{ userId: string; sessionId: string; token: string }>).detail;
      resources = authority(detail.userId, detail.sessionId, detail.token);
      Object.assign(clerk, resources, { __internal_lastEmittedResources: resources });
      for (const listener of listeners) listener(resources);
    });
  }, { userId, sessionId, token });
}

test.beforeEach(() => {
  test.skip(!origin || !process.env.RAFIQ_LOCAL_CLERK_KEY, 'Requires the isolated local web fixture.');
});

test('a signed-out readiness link carries a fixed entry, and external or ambiguous returns are dropped', async ({ request }) => {
  const readiness = await request.get(origin + '/account/readiness', { maxRedirects: 0 });
  expect(readiness.headers().location).toBe('/sign-in?entry=readiness');
  const workspaceLink = await request.get(origin + '/account/links/' + linkId, { maxRedirects: 0 });
  expect(workspaceLink.headers().location).toBe('/sign-in?entry=account');
  for (const query of ['entry=https://outside.example', 'entry=readiness&entry=dashboard', 'entry=/account/readiness']) {
    const rejected = await request.get(origin + '/account?' + query, { maxRedirects: 0 });
    expect(rejected.headers().location).toBe('/sign-in?entry=account');
  }
});

test('P06 announces progress, retries safely and requires a fresh acceptance after a change', async ({ page }) => {
  await signInFixture(page, 'fixtureA');
  await page.setViewportSize({ width: 320, height: 760 });
  let required = 'controlled-use-1';
  let acceptedVersion: string | null = null;
  const attempts: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  await page.route(api + '**', async (route) => {
    const request = route.request();
    const suffix = new URL(request.url()).pathname.slice('/api/v1/account'.length);
    const active = acceptedVersion === required;
    const account = { accountId: 'fixture-account', status: active ? 'active' : 'onboardingRequired', verified: true };
    if (suffix === '') return route.fulfill({ json: account });
    if (suffix === '/controlled-use' && request.method() === 'GET') {
      return route.fulfill({ json: {
        version: required, stationary: 'Set up while stationary.',
        supervised: 'Use the approved supervised procedure.',
        camera: 'Check the front-facing camera view.',
        recording: 'Choose separately at readiness whether to record.',
      } });
    }
    if (suffix === '/controlled-use' && request.method() === 'PUT') {
      const body = request.postDataJSON();
      expect(body.accepted).toBe(true);
      attempts.push(body.version);
      if (attempts.length === 1) {
        await blocked;
        return route.fulfill({ status: 503, json: { code: 'account_unavailable' } });
      }
      if (body.version !== required) return route.fulfill({ status: 409, json: { code: 'controlled_use_changed' } });
      acceptedVersion = body.version;
      return route.fulfill({ json: { ...account, status: 'active' } });
    }
    expect(suffix).toBe('/readiness');
    expect(request.method()).toBe('POST');
    if (!active) return route.fulfill({ status: 403, json: { code: 'controlled_use_required' } });
    return route.fulfill({ json: { destination: 'readiness', accountId: account.accountId, acceptedVersion } });
  });
  await page.goto(origin + '/account?entry=readiness');
  const main = page.getByRole('main');
  const checkbox = main.getByRole('checkbox', { name: 'I accept the current controlled-use conditions.' });
  const submit = main.getByRole('button', { name: 'Accept and continue' });
  await expect(main.getByRole('heading', { name: 'Controlled-use onboarding' })).toBeFocused();
  for (const name of ['Stationary setup', 'Approved supervised use', 'Camera setup', 'Recording choice']) {
    await expect(main.getByRole('heading', { name })).toBeVisible();
  }
  await expect(submit).toHaveAttribute('aria-disabled', 'true');
  await expect(main).toMatchAriaSnapshot(`
    - heading "Stationary setup" [level=2]
    - heading "Approved supervised use" [level=2]
    - heading "Camera setup" [level=2]
    - heading "Recording choice" [level=2]
    - checkbox "I accept the current controlled-use conditions."
    - button "Accept and continue" [disabled]
    - button "Sign out"
  `);
  await checkbox.press('Space');
  await page.keyboard.press('Tab');
  await expect(submit).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(main.getByRole('status')).toHaveText('Saving acceptance…');
  release();
  await expect(main.getByRole('alert')).toContainText('safe to retry');
  await expect(submit).toBeFocused();

  required = 'controlled-use-2';
  await page.keyboard.press('Enter');
  await expect(main.getByRole('alert')).toContainText('The conditions changed');
  await expect(main.getByRole('heading', { level: 1 })).toBeFocused();
  await expect(checkbox).not.toBeChecked();
  await expect(submit).toHaveAttribute('aria-disabled', 'true');
  await expect(main.getByText('Conditions version controlled-use-2')).toBeVisible();
  await expect(main.getByRole('button', { name: 'Sign out' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);

  await checkbox.press('Space');
  await submit.press('Enter');
  await expect(page).toHaveURL(origin + '/account/readiness');
  await expect(main.getByRole('heading', { name: 'Stationary readiness' })).toBeFocused();
  await page.reload();
  await expect(main.getByRole('heading', { name: 'Stationary readiness' })).toBeVisible();
  expect(attempts).toEqual(['controlled-use-1', 'controlled-use-1', 'controlled-use-2']);
  await main.getByRole('button', { name: 'Sign out' }).press('Enter');
  await expect(page).toHaveURL(origin + '/');
});

test('a changed driver drops a previously bound readiness link and authorizes Dashboard', async ({ page }) => {
  await signInFixture(page, 'fixtureB');
  await page.addInitScript(() => sessionStorage.setItem('rafiq-readiness-return-driver', 'user_fixtureA'));
  const requested: string[] = [];
  await page.route(api + '**', async (route) => {
    requested.push(new URL(route.request().url()).pathname);
    if (route.request().url() === api) {
      return route.fulfill({ json: { accountId: 'fixture-B', status: 'active', verified: true } });
    }
    return route.fulfill({ json: { accountId: 'fixture-B', destination: 'dashboard', acceptedVersion: 'controlled-use-1' } });
  });
  await page.goto(origin + '/account?entry=readiness');
  await expect(page).toHaveURL(origin + '/account/dashboard');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeFocused();
  expect(requested).toContain('/api/v1/account/workspace');
  expect(requested).not.toContain('/api/v1/account/readiness');
});

test('a fresh session for the same driver keeps the verified readiness return', async ({ page }) => {
  await signInFixture(page, 'fixtureA', 'renewedFixtureA');
  await page.addInitScript(() => sessionStorage.setItem('rafiq-readiness-return-driver', 'user_fixtureA'));
  await page.route(api + '**', (route) => {
    if (route.request().url() === api) {
      return route.fulfill({ json: { accountId: 'fixture-A', status: 'active', verified: true } });
    }
    expect(route.request().url()).toBe(api + '/readiness');
    return route.fulfill({ json: { accountId: 'fixture-A', destination: 'readiness', acceptedVersion: 'controlled-use-1' } });
  });
  await page.goto(origin + '/account?entry=readiness');
  await expect(page).toHaveURL(origin + '/account/readiness');
  await expect(page.getByRole('heading', { name: 'Stationary readiness' })).toBeFocused();
});

const linkId = '4de23697-05fa-4cad-8492-c0df246423a1';
const linkPath = '/account/links/' + linkId;
const syntheticAccount = 'synthetic-private-account-from-api';

test('P08 hides the workspace on expiry and uses the same neutral return for unavailable links', async ({ page }) => {
  await signInFixture(page, 'fixtureA');
  await page.clock.install();
  await page.setViewportSize({ width: 320, height: 760 });
  let available = true;
  await page.route(api + '**', (route) => {
    const suffix = new URL(route.request().url()).pathname.slice('/api/v1/account'.length);
    if (!suffix) return route.fulfill({ json: { accountId: syntheticAccount, status: 'active', verified: true } });
    if (suffix !== '/workspace' && (!available || !suffix.endsWith(linkId))) {
      return route.fulfill({ status: 404, json: { code: 'resource_unavailable' } });
    }
    return route.fulfill({ json: {
      accountId: syntheticAccount, destination: 'dashboard', acceptedVersion: 'controlled-use-1',
      expiresInMs: 60_000,
    } });
  });
  const documentResponse = await page.goto(origin + linkPath);
  expect(documentResponse?.headers()['cache-control']).toContain('no-store');
  expect(await documentResponse!.text()).not.toContain(syntheticAccount);
  const start = page.getByRole('link', { name: 'Start session' });
  await expect(start).toBeVisible();

  available = false;
  await page.clock.runFor(10_100);
  const unavailable = page.getByRole('heading', { name: 'Unavailable link' });
  await expect(unavailable).toBeFocused();
  await expect(start).toHaveCount(0);
  await expect(page.getByText('This item is unavailable.', { exact: true })).toBeVisible();
  await page.keyboard.press('Tab');
  const safeReturn = page.getByRole('link', { name: 'Return to Dashboard' });
  await expect(safeReturn).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(origin + '/account/dashboard');
  await expect(start).toBeVisible();
  await page.goBack();
  await expect(unavailable).toBeVisible();
  await expect(start).toHaveCount(0);

  await page.goto(origin + '/account/links/missing');
  await expect(unavailable).toBeFocused();
  await expect(page.getByText('This item is unavailable.', { exact: true })).toBeVisible();
  await expect(safeReturn).toHaveAttribute('href', '/account/dashboard');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
});

test('P08 conceals link actions at the known expiration before the next account check', async ({ page }) => {
  await signInFixture(page, 'fixtureA');
  await page.clock.install();
  await page.route(api + '**', (route) => route.fulfill({ json: route.request().url() === api
    ? { accountId: syntheticAccount, status: 'active', verified: true }
    : { accountId: syntheticAccount, destination: 'dashboard', acceptedVersion: 'controlled-use-1', expiresInMs: 2500 },
  }));
  await page.goto(origin + linkPath);
  await expect(page.getByRole('link', { name: 'Start session' })).toBeVisible();
  await page.clock.runFor(2600);
  await expect(page.getByRole('heading', { name: 'Unavailable link' })).toBeFocused();
  await expect(page.getByRole('link', { name: 'Start session' })).toHaveCount(0);
});

test('P07 clears another tab during a delayed response and offers a fresh sign-in', async ({ page, context }) => {
  const sibling = await context.newPage();
  for (const tab of [page, sibling]) {
    await signInFixture(tab, 'fixtureA');
    await tab.clock.install();
  }
  let restricted = false;
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  for (const tab of [page, sibling]) {
    await tab.route(api + '**', async (route) => {
      const url = route.request().url();
      if (url === api) return route.fulfill({ json: { accountId: syntheticAccount, status: 'active', verified: true } });
      if (url.endsWith(linkId)) {
        notifyStarted();
        await delayed;
      } else if (restricted) {
        return route.fulfill({ status: 403, json: {
          code: 'account_restricted', supportContact: 'support@example.net',
        } });
      }
      await route.fulfill({ json: {
        accountId: syntheticAccount, destination: 'dashboard', acceptedVersion: 'controlled-use-1',
        expiresInMs: 60_000,
      } }).catch(() => {});
    });
  }
  await page.goto(origin + '/account/dashboard');
  await expect(page.getByRole('link', { name: 'Start session' })).toBeVisible();
  await sibling.goto(origin + linkPath);
  await started;
  restricted = true;
  await page.clock.runFor(10_100);
  for (const tab of [page, sibling]) {
    await expect(tab.getByRole('heading', { name: 'Account restricted' })).toBeVisible();
    await expect(tab.getByRole('link', { name: 'Start session' })).toHaveCount(0);
    await expect(tab.getByText('New sessions and hosted synchronization are blocked.')).toBeVisible();
  }
  release();
  await expect(sibling.getByRole('heading', { name: 'Account restricted' })).toBeFocused();
  await sibling.keyboard.press('Tab');
  const support = sibling.getByRole('link', { name: 'support@example.net' });
  await expect(support).toBeFocused();
  await expect(support).toHaveAttribute('href', 'mailto:support@example.net');
  await sibling.keyboard.press('Tab');
  await expect(sibling.getByRole('button', { name: 'Sign in' })).toBeFocused();
  await sibling.keyboard.press('Enter');
  await expect(sibling).toHaveURL(origin + '/sign-in?entry=account');
});

test('switching drivers invalidates the previous session across tabs without reopening its late response', async ({ page, context }) => {
  const sibling = await context.newPage();
  for (const tab of [page, sibling]) await signInFixture(tab, 'fixtureA');
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  for (const tab of [page, sibling]) {
    await tab.route(api + '**', async (route) => {
      const request = route.request();
      const secondDriver = request.headers().authorization === 'Bearer synthetic-driver-B';
      const accountId = secondDriver ? 'synthetic-private-account-b' : syntheticAccount;
      if (request.url() === api) return route.fulfill({ json: { accountId, status: 'active', verified: true } });
      if (request.url().endsWith(linkId)) {
        if (secondDriver) return route.fulfill({ status: 404, json: { code: 'resource_unavailable' } });
        if (tab === sibling) {
          notifyStarted();
          await delayed;
        }
      }
      await route.fulfill({ json: { accountId, destination: 'dashboard', acceptedVersion: 'controlled-use-1', expiresInMs: 60_000 } }).catch(() => {});
    });
  }
  await page.goto(origin + linkPath);
  await expect(page.getByRole('link', { name: 'Start session' })).toBeVisible();
  await sibling.goto(origin + linkPath);
  await started;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('rafiq-fixture-switch', { detail: {
    userId: 'user_fixtureB', sessionId: 'sess_fixtureB', token: 'synthetic-driver-B',
  } })));
  await expect(page.getByRole('heading', { name: 'Unavailable link' })).toBeFocused();
  await expect(sibling.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  release();
  for (const tab of [page, sibling]) {
    await expect(tab.getByRole('link', { name: 'Start session' })).toHaveCount(0);
    await expect(tab.getByText(syntheticAccount)).toHaveCount(0);
  }
});

for (const trigger of ['expiry', 'sign-out'] as const) {
  test('clears private actions in both tabs on ' + trigger, async ({ page, context }) => {
    const sibling = await context.newPage();
    let expired = false;
    for (const tab of [page, sibling]) {
      await signInFixture(tab, 'fixtureA');
      await tab.clock.install();
      await tab.route(api + '**', (route) => {
        if (expired) return route.fulfill({ status: 401, json: { code: 'authentication_required' } });
        const response = route.request().url() === api
          ? { accountId: syntheticAccount, status: 'active', verified: true }
          : { accountId: syntheticAccount, destination: 'dashboard', acceptedVersion: 'controlled-use-1' };
        return route.fulfill({ json: response });
      });
      await tab.goto(origin + '/account/dashboard');
      await expect(tab.getByRole('link', { name: 'Start session' })).toBeVisible();
    }
    if (trigger === 'expiry') {
      expired = true;
      await page.clock.runFor(10_100);
      await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
    } else {
      await page.getByRole('button', { name: 'Sign out' }).press('Enter');
      await expect(page).toHaveURL(origin + '/');
    }
    await expect(sibling.getByRole('heading', { name: 'Sign in to continue' })).toBeFocused();
    await expect(sibling.getByRole('link', { name: 'Start session' })).toHaveCount(0);
  });
}

const profilePath = '/account/profile';
const longEmail = 'driver-' + 'x'.repeat(57) + '@' + 'example'.repeat(8) + '.test';
const profileFixture = (displayName: string | null, registeredEmail = longEmail) => ({
  accountId: syntheticAccount, status: 'active', verified: true, displayName, registeredEmail,
});

test('D19 retries a scoped read and save, validates and persists across reload and fresh sign-in', async ({ page, context }) => {
  await context.route(api + '**', async (route) => {
    const req = route.request();
    if (req.url().endsWith('/workspace')) {
      return route.fulfill({ json: { destination: 'dashboard', accountId: syntheticAccount, acceptedVersion: 'controlled-use-1' } });
    }
    if (req.method() === 'PATCH') {
      expect(req.postDataJSON()).toEqual({ displayName: 'Nour Fixture' });
      if (++writes === 1) return route.fulfill({ status: 503, json: { code: 'account_unavailable' } });
      displayName = req.postDataJSON().displayName;
    } else if (++reads === 3) {
      started();
      await loading;
      return route.fulfill({ status: 503, json: { code: 'account_unavailable' } });
    }
    return route.fulfill({ json: profileFixture(displayName) });
  });
  let reads = 0;
  let writes = 0;
  let displayName: string | null = null;
  let started!: () => void;
  const readStarted = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const loading = new Promise<void>((resolve) => { release = resolve; });

  await signInFixture(page, 'profileA');
  await page.setViewportSize({ width: 640, height: 820 });
  await page.goto(origin + '/account/dashboard');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  // The dashboard takes one account read. The first visit supplies the before-state.
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByLabel('Display name')).toHaveValue('');
  await page.reload();
  await readStarted;
  await expect(page.getByRole('status')).toHaveText('Loading profile…');
  await expect(page.getByText(longEmail)).toHaveCount(0);
  release();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Couldn’t load profile');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  const name = page.getByLabel('Display name');
  await expect(name).toHaveValue('');
  await expect(page).toHaveTitle('Profile | RAFIQ');
  await expect(page.getByText('Verified', { exact: false })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('profile-before.png'), fullPage: true });

  await name.fill('x'.repeat(101));
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(name).toBeFocused();
  await expect(name).toHaveAccessibleDescription('Enter a display name from 1 to 100 characters.');
  expect(writes).toBe(0);
  await name.fill('Nour Fixture');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Couldn’t save your display name');
  await expect(name).toHaveValue('Nour Fixture');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath('profile-after.png'), fullPage: true });
  await page.reload();
  await expect(name).toHaveValue('Nour Fixture');
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toHaveCount(0);

  await page.addStyleTag({ content: 'html { zoom: 200% }' });
  const email = page.getByText(longEmail, { exact: true });
  await expect(email).toBeVisible();
  expect(await email.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(60);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(640);
  await page.screenshot({ path: test.info().outputPath('profile-long-email-200-percent.png'), fullPage: true });
  await page.setViewportSize({ width: 320, height: 760 });
  await page.addStyleTag({ content: 'html { zoom: 100% }' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);

  await expect(page.locator('.profile-links a')).toHaveText(['View session history', 'Privacy']);
  await page.getByRole('link', { name: 'View session history' }).click();
  await expect(page.getByRole('heading', { name: 'Sessions' })).toBeFocused();
  await expect(page.getByText('Session history is currently unavailable.')).toBeVisible();
  await page.getByRole('link', { name: 'Return to Profile' }).click();
  await page.locator('.profile-links').getByRole('link', { name: 'Privacy' }).click();
  await expect(page.getByRole('heading', { name: 'Privacy' })).toBeFocused();
  await expect(page.getByText('Privacy controls are currently unavailable.')).toBeVisible();
  await page.getByRole('link', { name: 'Return to Profile' }).click();

  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page).toHaveURL(origin + '/');
  const fresh = await context.newPage();
  await signInFixture(fresh, 'profileA', 'profileFresh');
  await fresh.goto(origin + profilePath);
  await expect(fresh.getByLabel('Display name')).toHaveValue('Nour Fixture');
});

test('D19 retains a draft through a service outage and refreshes verified identity independently', async ({ page }) => {
  await signInFixture(page, 'profileOutage');
  await page.clock.install();
  let unavailable = false;
  let email = longEmail;
  let displayName = 'Saved value';
  await page.route(api, (route) => {
    if (unavailable) return route.fulfill({ status: 503, json: { code: 'account_unavailable' } });
    return route.fulfill({ json: profileFixture(displayName, email) });
  });
  await page.goto(origin + profilePath);
  const name = page.getByLabel('Display name');
  await name.fill('Draft through outage');
  unavailable = true;
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Couldn’t save your display name');
  await page.clock.runFor(10_100);
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Couldn’t load profile');
  await expect(name).toHaveCount(0);

  unavailable = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(name).toHaveValue('Draft through outage');
  email = 'changed-in-another-session@example.test';
  await page.clock.runFor(10_100);
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  await expect(name).toHaveValue('Draft through outage');

  await name.fill('Saved value');
  displayName = 'Changed in another session';
  await page.clock.runFor(10_100);
  await expect(name).toHaveValue(displayName);
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
});

test('D19 rechecks authorized identity after returning from Clerk and routes a restriction to P07', async ({ page }) => {
  await signInFixture(page, 'profileIdentity');
  let mode: 'active' | 'unavailable' | 'verification' | 'restricted' = 'active';
  let email = longEmail;
  await page.route(api, async (route) => {
    if (mode === 'unavailable') return route.fulfill({ status: 503, json: { code: 'account_unavailable' } });
    if (mode === 'restricted') {
      return route.fulfill({ status: 403, json: { code: 'account_restricted', supportContact: 'support@example.net' } });
    }
    if (mode === 'verification') return route.fulfill({ status: 403, json: { code: 'verification_required' } });
    return route.fulfill({ json: profileFixture('Nour Fixture', email) });
  });
  await page.goto(origin + profilePath);
  const manage = page.getByRole('button', { name: 'Manage sign-in details' });
  await manage.click();
  await expect(page.getByText('Synthetic Clerk identity settings')).toBeVisible();
  const back = page.getByRole('button', { name: 'Return to Profile' });
  await expect(back).toBeFocused();
  mode = 'unavailable';
  await back.click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Couldn’t check verification');
  await expect(page.getByText(longEmail)).toHaveCount(0);
  mode = 'active';
  email = 'updated@example.test';
  await page.getByRole('button', { name: 'Retry verification' }).click();
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  await expect(manage).toBeFocused();

  await manage.click();
  mode = 'restricted';
  await back.click();
  await expect(page.getByRole('heading', { name: 'Account restricted' })).toBeFocused();
  await expect(page.getByText(email)).toHaveCount(0);
  await expect(page.getByLabel('Display name')).toHaveCount(0);

  mode = 'active';
  await page.reload();
  await manage.click();
  mode = 'verification';
  await back.click();
  await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
  await expect(page.getByLabel('Display name')).toHaveCount(0);
});

test('D19 distinguishes a submitted save from an unsaved draft during sign-out', async ({ page }) => {
  await signInFixture(page, 'profileSignOutSave');
  let begin!: () => void;
  const saving = new Promise<void>((resolve) => { begin = resolve; });
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  await page.route(api, async (route) => {
    if (route.request().method() === 'PATCH') {
      begin();
      await delayed;
      return route.fulfill({ json: profileFixture('Changed name') });
    }
    return route.fulfill({ json: profileFixture('Saved value') });
  });

  await page.goto(origin + profilePath);
  await page.getByLabel('Display name').fill('Changed name');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await saving;
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Sign out?' });
  await expect(dialog).toHaveAccessibleDescription('Your submitted display name may still be saved if you sign out now.');
  release();
  await expect(dialog).toHaveAccessibleDescription('Your display name was saved.');
  await dialog.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(origin + '/');
});

test('D19 traps confirmation focus and locks private views through pending, failed and retried sign-out', async ({ page, context }) => {
  const sibling = await context.newPage();
  let startSave!: () => void;
  const saving = new Promise<void>((resolve) => { startSave = resolve; });
  let releaseSave!: () => void;
  const delayed = new Promise<void>((resolve) => { releaseSave = resolve; });
  for (const tab of [page, sibling]) {
    await signInFixture(tab, 'profileShared');
    await tab.route(api, async (route) => {
      if (route.request().method() === 'PATCH') {
        startSave();
        await delayed;
        return route.fulfill({ json: profileFixture('Late private draft') }).catch(() => {});
      }
      return route.fulfill({ json: profileFixture('Nour Fixture') });
    });
    await tab.goto(origin + profilePath);
    await expect(tab.getByText(longEmail)).toBeVisible();
  }

  const name = page.getByLabel('Display name');
  await name.fill('Local unsaved draft');
  const signOut = page.getByRole('button', { name: 'Sign out', exact: true });
  await signOut.press('Enter');
  const dialog = page.getByRole('alertdialog');
  const keepEditing = dialog.getByRole('button', { name: 'Keep editing' });
  await expect(keepEditing).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Sign out' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(keepEditing).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Sign out' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(signOut).toBeFocused();
  await expect(name).toHaveValue('Local unsaved draft');
  await signOut.press('Enter');
  await keepEditing.press('Enter');
  await expect(signOut).toBeFocused();

  await sibling.getByLabel('Display name').fill('Late private draft');
  await sibling.getByRole('button', { name: 'Save changes' }).click();
  await saving;
  await page.evaluate(() => {
    document.documentElement.dataset.fixtureSignOut = 'hold';
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage) throw new DOMException('Synthetic storage quota failure', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
  });
  await signOut.press('Enter');
  await dialog.getByRole('button', { name: 'Sign out' }).press('Enter');
  await expect(page.getByRole('heading', { name: 'Signing out…' })).toBeVisible();
  await expect(sibling.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  releaseSave();
  for (const tab of [page, sibling]) {
    await expect(tab.getByText(longEmail)).toHaveCount(0);
    await expect(tab.getByLabel('Display name')).toHaveCount(0);
    await expect(tab.getByRole('status').filter({ hasText: 'Saved' })).toHaveCount(0);
  }
  await page.evaluate(() => { window.dispatchEvent(new Event('rafiq-fixture-release-sign-out')); });
  await expect(page.getByRole('heading', { name: 'Couldn’t sign out' })).toBeFocused();
  await sibling.reload();
  await expect(sibling.getByRole('heading', { name: 'Couldn’t sign out' })).toBeVisible();
  await expect(sibling.getByText(longEmail)).toHaveCount(0);
  await page.evaluate(() => { delete document.documentElement.dataset.fixtureSignOut; });
  await page.getByRole('button', { name: 'Retry sign-out' }).click();
  await expect(page).toHaveURL(origin + '/');
  await sibling.reload();
  await expect(sibling).toHaveURL(origin + '/sign-in?entry=profile');
});

test('D06 and D22 entries require an eligible current driver', async ({ page, request }) => {
  for (const destination of ['sessions', 'privacy']) {
    const response = await request.get(origin + '/account/' + destination, { maxRedirects: 0 });
    expect(response.headers().location).toBe('/sign-in?entry=' + destination);
  }
  await signInFixture(page, 'profileBlocked');
  await page.route(api, (route) => route.fulfill({ status: 403, json: { code: 'account_restricted' } }));
  for (const destination of ['sessions', 'privacy']) {
    await page.goto(origin + '/account/' + destination);
    await expect(page.getByRole('heading', { name: 'Account restricted' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Return to Profile' })).toHaveCount(0);
  }
});
