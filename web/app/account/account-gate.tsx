'use client';

import { useAuth, useClerk, useUser } from '@clerk/nextjs';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { accountPath, privateDestination, privatePath, signInPath, type EntryContext, type PrivateDestination } from '../account-entry/return';
import { VerifyEmail } from '../account-entry/verify-email';

const sections = [
  ['stationary', 'Stationary setup'],
  ['supervised', 'Approved supervised use'],
  ['camera', 'Camera setup'],
  ['recording', 'Recording choice'],
] as const;

type Conditions = { version: string } & Record<(typeof sections)[number][0], string>;
type View = 'checking' | 'onboarding' | 'dashboard' | 'readiness' | 'restricted' | 'verification' | 'signIn' | 'unavailable';
type GateProps = { apiOrigin: string | null; entry: EntryContext; destination?: PrivateDestination };
const returnKey = 'rafiq-readiness-return-driver';

const titles: Record<View, string> = {
  checking: 'Checking account status',
  onboarding: 'Controlled-use onboarding',
  dashboard: 'Dashboard',
  readiness: 'Stationary readiness',
  restricted: 'Account restricted',
  verification: 'Verify your email',
  signIn: 'Sign in to continue',
  unavailable: 'Account status unavailable',
};

class GateProblem extends Error {
  constructor(readonly code: string, readonly supportContact?: string) {
    super(code);
  }
}

export function AccountGate(props: GateProps) {
  const { isLoaded, userId, sessionId, getToken } = useAuth();
  if (!isLoaded) return <p role="status">Checking account status…</p>;
  if (!userId || !sessionId) return <><h1>Sign in to continue</h1><Link href={signInPath(props.entry)}>Sign in</Link></>;
  return <SignedInGate key={sessionId + ':' + userId} {...props} userId={userId} getToken={getToken} />;
}

function SignedInGate({ apiOrigin, entry, destination, userId, getToken }: GateProps & {
  userId: string;
  getToken: () => Promise<string | null>;
}) {
  const { user } = useUser();
  const { signOut } = useClerk();
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<View>('checking');
  const [verified, setVerified] = useState(false);
  const [conditions, setConditions] = useState<Conditions | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const accepted = conditions !== null && selectedVersion === conditions.version;
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [supportContact, setSupportContact] = useState<string | undefined>();
  const heading = useRef<HTMLHeadingElement>(null);
  const submit = useRef<HTMLButtonElement>(null);
  const requestScope = useRef<AbortController>(null);
  const inFlight = useRef(false);
  const scopedEntry = useRef<EntryContext>('account');
  const conditionsChanged = useRef(false);
  const displayedVersion = useRef<string | null>(null);

  useEffect(() => {
    if (view !== 'checking') heading.current?.focus();
  }, [view, conditions?.version]);

  useEffect(() => {
    const controller = new AbortController();
    requestScope.current = controller;
    const signal = controller.signal;
    let target = privateDestination(entry) ?? 'dashboard';
    if (entry === 'readiness') {
      const boundDriver = sessionStorage.getItem(returnKey);
      if (boundDriver && boundDriver !== userId) {
        target = 'dashboard';
        window.history.replaceState(window.history.state, '', accountPath('account'));
        if (destination) {
          window.location.replace(accountPath('account'));
          return () => controller.abort();
        }
      } else {
        sessionStorage.setItem(returnKey, userId);
      }
    }
    scopedEntry.current = target === 'readiness' ? 'readiness' : 'account';

    async function resolve() {
      try {
        const account = await request('/account', signal);
        if (account.verified !== true) throw new Error();
        if (new URL(window.location.href).searchParams.get('verified') === '1') {
          window.history.replaceState(window.history.state, '', accountPath(scopedEntry.current));
          setVerified(true);
        }
        if (account.status === 'active') {
          await openDestination(target, account.accountId, signal);
        } else if (account.status === 'onboardingRequired') {
          await loadConditions(signal);
        } else {
          throw new Error();
        }
      } catch (error) {
        if (!signal.aborted && !showAccessProblem(error)) setView('unavailable');
      }
    }

    void resolve();
    return () => controller.abort();
    // Requests are scoped to this Clerk session, destination and explicit retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiOrigin, attempt, destination, entry, getToken, userId]);

  async function request(path: string, signal: AbortSignal, method = 'GET', body?: object) {
    if (!apiOrigin) throw new Error();
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    deadline.throwIfAborted();
    const token = await Promise.race([
      getToken(),
      new Promise<never>((_, reject) => {
        deadline.addEventListener('abort', () => reject(deadline.reason), { once: true });
      }),
    ]);
    if (!token) throw new GateProblem('authentication_required');
    const response = await fetch(apiOrigin + '/api/v1' + path, {
      method, signal: deadline, cache: 'no-store', redirect: 'error',
      headers: {
        Authorization: 'Bearer ' + token,
        ...(body && { 'Content-Type': 'application/json' }),
      },
      body: body && JSON.stringify(body),
    });
    if (response.status === 401) throw new GateProblem('authentication_required');
    const result = await response.json();
    deadline.throwIfAborted();
    if (!response.ok) throw new GateProblem(result.code, result.supportContact);
    return result;
  }

  function showAccessProblem(error: unknown): boolean {
    if (!(error instanceof GateProblem)) return false;
    switch (error.code) {
      case 'authentication_required':
        setView('signIn');
        return true;
      case 'verification_required':
        setView('verification');
        return true;
      case 'account_restricted':
        setSupportContact(error.supportContact);
        setView('restricted');
        return true;
      default:
        return false;
    }
  }

  async function loadConditions(signal: AbortSignal) {
    if (destination) {
      window.location.replace(accountPath(scopedEntry.current));
      return;
    }
    setView('onboarding');
    try {
      const result = await request('/account/controlled-use', signal);
      if (typeof result.version !== 'string' || !sections.every(([key]) => typeof result[key] === 'string')) throw new Error();
      if (displayedVersion.current && displayedVersion.current !== result.version) {
        setSelectedVersion(null);
        conditionsChanged.current = true;
      }
      displayedVersion.current = result.version;
      setConditions(result);
      setMessage(conditionsChanged.current ? 'The conditions changed. Review this version and accept it to continue.' : '');
    } catch (error) {
      if (signal.aborted) return;
      if (!showAccessProblem(error)) {
        setMessage('The current conditions could not be loaded. Try again or sign out.');
      }
    }
  }

  async function openDestination(target: PrivateDestination, accountId: string, signal: AbortSignal) {
    const path = target === 'readiness' ? '/account/readiness' : '/account/workspace';
    try {
      const context = await request(path, signal, target === 'readiness' ? 'POST' : 'GET');
      if (context.destination !== target || !accountId || !context.accountId || !context.acceptedVersion) throw new Error();
      if (context.accountId !== accountId) {
        window.location.replace(accountPath('account'));
        return;
      }
      if (destination !== target) {
        window.location.replace(privatePath(target));
        return;
      }
      if (target === 'dashboard') sessionStorage.removeItem(returnKey);
      setView(target);
    } catch (error) {
      if (error instanceof GateProblem && error.code === 'controlled_use_required') {
        conditionsChanged.current = true;
        setConditions(null);
        setSelectedVersion(null);
        await loadConditions(signal);
      } else if (target === 'readiness' && error instanceof GateProblem && error.code === 'resource_unavailable') {
        scopedEntry.current = 'account';
        await openDestination('dashboard', accountId, signal);
      } else {
        throw error;
      }
    }
  }

  function retry() {
    setView('checking');
    setMessage('');
    setAttempt((value) => value + 1);
  }

  async function accept() {
    const signal = requestScope.current?.signal;
    if (!conditions || !accepted || !signal || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setMessage('');
    try {
      const account = await request('/account/controlled-use', signal, 'PUT', { version: conditions.version, accepted: true });
      await openDestination(privateDestination(scopedEntry.current) ?? 'dashboard', account.accountId, signal);
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof GateProblem && error.code === 'controlled_use_changed') {
        conditionsChanged.current = true;
        setSelectedVersion(null);
        setConditions(null);
        heading.current?.focus();
        await loadConditions(signal);
      } else if (!showAccessProblem(error)) {
        setMessage('We could not confirm acceptance. Try again. It is safe to retry this version.');
        submit.current?.focus();
      }
    } finally {
      inFlight.current = false;
      if (!signal.aborted) setSaving(false);
    }
  }

  async function exit(redirectUrl: string, preserveReturn = false) {
    if (!preserveReturn) sessionStorage.removeItem(returnKey);
    await signOut({ redirectUrl }).catch(() => window.location.replace('/'));
  }

  const primaryEmail = user?.primaryEmailAddress;
  if (view === 'verification' && primaryEmail) {
    return <VerifyEmail key={primaryEmail.id} address={primaryEmail.emailAddress}
      send={async () => { await primaryEmail.prepareVerification({ strategy: 'email_code' }); }}
      verify={async (code) => {
        const email = await primaryEmail.attemptVerification({ code });
        if (email.verification.status !== 'verified') return false;
        setVerified(true);
        retry();
        return true;
      }}
      changeEmail={() => exit(signInPath('account'))} />;
  }

  return (
    <>
      <p className="entry-status" role="status">{saving ? 'Saving acceptance…' : view === 'checking' ? 'Checking account status…' : verified ? 'Email verified' : ''}</p>
      <h1 ref={heading} tabIndex={-1}>{titles[view]}</h1>
      {view === 'onboarding' && <>
        <p role="alert" className="entry-notice">{message}</p>
        {conditions ? (
          <form className="entry-conditions" onSubmit={(event) => { event.preventDefault(); void accept(); }}>
            <p>Conditions version {conditions.version}</p>
            {sections.map(([key, label]) => <section key={key}><h2>{label}</h2><p>{conditions[key]}</p></section>)}
            <label className="entry-consent">
              <input type="checkbox" checked={accepted} disabled={saving} onChange={(event) => setSelectedVersion(event.target.checked ? conditions.version : null)} />
              <span>I accept the current controlled-use conditions.</span>
            </label>
            <button ref={submit} className="entry-action" type="submit" aria-disabled={!accepted || saving}>Accept and continue</button>
          </form>
        ) : message && <button className="entry-action" onClick={retry}>Retry loading conditions</button>}
      </>}
      {view === 'dashboard' && <>
        <p>No sessions yet.</p>
        <p><Link href={privatePath('readiness')}>Start session</Link></p>
      </>}
      {view === 'readiness' && <>
        <p>Your account and controlled-use acceptance are current. Set up the front-facing camera and make your recording choice while stationary when readiness is available.</p>
        <p><Link href={privatePath('dashboard')}>Return to Dashboard</Link></p>
      </>}
      {view === 'restricted' && <p>{supportContact ? 'Contact RAFIQ support at ' + supportContact + '.' : 'Private access is currently unavailable for this account.'}</p>}
      {view === 'verification' && <p>Confirm your email with Clerk before continuing.</p>}
      {view === 'unavailable' && <button className="entry-action" onClick={retry}>Retry account check</button>}
      <div className="entry-actions">
        <button className="entry-action entry-secondary" onClick={() => void exit(
          view === 'signIn' ? signInPath(scopedEntry.current) : view === 'verification' ? signInPath('account') : '/',
          view === 'signIn',
        )}>
          {view === 'signIn' || view === 'verification' ? 'Return to sign in' : 'Sign out'}
        </button>
      </div>
    </>
  );
}
