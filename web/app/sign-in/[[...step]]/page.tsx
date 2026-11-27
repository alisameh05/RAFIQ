import { SignIn } from '@clerk/nextjs';
import { auth } from '@clerk/nextjs/server';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { connection } from 'next/server';
import { accountEntryEnabled, signupOpen } from '../../account-entry/config';
import { EntryIdentity, EntryShell } from '../../account-entry/shell';

export const metadata = { title: 'Sign in | RAFIQ' };

export default async function SignInPage() {
  await connection();
  if (!accountEntryEnabled()) notFound();
  if ((await auth()).userId) redirect('/account');

  return (
    <EntryIdentity><EntryShell>
      <SignIn path="/sign-in" routing="path" forceRedirectUrl="/account" withSignUp={false}
        appearance={{ elements: { footerAction: { display: 'none' } } }} />
      {signupOpen() && <p><Link href="/sign-up">Create account</Link></p>}
    </EntryShell></EntryIdentity>
  );
}
