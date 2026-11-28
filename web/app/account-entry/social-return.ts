import { signInPath, type EntryContext } from './return';

export type SocialProvider = 'google' | 'apple';
export type SocialResult = 'cancelled' | 'failed' | 'unavailable' | 'signup-held' | 'restricted' | 'verify';

export const socialNames = { google: 'Google', apple: 'Apple' } as const;

export function socialAttemptKey(provider: SocialProvider) {
  return 'rafiq.' + provider + '-attempt';
}

export function socialCallbackPath(provider: SocialProvider) {
  return '/sign-in/' + provider + '/callback';
}

export function socialFeedback(provider: SocialProvider, result: SocialResult) {
  const name = socialNames[provider];
  switch (result) {
    case 'cancelled': return name + ' sign-in was canceled. Try again or use email and password.';
    case 'failed': return name + ' sign-in didn’t finish. Try again or use email and password.';
    case 'unavailable': return name + ' sign-in is unavailable here. Use email and password.';
    case 'signup-held': return 'Public signup is pending release. If you already have an account, sign in.';
  }
}

export function socialResult(value: unknown): SocialResult | undefined {
  switch (value) {
    case 'cancelled':
    case 'failed':
    case 'unavailable':
    case 'signup-held':
    case 'restricted':
    case 'verify':
      return value;
  }
}

export function socialReturnPath(provider: SocialProvider, entry: EntryContext, result: SocialResult) {
  return signInPath(entry) + (entry ? '&' : '?') + provider + '=' + result;
}

export function validSocialAttempt(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
}
