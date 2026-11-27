import { connection } from 'next/server';
import FixtureHome from './fixture-home';
import { accountEntryEnabled, signupOpen } from './account-entry/config';
import { Landing } from './landing/landing';

export default async function Home({ searchParams }: { searchParams: Promise<{ signup?: string | string[] }> }) {
  await connection();
  if (!accountEntryEnabled()) return <FixtureHome />;

  const open = signupOpen() && (await searchParams).signup !== 'pending';
  return <Landing signupOpen={open} />;
}
