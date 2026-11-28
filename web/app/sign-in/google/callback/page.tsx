import { notFound, redirect } from 'next/navigation';
import { connection } from 'next/server';
import { accountEntryEnabled, googleEntryOrigin, signupOpen } from '../../../account-entry/config';
import { googleReturnPath } from '../../../account-entry/google-return';
import { entryContext } from '../../../account-entry/return';
import { EntryIdentity, EntryShell } from '../../../account-entry/shell';
import { GoogleCallback } from './google-callback';

export const metadata = { title: 'Continue with Google | RAFIQ', referrer: 'no-referrer' };

type Props = {
  searchParams: Promise<{ attempt?: string | string[]; entry?: string | string[]; error?: string | string[] }>;
};

export default async function GoogleCallbackPage({ searchParams }: Props) {
  await connection();
  if (!accountEntryEnabled()) notFound();
  const { attempt, entry: rawEntry, error } = await searchParams;
  const entry = entryContext(rawEntry);
  const origin = await googleEntryOrigin();
  if (!origin) redirect(googleReturnPath(entry, 'unavailable'));
  if (typeof attempt !== 'string' || !/^[a-f0-9-]{36}$/.test(attempt) || (rawEntry !== undefined && !entry)) {
    redirect(googleReturnPath(entry, 'failed'));
  }
  return <EntryIdentity redirectOrigin={origin}>
    <EntryShell artwork>
      <GoogleCallback origin={origin} attempt={attempt} entry={entry} signupOpen={signupOpen()}
        cancelled={error === 'access_denied'} />
    </EntryShell>
  </EntryIdentity>;
}
