import { auth } from '@clerk/nextjs/server';
import { notFound, redirect } from 'next/navigation';
import { connection } from 'next/server';
import { accountApiOrigin, accountEntryEnabled } from '../account-entry/config';
import { EntryIdentity, EntryShell } from '../account-entry/shell';
import { AccountGate } from './account-gate';

export const metadata = { title: 'Account status | RAFIQ' };

export default async function AccountPage() {
  await connection();
  if (!accountEntryEnabled()) notFound();
  if (!(await auth()).userId) redirect('/sign-in');

  return <EntryIdentity><EntryShell><AccountGate apiOrigin={accountApiOrigin()} /></EntryShell></EntryIdentity>;
}
