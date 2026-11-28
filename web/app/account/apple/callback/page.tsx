import { auth } from '@clerk/nextjs/server';
import { notFound, redirect } from 'next/navigation';
import { connection } from 'next/server';
import { appleLinkReturnPath } from '../../../account-entry/apple-link-return';
import { accountEntryEnabled, socialEntryOrigin } from '../../../account-entry/config';
import { signInPath } from '../../../account-entry/return';
import { EntryIdentity, EntryShell } from '../../../account-entry/shell';
import { validSocialAttempt } from '../../../account-entry/social-return';
import { AppleLinkCallback } from './apple-link-callback';

export const metadata = { title: 'Connect Apple | RAFIQ', referrer: 'no-referrer' };

export default async function AppleLinkCallbackPage({ searchParams }: {
  searchParams: Promise<{ attempt?: string | string[]; error?: string | string[] }>;
}) {
  await connection();
  if (!accountEntryEnabled()) notFound();
  if (!(await auth()).userId) redirect(signInPath('profile'));
  const origin = await socialEntryOrigin('apple');
  if (!origin) redirect(appleLinkReturnPath('unavailable'));
  const { attempt, error } = await searchParams;
  if (!validSocialAttempt(attempt)) redirect(appleLinkReturnPath('failed'));
  return <EntryIdentity redirectOrigin={origin}>
    <EntryShell>
      <AppleLinkCallback origin={origin} attempt={attempt} cancelled={error === 'access_denied'} />
    </EntryShell>
  </EntryIdentity>;
}
