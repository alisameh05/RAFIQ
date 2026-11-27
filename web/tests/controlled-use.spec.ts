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
    const session = {
      id: sessionId, status: 'active', getToken: async () => token,
      lastActiveToken: { jwt: { claims: { sub: userId, sid: sessionId, sts: 'active' } } },
    };
    const user = { id: userId };
    const client = { sessions: [session] };
    const resources = { client, session, user, organization: null };
    Object.defineProperty(window, 'Clerk', { value: {
      loaded: true, ...resources,
      __internal_lastEmittedResources: resources,
      on(event: string, listener: (status: string) => void) {
        if (event === 'status') queueMicrotask(() => listener('ready'));
      },
      off() {},
      addListener(listener: (resources: object) => void) {
        queueMicrotask(() => listener(resources));
        return () => {};
      },
      async signOut({ redirectUrl }: { redirectUrl: string }) {
        document.cookie = '__session=; path=/; max-age=0';
        document.cookie = '__client_uat=; path=/; max-age=0';
        window.location.assign(redirectUrl);
      },
    } });
  }, { userId, sessionId, token });
}

test.beforeEach(() => {
  test.skip(!origin || !process.env.RAFIQ_LOCAL_CLERK_KEY, 'Requires the isolated local web fixture.');
});

test('a signed-out readiness link carries a fixed entry, and external or ambiguous returns are dropped', async ({ request }) => {
  const readiness = await request.get(origin + '/account/readiness', { maxRedirects: 0 });
  expect(readiness.headers().location).toBe('/sign-in?entry=readiness');
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
