import { signInPath, type EntryContext } from './return';

export type GoogleResult = 'cancelled' | 'failed' | 'unavailable' | 'signup-held' | 'restricted' | 'verify';
export const googleAttemptKey = 'rafiq.google-attempt';
export const googleCallbackPath = '/sign-in/google/callback';

export const googleFeedback: Partial<Record<GoogleResult, string>> = {
  cancelled: 'Google sign-in was canceled. Try again or use email and password.',
  failed: 'Google sign-in didn’t finish. Try again or use email and password.',
  unavailable: 'Google sign-in is unavailable here. Use email and password.',
  'signup-held': 'Public signup is pending release. If you already have an account, sign in.',
};

export function googleResult(value: unknown): GoogleResult | undefined {
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

export function googleReturnPath(entry: EntryContext, result: GoogleResult) {
  return signInPath(entry) + (entry ? '&' : '?') + 'google=' + result;
}
