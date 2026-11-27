export type PrivateDestination = 'dashboard' | 'readiness';
export type EntryContext = 'account' | PrivateDestination | undefined;

export function privateDestination(value: unknown): PrivateDestination | undefined {
  return value === 'dashboard' || value === 'readiness' ? value : undefined;
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
