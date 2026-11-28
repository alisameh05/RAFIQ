'use client';

import { useClerk } from '@clerk/nextjs';
import { useEffect, useRef, useState } from 'react';
import { socialAttemptKey, socialCallbackPath, socialFeedback, socialNames, type SocialProvider, type SocialResult } from './social-return';
import { accountPath, type EntryContext } from './return';

export function SocialAction({ provider, origin, entry, result, busy, onPending }: {
  provider: SocialProvider;
  origin?: string;
  entry?: EntryContext;
  result?: SocialResult;
  busy: boolean;
  onPending: (pending: boolean) => void;
}) {
  const clerk = useClerk();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const returned = useRef<HTMLParagraphElement>(null);
  const starting = useRef(false);
  const [showReturn, setShowReturn] = useState(true);
  const name = socialNames[provider];
  const feedbackId = provider + '-feedback';
  const feedback = error ? socialFeedback(provider, 'failed') : showReturn && result ? socialFeedback(provider, result) : undefined;

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
      if (window.location.origin !== origin || !clerk.client) throw new Error('Social sign-in unavailable');
      const attempt = crypto.randomUUID();
      const query = new URLSearchParams({ attempt });
      if (entry) query.set('entry', entry);
      const signIn = await clerk.client.signIn.create({
        strategy: `oauth_${provider}`,
        redirectUrl: clerk.buildUrlWithAuth(origin + socialCallbackPath(provider) + '?' + query),
        actionCompleteRedirectUrl: origin + accountPath(entry),
      });
      const verification = signIn.firstFactorVerification;
      if (!signIn.id || verification.status !== 'unverified' || !verification.externalVerificationRedirectURL) {
        throw new Error('Social sign-in did not start');
      }
      sessionStorage.setItem(socialAttemptKey(provider), JSON.stringify({
        query: query.toString(), signInId: signIn.id, startedAt: Date.now(),
      }));
      window.location.assign(verification.externalVerificationRedirectURL);
    } catch {
      try {
        sessionStorage.removeItem(socialAttemptKey(provider));
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
    {feedback && <p ref={returned} id={feedbackId} className="entry-notice" role="alert" tabIndex={-1}>{feedback}</p>}
    {origin && <div className="entry-actions">
      <button className="entry-action entry-secondary" type="button" aria-disabled={busy || pending}
        aria-describedby={feedback ? feedbackId : undefined} onClick={() => void start()}>
        Continue with {name}
      </button>
    </div>}
    {origin && <p className="entry-status" role="status">{pending && `Opening ${name} sign-in…`}</p>}
  </>;
}
