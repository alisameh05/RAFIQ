'use client';

import { SignOutButton, useAuth, useClerk, useUser } from '@clerk/nextjs';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { signInPath, type EntryContext } from '../account-entry/return';
import { VerifyEmail } from '../account-entry/verify-email';

type Gate = 'checking' | 'onboardingRequired' | 'active' | 'restricted' | 'verificationRequired' | 'signIn' | 'unavailable';

const titles: Record<Gate, string> = {
  checking: 'Checking account status',
  onboardingRequired: 'Controlled-use onboarding',
  active: 'Account ready',
  restricted: 'Account restricted',
  verificationRequired: 'Verify your email',
  signIn: 'Sign in to continue',
  unavailable: 'Account status unavailable',
};

export function AccountGate({ apiOrigin, entry }: { apiOrigin: string | null; entry: EntryContext }) {
  const { isLoaded, userId, sessionId, getToken } = useAuth();
  if (!isLoaded) return <h1>Checking account status</h1>;
  if (!userId || !sessionId) return <><h1>Sign in to continue</h1><Link href={signInPath(entry)}>Sign in</Link></>;
  return <SignedInGate key={sessionId} apiOrigin={apiOrigin} getToken={getToken} entry={entry} />;
}

function SignedInGate({ apiOrigin, entry, getToken }: { apiOrigin: string | null; entry: EntryContext; getToken: () => Promise<string | null> }) {
  const { user } = useUser();
  const { signOut } = useClerk();
  const [verifiedInPlace, setVerifiedInPlace] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [gate, setGate] = useState<Gate>('checking');
  const [verified, setVerified] = useState(false);
  const resultHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (verified) resultHeading.current?.focus();
  }, [verified]);
  const [supportContact, setSupportContact] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function resolve() {
      try {
        if (!apiOrigin) throw new Error();
        const token = await getToken();
        if (controller.signal.aborted) return;
        if (!token) {
          setGate('signIn');
          return;
        }
        const response = await fetch(apiOrigin + '/api/v1/account', {
          headers: { Authorization: 'Bearer ' + token },
          cache: 'no-store', signal: controller.signal, redirect: 'error',
        });
        if (controller.signal.aborted) return;
        if (response.status === 401) {
          setGate('signIn');
          return;
        }
        const result = await response.json();
        if (controller.signal.aborted) return;
        if (response.status === 403 && result.code === 'verification_required') {
          setGate('verificationRequired');
          return;
        }
        if (response.status === 403 && result.code === 'account_restricted') {
          setSupportContact(typeof result.supportContact === 'string' ? result.supportContact : null);
          setGate('restricted');
          return;
        }
        if (!response.ok || result.verified !== true
            || (result.status !== 'onboardingRequired' && result.status !== 'active')) throw new Error();
        const url = new URL(window.location.href);
        if (url.searchParams.get('verified') === '1') {
          url.searchParams.delete('verified');
          window.history.replaceState(window.history.state, '', url);
          setVerified(true);
        }
        if (verifiedInPlace) setVerified(true);
        setGate(result.status);
      } catch {
        if (!controller.signal.aborted) setGate('unavailable');
      }
    }

    void resolve();
    return () => controller.abort();
  }, [apiOrigin, attempt, getToken, verifiedInPlace]);

  const primaryEmail = user?.primaryEmailAddress;
  if (gate === 'verificationRequired' && primaryEmail) {
    return <VerifyEmail key={primaryEmail.id} address={primaryEmail.emailAddress}
      send={async () => { await primaryEmail.prepareVerification({ strategy: 'email_code' }); }}
      verify={async (code) => {
        const email = await primaryEmail.attemptVerification({ code });
        if (email.verification.status !== 'verified') return false;
        setGate('checking');
        setVerifiedInPlace(true);
        setAttempt((value) => value + 1);
        return true;
      }}
      changeEmail={() => signOut({ redirectUrl: signInPath(entry) })} />;
  }

  return (
    <>
      <p className="entry-status" role="status">{verified ? 'Email verified' : gate === 'checking' ? 'Checking account status…' : ''}</p>
      <h1 ref={resultHeading} tabIndex={-1}>{titles[gate]}</h1>
      {gate === 'onboardingRequired' && <p>Review and accept RAFIQ’s controlled-use conditions before using the workspace. This step will be available when onboarding opens.</p>}
      {gate === 'active' && <p>Your account is verified. The private workspace is pending release.</p>}
      {gate === 'restricted' && <p>{supportContact ? "Contact RAFIQ support at " + supportContact + "." : 'Private access is currently unavailable for this account.'}</p>}
      {gate === 'verificationRequired' && <p>Confirm your email with Clerk before continuing.</p>}
      {gate === 'unavailable' && (
        <button className="entry-action" onClick={() => {
          setGate('checking');
          setAttempt((value) => value + 1);
        }}>Retry account check</button>
      )}
      <div className="entry-actions">
        <SignOutButton redirectUrl={gate === 'signIn' || gate === 'verificationRequired' ? signInPath(entry) : '/'}>
          <button className="entry-action entry-secondary">
            {gate === 'signIn' || gate === 'verificationRequired' ? 'Return to sign in' : 'Sign out'}
          </button>
        </SignOutButton>
      </div>
    </>
  );
}
