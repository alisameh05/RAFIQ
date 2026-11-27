import { connection } from 'next/server';
import { entryContext } from '../account-entry/return';
import { AccountEntry } from './account-entry';

export const metadata = { title: 'Account status | RAFIQ' };

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ entry?: string | string[] }> }) {
  await connection();
  const entry = entryContext((await searchParams).entry) ?? 'account';
  return <AccountEntry entry={entry} />;
}
