import { auth } from '@clerk/nextjs/server';
import { notFound, redirect } from 'next/navigation';
import { connection } from 'next/server';
import { accountEntryEnabled, googleEntryOrigin, publishedSupportContact, signupOpen } from '../../account-entry/config';
import { googleResult } from '../../account-entry/google-return';
import { accountPath, entryContext } from '../../account-entry/return';
import { EntryIdentity, EntryShell } from '../../account-entry/shell';
import { DriverAccess } from '../driver-access';

type Props = {
  params: Promise<{ step?: string[] }>;
  searchParams: Promise<{ entry?: string | string[]; google?: string | string[] }>;
};

export async function generateMetadata({ params }: Props) {
  return { title: (await params).step?.[0] === 'recover' ? 'Recover access | RAFIQ' : 'Sign in | RAFIQ' };
}

export default async function SignInPage({ params, searchParams }: Props) {
  await connection();
  if (!accountEntryEnabled()) notFound();

  const { step } = await params;
  const recover = step?.length === 1 && step[0] === 'recover';
  if (step?.length && !recover) notFound();
  const query = await searchParams;
  const entry = entryContext(query.entry);
  if ((await auth()).userId) redirect(accountPath(entry));
  const googleOrigin = recover ? undefined : await googleEntryOrigin();

  return (
    <EntryIdentity>
      <EntryShell artwork>
        <DriverAccess key={recover ? 'recover' : 'sign-in'} entry={entry} recover={recover} registrationOpen={signupOpen()}
          supportContact={publishedSupportContact()} googleOrigin={googleOrigin} googleReturn={googleResult(query.google)} />
      </EntryShell>
    </EntryIdentity>
  );
}
