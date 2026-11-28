'use client';

import { useClerk } from '@clerk/nextjs';
import { useEffect, useRef, useState } from 'react';
import { googleAttemptKey, googleCallbackPath, googleFeedback, type GoogleResult } from './google-return';
import { accountPath, type EntryContext } from './return';

export function GoogleAction({ origin, entry, result, busy, onPending }: {
  origin?: string;
  entry?: EntryContext;
  result?: GoogleResult;
  busy: boolean;
  onPending: (pending: boolean) => void;
}) {
  const clerk = useClerk();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const returned = useRef<HTMLParagraphElement>(null);
  const starting = useRef(false);
  const [showReturn, setShowReturn] = useState(true);
  const feedback = error ? googleFeedback.failed : showReturn && result ? googleFeedback[result] : undefined;

  useEffect(() => {
    if (result) returned.current?.focus();
  }, [result]);

  useEffect(() => {
    function restore(event: PageTransitionEvent) {
      if (!event.persisted) return;
      starting.current = false;
      setPending(false);
      onPending(false);
    }
    window.addEventListener('pageshow', restore);
    return () => window.removeEventListener('pageshow', restore);
  }, [onPending]);

  async function start() {
    if (!origin || busy || starting.current) return;
    starting.current = true;
    setPending(true);
    onPending(true);
    setShowReturn(false);
    setError(false);
    try {
      if (window.location.origin !== origin || !clerk.client) throw new Error('Google sign-in unavailable');
      const attempt = crypto.randomUUID();
      const query = new URLSearchParams({ attempt });
      if (entry) query.set('entry', entry);
      const signIn = await clerk.client.signIn.create({
        strategy: 'oauth_google',
        redirectUrl: clerk.buildUrlWithAuth(origin + googleCallbackPath + '?' + query),
        actionCompleteRedirectUrl: origin + accountPath(entry),
      });
      const verification = signIn.firstFactorVerification;
      if (!signIn.id || verification.status !== 'unverified' || !verification.externalVerificationRedirectURL) {
        throw new Error('Google sign-in did not start');
      }
      sessionStorage.setItem(googleAttemptKey, JSON.stringify({
        query: query.toString(), signInId: signIn.id, startedAt: Date.now(),
      }));
      window.location.assign(verification.externalVerificationRedirectURL);
    } catch {
      try {
        sessionStorage.removeItem(googleAttemptKey);
      } catch {
        // The browser may have blocked access to storage before the attempt started.
      }
      setError(true);
      starting.current = false;
      setPending(false);
      onPending(false);
    }
  }

  return <>
    {feedback && <p ref={returned} id="google-feedback" className="entry-notice" role="alert" tabIndex={-1}>{feedback}</p>}
    {origin && <div className="entry-actions">
      <button className="entry-action entry-secondary" type="button" aria-disabled={busy || pending}
        aria-describedby={feedback ? 'google-feedback' : undefined} onClick={() => void start()}>
        Continue with Google
      </button>
    </div>}
    {origin && <p className="entry-status" role="status">{pending && 'Opening Google sign-in…'}</p>}
  </>;
}
