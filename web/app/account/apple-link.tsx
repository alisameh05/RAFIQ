'use client';

import { useClerk, useReverification, useUser } from '@clerk/nextjs';
import { isReverificationCancelledError } from '@clerk/nextjs/errors';
import { useEffect, useRef, useState } from 'react';
import { appleLinkAttemptKey, appleLinkCallback, type AppleLinkResult } from '../account-entry/apple-link-return';

const feedback = {
  connected: 'Apple is connected to your RAFIQ account.',
  cancelled: 'Apple connection was canceled. You can try again.',
  failed: 'Apple couldn’t be connected. Try again from Profile.',
  unavailable: 'Connecting Apple is unavailable here.',
};

export function AppleLink({ origin, result, recheck, busy }: {
  origin?: string;
  result?: AppleLinkResult;
  recheck: () => Promise<void>;
  busy: boolean;
}) {
  const clerk = useClerk();
  const { user } = useUser();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState(result);
  const starting = useRef(false);
  const message = useRef<HTMLParagraphElement>(null);
  const existing = user?.externalAccounts?.find((account) => account.provider === 'apple');
  const connected = existing?.verification?.status === 'verified';
  const showNotice = notice && (notice !== 'connected' || (origin && connected));
  const connect = useReverification((redirectUrl: string, userId: string, sessionId: string) => {
    if (clerk.user?.id !== userId || clerk.session?.id !== sessionId || user?.id !== userId) {
      throw new Error('The signed-in driver changed');
    }
    const account = user.externalAccounts.find((item) => item.provider === 'apple');
    return account ? account.reauthorize({ redirectUrl }) : user.createExternalAccount({ strategy: 'oauth_apple', redirectUrl });
  });

  useEffect(() => {
    if (showNotice) message.current?.focus();
  }, [notice, showNotice]);

  useEffect(() => {
    function restore(event: PageTransitionEvent) {
      if (!event.persisted) return;
      starting.current = false;
      setPending(false);
    }
    window.addEventListener('pageshow', restore);
    return () => window.removeEventListener('pageshow', restore);
  }, []);

  async function start() {
    if (!origin || !user || connected || busy || starting.current || !clerk.session) return;
    starting.current = true;
    setPending(true);
    setNotice(undefined);
    const userId = user.id;
    const sessionId = clerk.session.id;
    try {
      if (window.location.origin !== origin) throw new Error('Apple connection unavailable');
      sessionStorage.removeItem(appleLinkAttemptKey);
      await recheck();
      const attempt = crypto.randomUUID();
      const redirectUrl = origin + appleLinkCallback + '?' + new URLSearchParams({ attempt });
      const account = await connect(clerk.buildUrlWithAuth(redirectUrl), userId, sessionId);
      const verification = account?.verification;
      if (clerk.user?.id !== userId || clerk.session?.id !== sessionId || !account?.id
          || !verification?.externalVerificationRedirectURL) throw new Error('Apple connection did not start');
      sessionStorage.setItem(appleLinkAttemptKey, JSON.stringify({
        attempt, userId, sessionId, accountId: account.id, startedAt: Date.now(),
      }));
      window.location.assign(verification.externalVerificationRedirectURL);
    } catch (error) {
      setNotice(isReverificationCancelledError(error) ? 'cancelled' : 'failed');
      starting.current = false;
      setPending(false);
    }
  }

  if (!origin && !showNotice) return null;
  return <section className="profile-row" aria-labelledby="apple-connection">
    <h2 id="apple-connection">Sign in with Apple</h2>
    {showNotice && <p className="entry-notice" ref={message} id="apple-link-feedback"
      role={notice === 'connected' ? 'status' : 'alert'} tabIndex={-1}>{feedback[notice]}</p>}
    {origin && connected && !showNotice && <p>{feedback.connected}</p>}
    {origin && !connected && <div className="profile-actions">
      <button className="entry-action entry-secondary" type="button" aria-disabled={pending || busy || !user}
        aria-describedby={showNotice ? 'apple-link-feedback' : undefined} onClick={() => void start()}>
        Connect Apple
      </button>
      <p className="profile-status" role="status">{pending && 'Opening Apple connection…'}</p>
    </div>}
  </section>;
}
