import { privatePath } from './return';

export const appleLinkCallback = '/account/apple/callback';
export const appleLinkAttemptKey = 'rafiq.apple-link-attempt';
export type AppleLinkResult = 'connected' | 'cancelled' | 'failed' | 'unavailable';

export function appleLinkResult(value: unknown): AppleLinkResult | undefined {
  switch (value) {
    case 'connected':
    case 'cancelled':
    case 'failed':
    case 'unavailable':
      return value;
  }
}

export function appleLinkReturnPath(result: AppleLinkResult) {
  return privatePath('profile') + '?appleLink=' + result;
}
