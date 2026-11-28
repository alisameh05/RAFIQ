import { sign } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const origin = process.env.RAFIQ_LANDING_PENDING_ORIGIN;
const mode = process.env.RAFIQ_GOOGLE_FIXTURE;
const consentVersion = 'google-fixture-2';
const provider = 'https://oauth.example.test';
const api = 'https://accounts.example.test/api/v1';
const workspaceLink = '11111111-1111-4111-8111-111111111111';

test.beforeEach(() => {
  test.skip(!origin || !mode, 'Requires the isolated Google web fixture.');
});

function signedSession(subject: string, session: string) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = encode({ alg: 'RS256', typ: 'JWT', kid: 'synthetic', cat: 'cl_B7d4PD111AAA' }) + '.' + encode({
    sub: subject, sid: session, iss: 'https://clerk.example.test', azp: origin,
    iat: now, nbf: now - 10, exp: now + 300, sts: 'active',
  });
  return { subject, session, now, token: data + '.' + sign('RSA-SHA256', Buffer.from(data),
    process.env.RAFIQ_LOCAL_CLERK_KEY!).toString('base64url') };
}

async function googleFixture(page: Page, pauseGoogle = false) {
  const sessions = {
    email: signedSession('user_existing', 'sess_email'),
    linked: signedSession('user_existing', 'sess_linked'),
    returning: signedSession('user_existing', 'sess_returning'),
    new: signedSession('user_new', 'sess_new'),
  };
  const existing = { accountId: 'account-existing', displayName: 'Original owned profile', acceptedVersion: consentVersion };
  const newDriver = { accountId: 'account-new', displayName: null, acceptedVersion: null as string | null };
  await page.context().addCookies([{ url: origin!, name: '__clerk_db_jwt', value: 'synthetic-development-browser' }]);
  await page.route('https://clerk.example.test/**', (route) => route.abort());
  await page.route(provider + '/authorize**', (route) => {
    const callback = new URL(new URL(route.request().url()).searchParams.get('callback')!);
    expect(callback.origin).toBe(origin);
    expect(callback.pathname).toBe('/sign-in/google/callback');
    return route.fulfill({ contentType: 'text/html', body: '<h1>Synthetic Google authorization</h1><main></main>' });
  });
  await page.route(api + '/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.slice('/api/v1'.length);
    const current = Object.values(sessions).find((identity) => request.headers().authorization === 'Bearer ' + identity.token);
    if (!current) return route.fulfill({ status: 401, json: { code: 'authentication_required' } });
    const record = current.subject === sessions.new.subject ? newDriver : existing;
    const account = () => ({ ...record, verified: true, status: record.acceptedVersion === consentVersion ? 'active' : 'onboardingRequired',
      requiredVersion: consentVersion, registeredEmail: 'driver@example.test' });
    if (path === '/account') return route.fulfill({ json: account() });
    if (path === '/account/controlled-use' && request.method() === 'PUT') {
      expect(request.postDataJSON()).toEqual({ accepted: true, version: consentVersion });
      record.acceptedVersion = consentVersion;
      return route.fulfill({ json: account() });
    }
    if (path === '/account/controlled-use') return route.fulfill({ json: {
      version: consentVersion, stationary: 'Set up while stationary.', supervised: 'Use approved supervision.',
      camera: 'Check the front-facing camera.', recording: 'Choose recording separately.',
    } });
    if (path === '/account/workspace') {
      return route.fulfill({ json: { destination: 'dashboard', accountId: record.accountId, acceptedVersion: record.acceptedVersion } });
    }
    if (path === '/account/links/' + workspaceLink) {
      if (record !== existing) return route.fulfill({ status: 404, json: { code: 'resource_unavailable' } });
      return route.fulfill({ json: { destination: 'dashboard', accountId: record.accountId,
        acceptedVersion: record.acceptedVersion, expiresInMs: 60_000 } });
    }
    return route.fulfill({ status: 404, json: { code: 'not_found' } });
  });
  await page.addInitScript(({ sessions, provider, origin, pauseGoogle }) => {
    if (location.origin !== origin) return;
    function activate(identity: typeof sessions.email, target: string) {
      document.cookie = '__session=' + identity.token + '; path=/';
      document.cookie = '__client_uat=' + identity.now + '; path=/';
      window.location.assign(target);
    }
    const active = Object.values(sessions).find(({ token }) => document.cookie.includes('__session=' + token));
    const session = active ? {
      id: active.session, status: 'active', getToken: async () => active.token,
      lastActiveToken: { jwt: { claims: { sub: active.subject, sid: active.session, sts: 'active' } } },
    } : null;
    const user = active ? { id: active.subject, deleteSelfEnabled: false } : null;
    const ok = { error: null };
    const signIn = {
      id: sessionStorage.getItem('synthetic-clerk-sign-in'),
      status: 'needs_identifier',
      firstFactorVerification: {
        error: null as { code: string } | null, status: null as string | null, externalVerificationRedirectURL: null as URL | null,
      },
      async reset() { signIn.status = 'needs_identifier'; return ok; },
      async password() { signIn.status = 'complete'; return ok; },
      async finalize({ navigate }: { navigate: (state: { session: object; decorateUrl: (path: string) => string }) => void }) {
        navigate({ session: {}, decorateUrl: (path) => {
          document.cookie = '__session=' + sessions.email.token + '; path=/';
          document.cookie = '__client_uat=' + sessions.email.now + '; path=/';
          return path;
        } });
        return ok;
      },
      async create({ strategy, redirectUrl }: { strategy: string; redirectUrl: string }) {
        if (strategy !== 'oauth_google') throw new Error('Unexpected strategy');
        if (pauseGoogle) await new Promise<void>((resolve) => {
          window.addEventListener('synthetic-google-ready', () => resolve(), { once: true });
        });
        signIn.id = crypto.randomUUID();
        sessionStorage.setItem('synthetic-clerk-sign-in', signIn.id);
        signIn.firstFactorVerification.status = 'unverified';
        signIn.firstFactorVerification.externalVerificationRedirectURL =
          new URL(provider + '/authorize?' + new URLSearchParams({ callback: redirectUrl }));
        return signIn;
      },
      async reload() {
        const result = new URLSearchParams(location.search).get('fixture');
        if (result === 'cancelled') signIn.firstFactorVerification.error = { code: 'oauth_access_denied' };
        if (result === 'new') signIn.firstFactorVerification.status = 'transferable';
        if (result === 'linked' || result === 'returning') signIn.status = 'complete';
        return signIn;
      },
    };
    const signUp = { status: null, verifications: { emailAddress: {} } };
    const client = { signIn, signUp, sessions: session ? [session] : [] };
    const resources = { client, session, user, organization: null };
    const signInSnapshot = { signIn, fetchStatus: 'idle', errors: {} };
    const signUpSnapshot = { signUp, fetchStatus: 'idle', errors: {} };
    const clerk = {
      loaded: true, ...resources, __internal_lastEmittedResources: resources,
      __internal_state: {
        signInSignal: () => signInSnapshot,
        signUpSignal: () => signUpSnapshot,
        __internal_effect(effect: () => void) { effect(); return () => {}; },
      },
      on(event: string, listener: (status: string) => void) {
        if (event === 'status') queueMicrotask(() => listener('ready'));
      },
      off() {},
      buildUrlWithAuth(url: string) { return url; },
      addListener(listener: (state: object) => void) {
        queueMicrotask(() => listener(resources)); return () => {};
      },
      async handleRedirectCallback(options: { transferable: boolean; signUpForceRedirectUrl: string; signInForceRedirectUrl: string },
        fallback: (url: string) => Promise<void>) {
        const result = new URLSearchParams(location.search).get('fixture');
        if (result === 'new') {
          signIn.firstFactorVerification.status = 'transferable';
          if (options.transferable) activate(sessions.new, options.signUpForceRedirectUrl);
          else await fallback('/unexpected-provider-fallback');
        } else if (result === 'linked' || result === 'returning') {
          activate(sessions[result], options.signInForceRedirectUrl);
        } else {
          await fallback('https://outside.example/unsafe');
          return;
        }
        if (result !== 'new' || options.transferable) {
          // Simulate the SDK completing a session before its navigation resolves.
          clerk.session = { id: 'synthetic', status: 'active', getToken: async () => '',
            lastActiveToken: { jwt: { claims: { sub: '', sid: '', sts: 'active' } } } };
        }
      },
      async signOut({ redirectUrl }: { redirectUrl: string }) {
        document.cookie = '__session=; path=/; max-age=0';
        document.cookie = '__client_uat=; path=/; max-age=0';
        window.location.assign(redirectUrl);
      },
    };
    Object.defineProperty(window, 'Clerk', { value: clerk });
  }, { sessions, provider, origin, pauseGoogle });
}

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

async function providerReturn(page: Page, result: string, callback: URL) {
  callback.searchParams.set('redirect_url', 'https://outside.example/private');
  callback.searchParams.set('fixture', result);
  await page.goto(callback.href);
}

async function emailSignIn(page: Page) {
  await page.getByLabel('Email address', { exact: true }).fill('driver@example.test');
  await page.getByLabel('Password', { exact: true }).fill('Fixture-password-42');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
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
  await googleFixture(page);
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
  await googleFixture(page, true);
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
  await googleFixture(page);
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
  await googleFixture(page);
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
  await googleFixture(page);
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
  await googleFixture(page);
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
  await googleFixture(page);
  await page.goto(origin + '/sign-in/google/callback?attempt=abf906df-9c96-4ccc-af9c-cf01e1f8c0f2&fixture=linked');
  await expect(page).toHaveURL(origin + '/sign-in?google=failed');
  await expect(page.getByRole('main').getByRole('alert')).toContainText('didn’t finish');
});
