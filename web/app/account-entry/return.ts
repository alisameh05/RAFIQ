export type EntryContext = 'account' | undefined;

export function entryContext(value: string | string[] | undefined): EntryContext {
  return value === 'account' ? value : undefined;
}

export function signInPath(entry: EntryContext, recover = false) {
  return (recover ? '/sign-in/recover' : '/sign-in') + (entry === 'account' ? '?entry=account' : '');
}

export function accountPath(entry: EntryContext, verified = false) {
  const query = new URLSearchParams();
  if (entry === 'account') query.set('entry', entry);
  if (verified) query.set('verified', '1');
  return '/account' + (query.size ? '?' + query : '');
}
