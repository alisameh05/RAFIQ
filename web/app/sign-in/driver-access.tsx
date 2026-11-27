'use client';

import { useAuth, useSignIn } from '@clerk/nextjs';
import Link from 'next/link';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { clerkAction, useEntryRequest } from '../account-entry/request';
import { accountPath, signInPath, type EntryContext } from '../account-entry/return';
import { VerifyEmail } from '../account-entry/verify-email';
import { RecoverAccess } from './recover-access';

export type ClerkSignIn = ReturnType<typeof useSignIn>['signIn'];

type Props = { entry: EntryContext; recover: boolean; registrationOpen: boolean };

export function DriverAccess({ entry, recover, registrationOpen }: Props) {
  const { isLoaded, isSignedIn } = useAuth();
  const { signIn } = useSignIn();
  if (!isLoaded || !signIn) return <p role="status">Loading secure account access…</p>;
  if (isSignedIn) return <Link href={accountPath(entry)}>Check account status</Link>;
  return recover ? <RecoverAccess signIn={signIn} entry={entry} />
    : <PasswordSignIn signIn={signIn} entry={entry} registrationOpen={registrationOpen} />;
}

function PasswordSignIn({ signIn, entry, registrationOpen }: Omit<Props, 'recover'> & { signIn: ClerkSignIn }) {
  const { pending, throttled, run } = useEntryRequest();
  const [email, setEmail] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const address = useRef<HTMLInputElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const focusAddress = useRef(false);
  const busy = Boolean(pending);

  useEffect(() => {
    if (!challenge && focusAddress.current) {
      focusAddress.current = false;
      address.current?.focus();
    }
  }, [challenge]);

  async function finish(verified = false) {
    let navigating = false;
    await clerkAction(signIn.finalize({
      navigate: ({ session, decorateUrl }) => {
        if (!session || session.currentTask) return;
        navigating = true;
        window.location.assign(decorateUrl(accountPath(entry, verified)));
      },
    }));
    return navigating;
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || throttled || !password.current) return;
    const secret = password.current.value;
    password.current.value = '';
    setFeedback('');
    void run('Signing in…', async () => {
      await clerkAction(signIn.reset());
      await clerkAction(signIn.password({ emailAddress: email.trim(), password: secret }));
      if (signIn.status === 'needs_second_factor' || signIn.status === 'needs_client_trust') {
        const factor = signIn.supportedSecondFactors.find((value) => value.strategy === 'email_code');
        if (factor) {
          setChallenge(factor.safeIdentifier || email.trim());
          return;
        }
      }
      if (signIn.status === 'complete' && await finish()) return;
      setFeedback('We couldn’t complete sign-in. Try again or recover access.');
    }, (failure) => {
      setFeedback(failure === 'rate_limited' ? 'Too many attempts. Wait before trying again.'
        : 'Check your email and password, then try again.');
      password.current?.focus();
    });
  }

  if (challenge) return <>
    <VerifyEmail address={challenge}
      send={() => clerkAction(signIn.mfa.sendEmailCode())}
      verify={async (code) => {
        await clerkAction(signIn.mfa.verifyEmailCode({ code }));
        return signIn.status === 'complete' && await finish(true);
      }}
      changeEmail={async () => {
        await clerkAction(signIn.reset());
        focusAddress.current = true;
        setChallenge(null);
      }} />
    <p><Link href={signInPath(entry, true)}>Recover access</Link></p>
  </>;

  return <>
    <h1>Sign in</h1>
    <p>Use the email address and password for your RAFIQ account.</p>
    <p className="entry-status" role="status">{pending}</p>
    <form method="post" onSubmit={submit}>
      <label htmlFor="sign-in-address">Email address</label>
      <input id="sign-in-address" type="email" autoComplete="username" ref={address} required readOnly={busy}
        value={email} onChange={(event) => setEmail(event.target.value)} />
      <label htmlFor="sign-in-password">Password</label>
      <input id="sign-in-password" type="password" autoComplete="current-password" ref={password}
        readOnly={busy} required aria-describedby={feedback ? 'sign-in-error' : undefined} />
      {feedback && <p id="sign-in-error" className="entry-error" role="alert">{feedback}</p>}
      <div className="entry-actions">
        <button className="entry-action" disabled={busy || throttled}>Sign in</button>
        <Link className="entry-action entry-secondary" href={signInPath(entry, true)}>Recover access</Link>
      </div>
    </form>
    {registrationOpen && <p>New to RAFIQ? <Link href="/sign-up">Create account</Link></p>}
  </>;
}
