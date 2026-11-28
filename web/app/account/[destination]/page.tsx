import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { appleLinkResult } from '../../account-entry/apple-link-return';
import { privateDestination, privateTitles } from '../../account-entry/return';
import { AccountEntry } from '../account-entry';

type DestinationPage = {
  params: Promise<{ destination: string }>;
  searchParams: Promise<{ appleLink?: string | string[] }>;
};

export async function generateMetadata({ params }: DestinationPage) {
  const destination = privateDestination((await params).destination);
  return { title: (destination ? privateTitles[destination] : 'Private workspace') + ' | RAFIQ' };
}

export default async function PrivatePage({ params, searchParams }: DestinationPage) {
  await connection();
  const destination = privateDestination((await params).destination);
  if (!destination) notFound();
  const result = destination === 'profile' ? appleLinkResult((await searchParams).appleLink) : undefined;
  return <AccountEntry entry={destination} destination={destination} appleLinkResult={result} />;
}
