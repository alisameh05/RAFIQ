import { sign } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

const origin = process.env.RAFIQ_LANDING_PENDING_ORIGIN;
const provider = 'https://oauth.example.test';
const api = 'https://accounts.example.test/api/v1';
export const workspaceLink = '11111111-1111-4111-8111-111111111111';
export const appleRelay = 'hidden-address@relay.example.test';

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

export async function socialFixture(page: Page, social: 'google' | 'apple', pauseGoogle = false) {
  const sessions = {
    email: signedSession('user_existing', 'sess_email'),
    linked: signedSession('user_existing', 'sess_linked'),
    returning: signedSession('user_existing', 'sess_returning'),
    new: signedSession('user_new', 'sess_new'),
  };
  const consentVersion = social + '-fixture-2';
  const name = social === 'apple' ? 'Apple' : 'Google';
  const existing = { accountId: 'account-existing', displayName: 'Original owned profile', acceptedVersion: consentVersion };
  const newDriver = { accountId: 'account-new', displayName: null, acceptedVersion: null as string | null };
  await page.context().addCookies([{ url: origin!, name: '__clerk_db_jwt', value: 'synthetic-development-browser' }]);
  await page.route('https://clerk.example.test/**', (route) => route.abort());
  await page.route(provider + '/authorize**', (route) => {
    const callback = new URL(new URL(route.request().url()).searchParams.get('callback')!);
    expect(callback.origin).toBe(origin);
    expect(['/sign-in/' + social + '/callback', ...(social === 'apple' ? ['/account/apple/callback'] : [])])
      .toContain(callback.pathname);
    return route.fulfill({ contentType: 'text/html', body: '<h1>Synthetic ' + name + ' authorization</h1>' });
  });
  await page.route(api + '/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.slice('/api/v1'.length);
    const current = Object.values(sessions).find((identity) => request.headers().authorization === 'Bearer ' + identity.token);
    if (!current) return route.fulfill({ status: 401, json: { code: 'authentication_required' } });
    const record = current.subject === sessions.new.subject ? newDriver : existing;
    const account = () => ({ ...record, verified: true, status: record.acceptedVersion === consentVersion ? 'active' : 'onboardingRequired',
      requiredVersion: consentVersion, registeredEmail: record === newDriver && social === 'apple' ? appleRelay : 'driver@example.test' });
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
  await page.addInitScript(({ sessions, provider, origin, social, appleRelay, pauseGoogle }) => {
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
    const verifyApple = () => localStorage.getItem('fixture-apple-verified-subject') === sessions.email.subject;
    const appleAccount = {
      id: 'external_apple_synthetic', provider: 'apple', emailAddress: appleRelay,
      verification: { status: 'unverified', error: null as { code: string } | null,
        externalVerificationRedirectURL: null as URL | null },
      async reauthorize({ redirectUrl }: { redirectUrl: string }) {
        appleAccount.verification.externalVerificationRedirectURL =
          new URL(provider + '/authorize?' + new URLSearchParams({ callback: redirectUrl }));
        return appleAccount;
      },
    };
    const user = active ? {
      id: active.subject, deleteSelfEnabled: false,
      externalAccounts: active.subject === sessions.email.subject && verifyApple()
        ? [{ ...appleAccount, verification: { ...appleAccount.verification, status: 'verified' } }]
        : sessionStorage.getItem('fixture-apple-link-subject') === active.subject ? [appleAccount] : [],
      async createExternalAccount({ strategy, redirectUrl }: { strategy: string; redirectUrl: string }) {
        if (strategy !== 'oauth_apple' || active.subject !== sessions.email.subject || this.externalAccounts.length) {
          throw new Error('Unexpected Apple link');
        }
        sessionStorage.setItem('fixture-apple-link-subject', active.subject);
        return appleAccount.reauthorize({ redirectUrl });
      },
      async reload() {
        if (sessionStorage.getItem('fixture-apple-link-subject') !== active.subject) return user;
        const result = new URLSearchParams(location.search).get('fixture');
        if (result === 'link-verified') {
          localStorage.setItem('fixture-apple-verified-subject', active.subject);
          appleAccount.verification.status = 'verified';
        }
        if (result === 'cancelled') appleAccount.verification.error = { code: 'oauth_access_denied' };
        return { ...user, externalAccounts: [appleAccount] };
      },
    } : null;
    const ok = { error: null };
    let resetAddress = '';
    const signIn = {
      resetPasswordEmailCode: {
        async sendCode() {
          if (resetAddress !== appleRelay) throw new Error('Unexpected recovery address');
          return ok;
        },
      },
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
      async create({ strategy, redirectUrl, identifier }: { strategy?: string; redirectUrl: string; identifier?: string }) {
        if (identifier) {
          resetAddress = identifier;
          return ok;
        }
        if (strategy !== 'oauth_' + social) throw new Error('Unexpected strategy');
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
        if ((social === 'google' && result === 'linked')
            || (result === 'returning' && (social === 'google' || verifyApple()))) signIn.status = 'complete';
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
  }, { sessions, provider, origin, social, appleRelay, pauseGoogle });
  return {
    async switchDriverSession() {
      await page.context().addCookies([
        { url: origin!, name: '__session', value: sessions.returning.token },
        { url: origin!, name: '__client_uat', value: String(sessions.returning.now) },
      ]);
    },
  };
}

export async function providerReturn(page: Page, result: string, callback: URL) {
  callback.searchParams.set('redirect_url', 'https://outside.example/private');
  callback.searchParams.set('fixture', result);
  await page.goto(callback.href);
}

export async function emailSignIn(page: Page) {
  await page.getByLabel('Email address', { exact: true }).fill('driver@example.test');
  await page.getByLabel('Password', { exact: true }).fill('Fixture-password-42');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
