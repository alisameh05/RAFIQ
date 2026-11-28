import 'server-only';
import { headers } from 'next/headers';
import type { SocialProvider } from './social-return';

export function accountEntryEnabled() {
  return process.env.RAFIQ_ACCOUNT_ENTRY === 'true';
}

export function signupOpen() {
  return accountEntryEnabled()
    && process.env.RAFIQ_SIGNUP_MODE === 'test-open'
    && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.startsWith('pk_test_') === true
    && process.env.CLERK_SECRET_KEY?.startsWith('sk_test_') === true;
}

export async function socialEntryOrigin(provider: SocialProvider): Promise<string | undefined> {
  const origin = process.env.RAFIQ_WEB_ORIGIN;
  const enabled = provider === 'apple' ? process.env.RAFIQ_APPLE_SIGN_IN : process.env.RAFIQ_GOOGLE_SIGN_IN;
  if (!accountEntryEnabled() || enabled !== 'true' || !origin) return;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return;
  }
  const developmentLoopback = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)
    && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.startsWith('pk_test_')
    && process.env.CLERK_SECRET_KEY?.startsWith('sk_test_');
  if (url.origin === origin && (url.protocol === 'https:' || developmentLoopback)
      && (await headers()).get('host') === url.host) return origin;
}

export function profileIdentityEnabled() {
  return process.env.RAFIQ_CLERK_PROFILE_ENABLED === 'true';
}

export function publishedSupportContact(): string | undefined {
  const contact = process.env.RAFIQ_SUPPORT_CONTACT;
  return contact && /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9.-]{1,189}$/.test(contact) ? contact : undefined;
}

export function accountApiOrigin(): string | null {
  const origin = process.env.RAFIQ_ACCOUNT_API_ORIGIN;
  if (origin === 'http://127.0.0.1:8000' && process.env.NODE_ENV !== 'production') return origin;
  try {
    const url = new URL(origin ?? '');
    return url.protocol === 'https:' && url.origin === origin ? origin : null;
  } catch {
    return null;
  }
}
