'use client';

import { useAuth, useClerk, useUser } from '@clerk/nextjs';
import Link from 'next/link';
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { accountPath, privateDestination, privatePath, signInPath, type EntryContext, type PrivateDestination } from '../account-entry/return';
import { RestrictedAccountMessage } from '../account-entry/restricted-account';
import { VerifyEmail } from '../account-entry/verify-email';
import { listenForPrivateAccess, notifyPrivateAccess } from './private-access';

const sections = [
  ['stationary', 'Stationary setup'],
  ['supervised', 'Approved supervised use'],
  ['camera', 'Camera setup'],
  ['recording', 'Recording choice'],
] as const;

type Conditions = { version: string } & Record<(typeof sections)[number][0], string>;
type View = 'checking' | 'onboarding' | 'dashboard' | 'readiness' | 'restricted' | 'verification' | 'signIn' | 'unavailable' | 'unavailableLink';
type GateProps = { apiOrigin: string | null; entry: EntryContext; destination?: PrivateDestination; linkId?: string };
const returnKey = 'rafiq-readiness-return-driver';
const destinationRecheckInterval = 10_000;

const titles: Record<View, string> = {
  checking: 'Checking account status',
  onboarding: 'Controlled-use onboarding',
  dashboard: 'Dashboard',
  readiness: 'Stationary readiness',
  restricted: 'Account restricted',
  verification: 'Verify your email',
  signIn: 'Sign in to continue',
  unavailable: 'Account status unavailable',
  unavailableLink: 'Unavailable link',
};

class GateProblem extends Error {
  constructor(readonly code: string, readonly supportContact?: string) {
    super(code);
  }
}

export function AccountGate(props: GateProps) {
  const { isLoaded, userId, sessionId, getToken } = useAuth();
  const previousAuthority = useRef<{ userId: string; sessionId: string } | null>(null);
  useLayoutEffect(() => {
    if (!isLoaded) return;
    const previous = previousAuthority.current;
    if (previous && (previous.userId !== userId || previous.sessionId !== sessionId)) {
      notifyPrivateAccess({ type: 'identityChanged', sessionId: previous.sessionId });
    }
    previousAuthority.current = userId && sessionId ? { userId, sessionId } : null;
  }, [isLoaded, sessionId, userId]);

  if (!isLoaded) return <p role="status">Checking account status…</p>;
  if (!userId || !sessionId) return <><h1>Sign in to continue</h1><Link href={signInPath(props.entry)}>Sign in</Link></>;
  return <SignedInGate key={JSON.stringify([sessionId, userId, props.entry, props.destination, props.linkId])}
    {...props} userId={userId} sessionId={sessionId} getToken={getToken} />;
}

function SignedInGate({ apiOrigin, entry, destination, linkId, userId, sessionId, getToken }: GateProps & {
  userId: string;
  sessionId: string;
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
  const panel = useRef<HTMLDivElement>(null);
  const linkExpiryTimer = useRef<number | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  const submit = useRef<HTMLButtonElement>(null);
  const requestScope = useRef<AbortController>(null);
  const inFlight = useRef(false);
  const scopedEntry = useRef<EntryContext>('account');
  const conditionsChanged = useRef(false);
  const displayedVersion = useRef<string | null>(null);
  const currentAccount = useRef<string | null>(null);
  const signingOut = useRef(false);
  const suspendedPage = useRef(false);

  // Abort before a changed identity or URL can paint its replacement gate.
  useLayoutEffect(() => () => {
    requestScope.current?.abort();
    window.clearTimeout(linkExpiryTimer.current);
  }, []);

  useLayoutEffect(() => {
    if (panel.current && !suspendedPage.current) panel.current.hidden = false;
  }, [view, attempt]);

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
          if (typeof account.accountId !== 'string' || !account.accountId) throw new Error();
          currentAccount.current = account.accountId;
          await openDestination(target, account.accountId, signal);
        } else if (account.status === 'onboardingRequired') {
          await loadConditions(signal);
        } else {
          throw new Error();
        }
      } catch (error) {
        if (!signal.aborted && !showAccessProblem(error)) clearPrivateView('unavailable');
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
    deadline.throwIfAborted();
    if (!token) throw new GateProblem('authentication_required');
    const response = await fetch(apiOrigin + '/api/v1' + path, {
      method, signal: deadline, cache: 'no-store', redirect: 'error',
      headers: {
        Authorization: 'Bearer ' + token,
        ...(body && { 'Content-Type': 'application/json' }),
      },
      body: body && JSON.stringify(body),
    });
    deadline.throwIfAborted();
    if (response.status === 401) throw new GateProblem('authentication_required');
    const result = await response.json();
    deadline.throwIfAborted();
    if (!response.ok) throw new GateProblem(result.code, result.supportContact);
    return result;
  }

  function clearPrivateView(next: View, contact?: string) {
    requestScope.current?.abort();
    window.clearTimeout(linkExpiryTimer.current);
    if (panel.current && view !== next) panel.current.hidden = true;
    currentAccount.current = null;
    inFlight.current = false;
    setVerified(false);
    setConditions(null);
    setSelectedVersion(null);
    setSaving(false);
    setMessage('');
    setSupportContact(contact);
    setView(next);
  }

  function showAccessProblem(error: unknown): boolean {
    if (!(error instanceof GateProblem)) return false;
    switch (error.code) {
      case 'authentication_required':
        clearPrivateView('signIn');
        notifyPrivateAccess({ type: 'authorityExpired', sessionId });
        return true;
      case 'verification_required':
        clearPrivateView('verification');
        notifyPrivateAccess({ type: 'authorityExpired', sessionId });
        return true;
      case 'account_restricted':
        sessionStorage.removeItem(returnKey);
        clearPrivateView('restricted', error.supportContact);
        notifyPrivateAccess({ type: 'restricted', userId, sessionId, supportContact: error.supportContact });
        return true;
      case 'resource_unavailable':
        clearPrivateView('unavailableLink');
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
    const method = linkId === undefined && target === 'readiness' ? 'POST' : 'GET';
    const path = linkId !== undefined ? '/account/links/' + encodeURIComponent(linkId)
      : method === 'POST' ? '/account/readiness' : '/account/workspace';
    try {
      const requestStarted = performance.now();
      const context = await request(path, signal, method);
      if (context.destination !== target || !accountId || !context.accountId || !context.acceptedVersion) throw new Error();
      if (context.accountId !== accountId) throw new GateProblem('authentication_required');
      if (linkId !== undefined) {
        if (!Number.isSafeInteger(context.expiresInMs)) throw new Error();
        const remaining = context.expiresInMs - (performance.now() - requestStarted);
        if (remaining <= 0) throw new GateProblem('resource_unavailable');
        window.clearTimeout(linkExpiryTimer.current);
        if (remaining <= 2_147_483_647) {
          linkExpiryTimer.current = window.setTimeout(() => {
            if (!signal.aborted) clearPrivateView('unavailableLink');
          }, Math.floor(remaining));
        }
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
        if (destination) clearPrivateView('checking');
        setConditions(null);
        setSelectedVersion(null);
        await loadConditions(signal);
      } else {
        throw error;
      }
    }
  }

  function retry() {
    clearPrivateView('checking');
    setAttempt((value) => value + 1);
  }

  const onPrivateAccessChange = useEffectEvent((change: Parameters<typeof notifyPrivateAccess>[0]) => {
    if (signingOut.current) return;
    if (change.type === 'restricted') {
      if (change.userId !== userId || view === 'signIn') return;
      sessionStorage.removeItem(returnKey);
      if (change.sessionId === sessionId) clearPrivateView('restricted', change.supportContact);
      else retry();
    } else if (change.sessionId === sessionId) {
      if (change.type === 'signedOut') sessionStorage.removeItem(returnKey);
      if (view !== 'restricted' && view !== 'verification' || change.type !== 'authorityExpired') {
        clearPrivateView('signIn');
      }
    }
  });

  const resumePage = useEffectEvent(() => {
    if (document.hidden || !suspendedPage.current || signingOut.current) return;
    suspendedPage.current = false;
    if (view === 'restricted' || view === 'signIn') {
      if (panel.current) panel.current.hidden = false;
      return;
    }
    retry();
  });

  useEffect(() => {
    const unsubscribe = listenForPrivateAccess((change) => onPrivateAccessChange(change));
    const conceal = () => {
      suspendedPage.current = true;
      if (panel.current) panel.current.hidden = true;
      requestScope.current?.abort();
      window.clearTimeout(linkExpiryTimer.current);
    };
    const onVisibility = () => {
      if (document.hidden) conceal();
      else resumePage();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) resumePage();
    };
    window.addEventListener('pagehide', conceal);
    window.addEventListener('pageshow', onPageShow);
    document.addEventListener('visibilitychange', onVisibility);
    if (document.hidden) conceal();
    return () => {
      unsubscribe();
      window.removeEventListener('pagehide', conceal);
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const recheckDestination = useEffectEvent(async () => {
    const signal = requestScope.current?.signal;
    const accountId = currentAccount.current;
    if ((view !== 'dashboard' && view !== 'readiness') || !signal || signal.aborted || !accountId) return;
    try {
      await openDestination(view, accountId, signal);
    } catch (error) {
      if (!signal.aborted && !showAccessProblem(error)) clearPrivateView('unavailable');
    }
  });

  useEffect(() => {
    if (view !== 'dashboard' && view !== 'readiness') return;
    // Bound the lifetime of a visible view while Clerk and resource state can change remotely.
    const timer = window.setInterval(() => void recheckDestination(), destinationRecheckInterval);
    return () => window.clearInterval(timer);
  }, [view]);

  async function accept() {
    const signal = requestScope.current?.signal;
    if (!conditions || !accepted || !signal || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setMessage('');
    try {
      const account = await request('/account/controlled-use', signal, 'PUT', { version: conditions.version, accepted: true });
      currentAccount.current = account.accountId;
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
      if (!signal.aborted) {
        inFlight.current = false;
        setSaving(false);
      }
    }
  }

  async function exit(redirectUrl: string, preserveReturn = false) {
    if (signingOut.current) return;
    signingOut.current = true;
    if (!preserveReturn) sessionStorage.removeItem(returnKey);
    clearPrivateView('signIn');
    notifyPrivateAccess({ type: 'signedOut', sessionId });
    await signOut({ redirectUrl }).catch(() => window.location.replace('/'));
  }

  const primaryEmail = user?.primaryEmailAddress;
  if (view === 'verification' && primaryEmail) {
    return <div ref={panel}><VerifyEmail key={primaryEmail.id} address={primaryEmail.emailAddress}
      send={async () => { await primaryEmail.prepareVerification({ strategy: 'email_code' }); }}
      verify={async (code) => {
        const email = await primaryEmail.attemptVerification({ code });
        if (email.verification.status !== 'verified') return false;
        setVerified(true);
        retry();
        return true;
      }}
      changeEmail={() => exit(signInPath('account'))} /></div>;
  }

  return (
    <div ref={panel}>
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
        <p><Link href={privatePath('readiness')} prefetch={false}>Start session</Link></p>
      </>}
      {view === 'readiness' && <>
        <p>Your account and controlled-use acceptance are current. Set up the front-facing camera and make your recording choice while stationary when readiness is available.</p>
        <p><Link href={privatePath('dashboard')} prefetch={false}>Return to Dashboard</Link></p>
      </>}
      {view === 'restricted' && <RestrictedAccountMessage supportContact={supportContact} />}
      {view === 'unavailableLink' && <>
        <p>This item is unavailable.</p>
        <p><Link href={privatePath('dashboard')} prefetch={false}>Return to Dashboard</Link></p>
      </>}
      {view === 'verification' && <p>Confirm your email with Clerk before continuing.</p>}
      {view === 'unavailable' && <button className="entry-action" onClick={retry}>Retry account check</button>}
      <div className="entry-actions">
        <button className="entry-action entry-secondary" onClick={() => void exit(
          view === 'signIn' ? signInPath(scopedEntry.current)
            : view === 'verification' || view === 'restricted' ? signInPath('account') : '/',
          view === 'signIn',
        )}>
          {view === 'restricted' ? 'Sign in' : view === 'signIn' || view === 'verification' ? 'Return to sign in' : 'Sign out'}
        </button>
      </div>
    </div>
  );
}
