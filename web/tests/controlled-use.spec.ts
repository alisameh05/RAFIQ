import { sign } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const origin = process.env.RAFIQ_LANDING_PENDING_ORIGIN;
const api = 'https://accounts.example.test/api/v1/account';
const consentApi = 'https://accounts.example.test/api/v1/recording-consent';
const offRecording = { enabled: false, behaviors: [] as string[], preSeconds: 3, postSeconds: 3 };
const defaultPreferences = { cameraDeviceId: null as string | null, warningAudio: false, warningVisibility: 'default' };

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
  await page.route(consentApi, (route) => route.fulfill({ json: { revision: 'consent-0', settings: offRecording } }));
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
    if (suffix === '/preferences') return route.fulfill({ json: defaultPreferences });
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
    if (route.request().url() === api + '/preferences') return route.fulfill({ json: defaultPreferences });
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
  await expect(page.getByRole('heading', { name: 'Incident recording' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Manage recording' })).toHaveAttribute('href', monitoringPath + '#incident-recording');
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


const monitoringPath = '/account/monitoring';
const cameraId = 'synthetic-integrated-camera';
const alternateCameraId = 'synthetic-built-in-camera';
async function installCameraFixture(page: Page, mode: 'granted' | 'denied' | 'missing') {
  await page.addInitScript(({ cameraId, alternateCameraId, mode }) => {
    const state = { mode: mode as string, constraints: [] as MediaStreamConstraints[], stopped: 0 };
    Object.assign(window, { syntheticCamera: state });
    const cameras = [
      { kind: 'videoinput', deviceId: cameraId, label: 'Integrated Camera' },
      { kind: 'videoinput', deviceId: alternateCameraId, label: 'Built-in Camera' },
      { kind: 'videoinput', deviceId: 'external', label: 'External USB Camera' },
      { kind: 'audioinput', deviceId: 'internal-mic', label: 'Built-in microphone' },
    ];
    const query = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = async (descriptor) => {
      if (descriptor.name !== 'camera') return query(descriptor);
      return { state: state.mode === 'denied' ? 'denied' : 'granted' } as PermissionStatus;
    };
    navigator.mediaDevices.enumerateDevices = async () => (state.mode === 'denied' ? [] : cameras
      .filter((camera) => state.mode !== 'missing' || camera.deviceId !== cameraId)) as MediaDeviceInfo[];
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (constraints) state.constraints.push(constraints);
      if (state.mode === 'denied') throw new DOMException('Fixture denied', 'NotAllowedError');
      if (state.mode === 'unopenable') {
        await new Promise<void>((resolve) => window.addEventListener('release-camera-probe', () => resolve(), { once: true }));
        throw new DOMException('Fixture camera cannot open', 'OverconstrainedError');
      }
      return { getTracks: () => [{ stop: () => state.stopped++ }] } as unknown as MediaStream;
    };
  }, { cameraId, alternateCameraId, mode });
}

test('D20 retries an owned replacement, persists it across reload, and hands it to a later D02 attempt', async ({ page }) => {
  await signInFixture(page, 'monitoringA');
  await installCameraFixture(page, 'granted');
  let stored = defaultPreferences;
  let writes = 0;
  let signalSave!: () => void;
  const saveStarted = new Promise<void>((resolve) => { signalSave = resolve; });
  let releaseSave!: () => void;
  const holdSave = new Promise<void>((resolve) => { releaseSave = resolve; });
  await page.route(api + '**', async (route) => {
    const request = route.request();
    if (request.url() === api) return route.fulfill({ json: profileFixture(null) });
    if (request.url().endsWith('/workspace')) return route.fulfill({ json: { destination: 'dashboard', accountId: syntheticAccount, acceptedVersion: 'controlled-use-1' } });
    if (request.url().endsWith('/readiness')) {
      expect(request.method()).toBe('POST');
      return route.fulfill({ json: { destination: 'readiness', accountId: syntheticAccount, acceptedVersion: 'controlled-use-1' } });
    }
    expect(request.url()).toBe(api + '/preferences');
    if (request.method() === 'PUT') {
      expect(request.postDataJSON()).toEqual({ cameraDeviceId: cameraId, warningAudio: true, warningVisibility: 'enhanced' });
      if (++writes === 1) {
        signalSave();
        await holdSave;
        return route.fulfill({ status: 503, json: { code: 'account_unavailable' } });
      }
      stored = request.postDataJSON();
    }
    return route.fulfill({ json: stored });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin + '/account/profile');
  await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('link', { name: 'Monitoring' }).click();
  await expect(page).toHaveURL(origin + monitoringPath);
  await expect(page.getByRole('heading', { name: 'Monitoring settings' })).toBeFocused();
  const camera = page.getByRole('combobox', { name: 'Built-in camera' });
  const audio = page.getByRole('switch', { name: 'Warning audio' });
  const enhanced = page.getByRole('radio', { name: 'Enhanced visibility' });
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await expect(camera.locator('option')).toHaveText(['Automatic selection', 'Integrated Camera', 'Built-in Camera']);
  await expect(audio).not.toBeChecked();
  await expect(save).toBeDisabled();
  await camera.selectOption(cameraId);
  await audio.press('Space');
  await expect(audio).toBeFocused();
  await expect(audio).toBeChecked();
  const sample = page.getByText('Eyes closed for 2 seconds', { exact: true });
  const initialSize = await sample.evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  await page.getByRole('radio', { name: 'Default', exact: true }).press('ArrowDown');
  await expect(enhanced).toBeFocused();
  await expect(enhanced).toBeChecked();
  await expect(sample).toBeVisible();
  expect(await sample.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThan(initialSize);
  await expect(page.getByText('!', { exact: true })).toBeVisible();
  await audio.press('Space');
  await expect(audio).not.toBeChecked();
  await expect(sample).toBeVisible();
  await audio.press('Space');

  await save.press('Enter');
  await saveStarted;
  await expect(save).toBeDisabled();
  await expect(page.getByRole('status').filter({ hasText: 'Saving…' })).toHaveCount(1);
  await save.press('Enter');
  expect(writes).toBe(1);
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toHaveCount(0);
  releaseSave();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Couldn’t save monitoring preferences. Your changes are still here.');
  await expect(camera).toHaveValue(cameraId);
  await expect(enhanced).toBeChecked();
  await page.getByRole('button', { name: 'Retry', exact: true }).press('Enter');
  await expect(save).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toHaveText('Saved. Changes apply to later sessions.');
  expect(writes).toBe(2);
  await page.reload();
  await expect(camera).toHaveValue(cameraId);
  await expect(audio).toBeChecked();
  await expect(enhanced).toBeChecked();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toHaveCount(0);

  await page.screenshot({ path: test.info().outputPath('monitoring-desktop.png'), fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(camera).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: test.info().outputPath('monitoring-' + width + '.png'), fullPage: true });
  }
  await page.setViewportSize({ width: 640, height: 900 });
  const zoom = await page.addStyleTag({ content: 'html { zoom: 200% }' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(640);
  await expect(save).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('monitoring-200-percent.png'), fullPage: true });
  await zoom.evaluate((element) => element.parentNode?.removeChild(element));

  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await page.getByRole('link', { name: 'Start session' }).click();
  await expect(page.getByRole('heading', { name: 'Stationary readiness' })).toBeFocused();
  const handoff = page.getByRole('region', { name: 'Saved monitoring preferences' });
  await expect(handoff).toContainText('Integrated Camera');
  await expect(handoff).toContainText('Warning audio on');
  await expect(handoff).toContainText('Enhanced visibility');
  await expect(handoff.getByText('Eyes closed for 2 seconds', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start monitoring' })).toHaveCount(0);
});

test('D20 recovers from blocked access and a missing saved camera with a video-only recheck', async ({ page }) => {
  await signInFixture(page, 'monitoringA');
  await installCameraFixture(page, 'denied');
  const stored = { ...defaultPreferences, cameraDeviceId: cameraId };
  await page.route(api + '**', (route) => route.fulfill({ json: route.request().url() === api ? profileFixture(null) : stored }));
  await page.goto(origin + monitoringPath);
  const cameraStatus = page.getByRole('status').filter({ hasText: /camera/i });
  const recheck = page.getByRole('button', { name: 'Recheck', exact: true });
  await expect(cameraStatus).toContainText('Camera permission is blocked');
  await expect(cameraStatus).toContainText('Chrome site permissions');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.evaluate(() => {
    (window as unknown as { syntheticCamera: { mode: string } }).syntheticCamera.mode = 'missing';
  });
  await recheck.press('Enter');
  await expect(recheck).toBeFocused();
  await expect(cameraStatus).toContainText('Saved camera is unavailable');
  const probe = await page.evaluate(() => (window as unknown as {
    syntheticCamera: { constraints: MediaStreamConstraints[]; stopped: number };
  }).syntheticCamera);
  expect(probe.constraints).toHaveLength(1);
  expect(probe.constraints[0].audio).toBe(false);
  expect(probe.stopped).toBe(1);
  await expect(page.locator('video')).toHaveCount(0);
  const camera = page.getByRole('combobox', { name: 'Built-in camera' });
  await expect(camera).toHaveValue(cameraId);
  await camera.selectOption(alternateCameraId);
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeEnabled();
  await page.evaluate(() => {
    (window as unknown as { syntheticCamera: { mode: string } }).syntheticCamera.mode = 'unopenable';
  });
  await recheck.press('Enter');
  await expect(cameraStatus).toContainText('Checking camera access');
  await expect(save).toBeDisabled();
  await save.press('Enter');
  await expect(camera).not.toHaveAttribute('aria-invalid', 'true');
  await page.evaluate(() => window.dispatchEvent(new Event('release-camera-probe')));
  await expect(cameraStatus).toContainText('Selected camera is unavailable');
  await expect(camera).toHaveValue(alternateCameraId);
  await camera.selectOption(cameraId);
  await expect(camera).not.toHaveAttribute('aria-invalid', 'true');
});

test('D20 discards a previous driver’s late save response when Clerk switches accounts', async ({ page }) => {
  await signInFixture(page, 'monitoringA');
  await installCameraFixture(page, 'granted');
  let signalSave!: () => void;
  const saveStarted = new Promise<void>((resolve) => { signalSave = resolve; });
  let releaseSave!: () => void;
  const holdSave = new Promise<void>((resolve) => { releaseSave = resolve; });
  await page.route(api + '**', async (route) => {
    const request = route.request();
    const secondDriver = request.headers().authorization === 'Bearer synthetic-driver-B';
    if (request.url() === api) {
      return route.fulfill({ json: { ...profileFixture(null), accountId: secondDriver ? 'synthetic-b' : syntheticAccount } });
    }
    if (request.method() === 'PUT') {
      expect(secondDriver).toBe(false);
      signalSave();
      await holdSave;
      return route.fulfill({ json: request.postDataJSON() }).catch(() => {});
    }
    return route.fulfill({ json: secondDriver ? { ...defaultPreferences, cameraDeviceId: alternateCameraId } : defaultPreferences });
  });
  await page.goto(origin + monitoringPath);
  const camera = page.getByRole('combobox', { name: 'Built-in camera' });
  await camera.selectOption(cameraId);
  await page.getByRole('switch', { name: 'Warning audio' }).press('Space');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await saveStarted;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('rafiq-fixture-switch', { detail: {
    userId: 'user_monitoringB', sessionId: 'sess_monitoringB', token: 'synthetic-driver-B',
  } })));
  await expect(camera).toHaveValue(alternateCameraId);
  releaseSave();
  await expect(page.getByRole('switch', { name: 'Warning audio' })).not.toBeChecked();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toHaveCount(0);
  await expect(camera).toHaveValue(alternateCameraId);
});


test('D20 confirms video-only opt-in and D22 reads the acknowledged decision', async ({ page }) => {
  await signInFixture(page, 'recordingA');
  await installCameraFixture(page, 'granted');
  await page.route(api + '**', (route) => route.fulfill({
    json: route.request().url() === api ? profileFixture(null) : defaultPreferences,
  }));
  let stored = { revision: 'consent-0', settings: offRecording };
  let reads = 0;
  let writes = 0;
  let releaseRead!: () => void;
  const holdRead = new Promise<void>((resolve) => { releaseRead = resolve; });
  let releaseWrite!: () => void;
  const holdWrite = new Promise<void>((resolve) => { releaseWrite = resolve; });
  await page.route(consentApi, async (route) => {
    if (route.request().method() === 'GET' && ++reads === 1) {
      await holdRead;
      return route.fulfill({ status: 503, json: { code: 'account_unavailable' } });
    }
    if (route.request().method() === 'PUT') {
      writes++;
      const change = route.request().postDataJSON();
      expect(change.expectedRevision).toBe(stored.revision);
      if (writes === 1) {
        expect(change.settings).toEqual({ enabled: true, behaviors: ['drowsiness', 'phoneUse'], preSeconds: 0, postSeconds: 5 });
        await holdWrite;
      }
      stored = { revision: 'consent-' + writes, settings: change.settings };
    }
    return route.fulfill({ json: writes ? stored : { revision: 'consent-0', settings: { enabled: false, behaviors: [] } } });
  });

  await page.goto(origin + monitoringPath);
  const recording = page.getByRole('region', { name: 'Incident recording' });
  await expect(recording.getByRole('status')).toHaveText('Checking recording consent…');
  releaseRead();
  await expect(recording.getByRole('status')).toHaveText('Couldn’t check recording status.');
  await recording.getByRole('button', { name: 'Retry recording status' }).click();
  await expect(recording.getByRole('status')).toHaveText('Recording off');
  await expect(recording.getByText('Monitoring stays available with recording off.')).toBeVisible();
  const before = recording.getByRole('combobox', { name: 'Before incident' });
  const after = recording.getByRole('combobox', { name: 'After incident' });
  await expect(before).toBeDisabled();
  await expect(before).toHaveValue('3');
  await expect(after).toHaveValue('3');
  const optIn = recording.getByRole('checkbox', { name: 'Allow video-only incident clips' });
  await optIn.focus();
  await page.keyboard.press('Space');
  await recording.getByRole('checkbox', { name: 'Drowsiness' }).check();
  await recording.getByRole('checkbox', { name: 'Phone use' }).check();
  await expect(recording.getByRole('checkbox', { name: 'Reaching' })).toHaveCount(0);
  await before.focus();
  await page.keyboard.press('Home');
  await expect(before).toHaveValue('0');
  await after.selectOption('5');
  await expect(recording.getByText(/30 seconds and 20 MB/)).toBeVisible();
  await recording.getByText('How clips are saved').click();
  await expect(recording.getByText(/Available first segment/)).toBeVisible();

  const save = page.getByRole('button', { name: 'Save', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Allow video-only incident clips?' });
  await save.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(save).toBeFocused();
  expect(writes).toBe(0);
  await save.click();
  await dialog.getByRole('button', { name: 'Confirm recording' }).click();
  await expect.poll(() => writes).toBe(1);
  await expect(recording.getByRole('status')).toHaveText('Recording off');
  releaseWrite();
  await expect(recording.getByRole('status')).toHaveText('Recording allowed');

  await page.reload();
  await expect(recording.getByRole('status')).toHaveText('Recording allowed');
  await expect(before).toHaveValue('0');
  await expect(after).toHaveValue('5');
  await recording.getByRole('checkbox', { name: 'Drowsiness' }).uncheck();
  await recording.getByRole('checkbox', { name: 'Phone use' }).uncheck();
  await expect(recording.getByText(/no incidents match/)).toBeVisible();
  await save.click();
  await expect(page.getByText('Incident recording settings saved.')).toBeVisible();
  expect(stored.settings.behaviors).toEqual([]);

  await page.setViewportSize({ width: 320, height: 760 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await recording.getByRole('link', { name: 'Privacy', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Privacy' })).toBeFocused();
  const privacy = page.getByRole('region', { name: 'Incident recording' });
  await expect(privacy.getByRole('status')).toHaveText('Allowed for selected incidents');
  await expect(privacy.getByRole('button')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await privacy.getByRole('link', { name: 'Manage recording' }).click();
  await expect(page).toHaveURL(origin + monitoringPath + '#incident-recording');
  await expect(recording.getByRole('status')).toHaveText('Recording allowed');
});

test('D20 keeps failed drafts and requires review of a refreshed consent revision', async ({ page }) => {
  await signInFixture(page, 'recordingB');
  await installCameraFixture(page, 'granted');
  let preferenceWrites = 0;
  let general = defaultPreferences;
  await page.route(api + '**', (route) => {
    if (route.request().url() === api) return route.fulfill({ json: profileFixture(null) });
    if (route.request().method() === 'PUT') {
      preferenceWrites++;
      general = route.request().postDataJSON();
    }
    return route.fulfill({ json: general });
  });
  let stored = { revision: 'consent-1', settings: { ...offRecording, enabled: true, behaviors: ['eating'] } };
  let consentWrites = 0;
  await page.route(consentApi, (route) => {
    if (route.request().method() === 'PUT') {
      const change = route.request().postDataJSON();
      if (++consentWrites === 1) return route.fulfill({ status: 503, json: { code: 'account_unavailable' } });
      if (consentWrites === 2) {
        stored = { revision: 'consent-2', settings: { ...stored.settings, preSeconds: 1 } };
        return route.fulfill({ status: 409, json: { code: 'recording_consent_changed' } });
      }
      expect(change.expectedRevision).toBe('consent-2');
      expect(change.settings).toEqual({ enabled: true, behaviors: ['eating', 'drinking'], preSeconds: 3, postSeconds: 3 });
      stored = { revision: 'consent-3', settings: change.settings };
    }
    return route.fulfill({ json: stored });
  });
  await page.goto(origin + monitoringPath);
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await page.getByRole('switch', { name: 'Warning audio' }).check();
  await page.getByRole('checkbox', { name: 'Drinking' }).check();
  await save.click();
  await expect(page.getByText('Monitoring preferences saved.')).toBeVisible();
  await expect(page.getByText('Couldn’t save incident recording settings. Your changes are still here.')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Drinking' })).toBeChecked();
  await save.click();
  await expect(page.getByText(/Recording consent changed/)).toBeVisible();
  await expect(page.getByText(/Current context: 1 second before/)).toBeVisible();
  await expect(save).toBeDisabled();
  await page.getByRole('button', { name: 'I reviewed the current settings and draft' }).click();
  await expect(save).toBeFocused();
  await save.click();
  await expect(page.getByText('Incident recording settings saved.')).toBeVisible();
  expect(preferenceWrites).toBe(1);
});

test('D20 withdrawal fences a delayed acknowledgment, survives reload and preserves unrelated changes', async ({ page }) => {
  await signInFixture(page, 'recordingC');
  await installCameraFixture(page, 'granted');
  let preferenceWrites = 0;
  await page.route(api + '**', (route) => {
    if (route.request().url() === api) return route.fulfill({ json: profileFixture(null) });
    if (route.request().method() === 'PUT') {
      if (++preferenceWrites === 1) return route.fulfill({ status: 503, json: { code: 'account_unavailable' } });
      return route.fulfill({ json: route.request().postDataJSON() });
    }
    return route.fulfill({ json: defaultPreferences });
  });
  let stored = { revision: 'consent-1', settings: { ...offRecording, enabled: true, behaviors: ['eating'] } };
  let interrupted = true;
  let releaseEnable!: () => void;
  const holdEnable = new Promise<void>((resolve) => { releaseEnable = resolve; });
  await page.route(consentApi, async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: stored });
    const { expectedRevision, settings } = route.request().postDataJSON();
    if (settings.enabled) {
      expect(expectedRevision).toBe('consent-1');
      const stale = stored = { revision: 'consent-2', settings };
      await holdEnable;
      return route.fulfill({ json: stale }).catch(() => {});
    }
    if (interrupted) return route.abort();
    if (expectedRevision !== stored.revision) {
      return route.fulfill({ status: 409, json: { code: 'recording_consent_changed' } });
    }
    stored = { revision: 'consent-3', settings };
    return route.fulfill({ json: stored });
  });

  await page.goto(origin + monitoringPath);
  const recording = page.getByRole('region', { name: 'Incident recording' });
  await expect(recording.getByRole('status')).toHaveText('Recording allowed');
  const audio = page.getByRole('switch', { name: 'Warning audio' });
  await audio.check();
  await recording.getByRole('checkbox', { name: 'Drinking' }).check();
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await save.click();
  await expect.poll(() => stored.revision).toBe('consent-2');
  await recording.getByRole('button', { name: 'Withdraw recording consent' }).click();
  await expect(recording.getByRole('status')).toHaveText('Recording stopped on this device. Account update pending.');
  releaseEnable();
  await expect(recording.getByRole('button', { name: 'Retry withdrawal' })).toBeVisible();
  await expect(audio).toBeChecked();
  await save.click();
  await expect(page.getByText('Saved. Changes apply to later sessions.')).toBeVisible();
  expect(stored.settings.enabled).toBe(true);

  await page.reload();
  await expect(recording.getByRole('status')).toHaveText('Recording stopped on this device. Account update pending.');
  interrupted = false;
  await recording.getByRole('button', { name: 'Retry withdrawal' }).click();
  await expect(recording.getByRole('status')).toHaveText('Recording off');
  await expect(recording.getByRole('status')).toBeFocused();
  expect(stored.settings.enabled).toBe(false);
  await page.reload();
  await expect(recording.getByRole('status')).toHaveText('Recording off');
  expect(preferenceWrites).toBe(2);
});
