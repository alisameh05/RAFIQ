import 'server-only';

export function accountEntryEnabled() {
  return process.env.RAFIQ_ACCOUNT_ENTRY === 'true';
}

export function signupOpen() {
  return accountEntryEnabled()
    && process.env.RAFIQ_SIGNUP_MODE === 'test-open'
    && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.startsWith('pk_test_') === true
    && process.env.CLERK_SECRET_KEY?.startsWith('sk_test_') === true;
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
