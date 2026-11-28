import { notFound, redirect } from 'next/navigation';
import { connection } from 'next/server';
import { accountEntryEnabled, socialEntryOrigin, signupOpen } from './config';
import { socialReturnPath, validSocialAttempt, type SocialProvider } from './social-return';
import { entryContext } from './return';
import { EntryIdentity, EntryShell } from './shell';
import { SocialCallback } from './social-callback';

export type SocialCallbackProps = {
  searchParams: Promise<{ attempt?: string | string[]; entry?: string | string[]; error?: string | string[] }>;
};

export async function SocialCallbackPage({ searchParams, provider }: SocialCallbackProps & { provider: SocialProvider }) {
  await connection();
  if (!accountEntryEnabled()) notFound();
  const { attempt, entry: rawEntry, error } = await searchParams;
  const entry = entryContext(rawEntry);
  const origin = await socialEntryOrigin(provider);
  if (!origin) redirect(socialReturnPath(provider, entry, 'unavailable'));
  if (!validSocialAttempt(attempt) || (rawEntry !== undefined && !entry)) {
    redirect(socialReturnPath(provider, entry, 'failed'));
  }
  return <EntryIdentity redirectOrigin={origin}>
    <EntryShell artwork>
      <SocialCallback provider={provider} origin={origin} attempt={attempt} entry={entry} signupOpen={signupOpen()}
        cancelled={error === 'access_denied'} />
    </EntryShell>
  </EntryIdentity>;
}
