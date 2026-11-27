import { connection } from 'next/server';
import { AccountEntry } from '../../account-entry';

export const metadata = { title: 'Private workspace | RAFIQ' };

export default async function WorkspaceLinkPage({ params }: { params: Promise<{ item: string }> }) {
  await connection();
  const { item } = await params;
  // A private link is never a sign-in return. The driver can reopen it after sign-in.
  const linkId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(item) ? item : 'invalid';
  return <AccountEntry entry="account" destination="dashboard" linkId={linkId} />;
}
