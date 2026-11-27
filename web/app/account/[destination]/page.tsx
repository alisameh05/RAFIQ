import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { privateDestination } from '../../account-entry/return';
import { AccountEntry } from '../account-entry';

export const metadata = { title: 'Private workspace | RAFIQ' };

export default async function PrivatePage({ params }: { params: Promise<{ destination: string }> }) {
  await connection();
  const destination = privateDestination((await params).destination);
  if (!destination) notFound();
  return <AccountEntry entry={destination} destination={destination} />;
}
