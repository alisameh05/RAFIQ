import Link from 'next/link';
import { connection } from 'next/server';
import FixtureHome from './fixture-home';
import { accountEntryEnabled, signupOpen } from './account-entry/config';
import { EntryShell } from './account-entry/shell';

export default async function Home({ searchParams }: { searchParams: Promise<{ signup?: string | string[] }> }) {
  await connection();
  if (!accountEntryEnabled()) return <FixtureHome />;

  const open = signupOpen() && (await searchParams).signup !== 'pending';
  return (
    <EntryShell artwork>
      <h1>Driver monitoring for controlled sessions</h1>
      <p>RAFIQ uses your desktop camera to give local warnings and lets you review session evidence privately.</p>
      <p>For adults 18 and older. Set up and operate driver controls while stationary. Vehicle motion requires an approved supervised procedure.</p>
      {!open && <p className="entry-notice">Public signup is pending release.</p>}
      <div className="entry-actions">
        {open && <Link className="entry-action" href="/sign-up">Create account</Link>}
        <Link className="entry-action entry-secondary" href="/sign-in">Sign in</Link>
      </div>
    </EntryShell>
  );
}
