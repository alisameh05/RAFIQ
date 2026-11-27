import { auth } from '@clerk/nextjs/server';
import { notFound, redirect } from 'next/navigation';
import { accountApiOrigin, accountEntryEnabled } from '../account-entry/config';
import { signInPath, type EntryContext, type PrivateDestination } from '../account-entry/return';
import { EntryIdentity, EntryShell } from '../account-entry/shell';
import { AccountGate } from './account-gate';

export async function AccountEntry({ entry, destination, linkId }: {
  entry: EntryContext;
  destination?: PrivateDestination;
  linkId?: string;
}) {
  if (!accountEntryEnabled()) notFound();
  if (!(await auth()).userId) redirect(signInPath(entry));
  return <EntryIdentity><EntryShell><AccountGate apiOrigin={accountApiOrigin()} entry={entry} destination={destination} linkId={linkId} /></EntryShell></EntryIdentity>;
}
