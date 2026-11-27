'use client';

import { useAuth, useSignIn } from '@clerk/nextjs';
import { isClerkAPIResponseError } from '@clerk/nextjs/errors';
import Link from 'next/link';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { clerkAction, useEntryRequest } from '../account-entry/request';
import { RestrictedAccountMessage } from '../account-entry/restricted-account';
import { accountPath, signInPath, type EntryContext } from '../account-entry/return';
import { VerifyEmail } from '../account-entry/verify-email';
import { RecoverAccess } from './recover-access';

export type ClerkSignIn = ReturnType<typeof useSignIn>['signIn'];

type Props = { entry: EntryContext; recover: boolean; registrationOpen: boolean; supportContact?: string };

export function DriverAccess({ entry, recover, registrationOpen, supportContact }: Props) {
  const { isLoaded, isSignedIn } = useAuth();
  const { signIn } = useSignIn();
  if (!isLoaded || !signIn) return <p role="status">Loading secure account access…</p>;
  if (isSignedIn) return <Link href={accountPath(entry)}>Check account status</Link>;
  return recover ? <RecoverAccess signIn={signIn} entry={entry} />
    : <PasswordSignIn signIn={signIn} entry={entry} registrationOpen={registrationOpen} supportContact={supportContact} />;
}

function PasswordSignIn({ signIn, entry, registrationOpen, supportContact }: Omit<Props, 'recover'> & { signIn: ClerkSignIn }) {
  const { pending, throttled, run } = useEntryRequest();
  const [email, setEmail] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [restricted, setRestricted] = useState(false);
  const restrictionHeading = useRef<HTMLHeadingElement>(null);
  const address = useRef<HTMLInputElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const focusAddress = useRef(false);
  const busy = Boolean(pending);

  useEffect(() => {
    if (restricted) restrictionHeading.current?.focus();
    else if (!challenge && focusAddress.current) {
      focusAddress.current = false;
      address.current?.focus();
    }
  }, [challenge, restricted]);

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

  function showRestriction(code: string) {
    if (code !== 'user_banned' && code !== 'user_locked') return false;
    setEmail('');
    setChallenge(null);
    setRestricted(true);
    return true;
  }

  async function runChallenge<Result>(action: () => Promise<Result>, interrupted: Result) {
    try {
      return await action();
    } catch (error) {
      if (isClerkAPIResponseError(error) && showRestriction(error.errors[0]?.code ?? '')) {
        return interrupted;
      }
      throw error;
    }
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
      if (showRestriction(failure)) return;
      setFeedback(failure === 'rate_limited' ? 'Too many attempts. Wait before trying again.'
        : 'Check your email and password, then try again.');
      password.current?.focus();
    });
  }

  if (restricted) return <>
    <h1 ref={restrictionHeading} tabIndex={-1}>Account restricted</h1>
    <RestrictedAccountMessage supportContact={supportContact} />
    <button className="entry-action" onClick={() => {
      focusAddress.current = true;
      setRestricted(false);
    }}>Sign in</button>
  </>;

  if (challenge) return <>
    <VerifyEmail address={challenge}
      send={() => runChallenge(() => clerkAction(signIn.mfa.sendEmailCode()), undefined)}
      verify={(code) => runChallenge(async () => {
        await clerkAction(signIn.mfa.verifyEmailCode({ code }));
        return signIn.status === 'complete' && await finish(true);
      }, false)}
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
