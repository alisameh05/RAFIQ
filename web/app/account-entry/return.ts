export type PrivateDestination = 'dashboard' | 'readiness' | 'profile' | 'sessions' | 'privacy';
export type EntryContext = 'account' | PrivateDestination | undefined;

export function privateDestination(value: unknown): PrivateDestination | undefined {
  switch (value) {
    case 'dashboard':
    case 'readiness':
    case 'profile':
    case 'sessions':
    case 'privacy':
      return value;
    default:
      return undefined;
  }
}

export function entryContext(value: string | string[] | undefined): EntryContext {
  return value === 'account' ? value : privateDestination(value);
}

export function privatePath(destination: PrivateDestination) {
  return '/account/' + destination;
}

export function signInPath(entry: EntryContext, recover = false) {
  return (recover ? '/sign-in/recover' : '/sign-in') + (entry ? '?' + new URLSearchParams({ entry }) : '');
}

export function accountPath(entry: EntryContext, verified = false) {
  const query = new URLSearchParams();
  if (entry) query.set('entry', entry);
  if (verified) query.set('verified', '1');
  return '/account' + (query.size ? '?' + query : '');
}
