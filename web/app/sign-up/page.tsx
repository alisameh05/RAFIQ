import { auth } from '@clerk/nextjs/server';
import { notFound, redirect } from 'next/navigation';
import { connection } from 'next/server';
import { accountEntryEnabled, signupOpen } from '../account-entry/config';
import { EntryIdentity, EntryShell } from '../account-entry/shell';
import { Signup } from './signup';

export const metadata = { title: 'Create an account | RAFIQ' };

export default async function SignupPage() {
  await connection();
  if (!accountEntryEnabled()) notFound();
  if (!signupOpen()) redirect('/');
  if ((await auth()).userId) redirect('/account');

  return <EntryIdentity><EntryShell artwork><Signup /></EntryShell></EntryIdentity>;
}
