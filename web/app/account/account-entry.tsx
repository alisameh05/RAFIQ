import { auth } from '@clerk/nextjs/server';
import { notFound, redirect } from 'next/navigation';
import { accountApiOrigin, accountEntryEnabled, profileIdentityEnabled, socialEntryOrigin } from '../account-entry/config';
import type { AppleLinkResult } from '../account-entry/apple-link-return';
import { signInPath, type EntryContext, type PrivateDestination } from '../account-entry/return';
import { EntryIdentity, EntryShell } from '../account-entry/shell';
import { AccountGate } from './account-gate';

export async function AccountEntry({ entry, destination, linkId, appleLinkResult }: {
  entry: EntryContext;
  destination?: PrivateDestination;
  linkId?: string;
  appleLinkResult?: AppleLinkResult;
}) {
  if (!accountEntryEnabled()) notFound();
  if (!(await auth()).userId) redirect(signInPath(entry));
  const appleOrigin = destination === 'profile' ? await socialEntryOrigin('apple') : undefined;
  return <EntryIdentity redirectOrigin={appleOrigin}><EntryShell><AccountGate apiOrigin={accountApiOrigin()} entry={entry}
    destination={destination} linkId={linkId} identityManagementEnabled={profileIdentityEnabled()}
    appleOrigin={appleOrigin} appleLinkResult={appleLinkResult} /></EntryShell></EntryIdentity>;
}
