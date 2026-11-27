import { auth } from '@clerk/nextjs/server';
import { notFound, redirect } from 'next/navigation';
import { connection } from 'next/server';
import { accountApiOrigin, accountEntryEnabled } from '../account-entry/config';
import { entryContext, signInPath } from '../account-entry/return';
import { EntryIdentity, EntryShell } from '../account-entry/shell';
import { AccountGate } from './account-gate';

export const metadata = { title: 'Account status | RAFIQ' };

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ entry?: string | string[] }> }) {
  await connection();
  if (!accountEntryEnabled()) notFound();
  const entry = entryContext((await searchParams).entry) ?? 'account';
  if (!(await auth()).userId) redirect(signInPath(entry));

  return <EntryIdentity><EntryShell><AccountGate apiOrigin={accountApiOrigin()} entry={entry} /></EntryShell></EntryIdentity>;
}
