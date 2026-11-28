'use client';

import { useAuth, useClerk } from '@clerk/nextjs';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { appleLinkAttemptKey, appleLinkReturnPath, type AppleLinkResult } from '../../../account-entry/apple-link-return';
import { consumeSocialAttempt } from '../../../account-entry/social-attempt';

export function AppleLinkCallback({ origin, attempt, cancelled }: { origin: string; attempt: string; cancelled: boolean }) {
  const clerk = useClerk();
  const { isLoaded, userId, sessionId } = useAuth();
  const handled = useRef(false);

  useEffect(() => {
    if (!isLoaded || handled.current) return;
    handled.current = true;
    const finish = (result: AppleLinkResult) => window.location.replace(appleLinkReturnPath(result));

    async function check() {
      try {
        if (window.location.origin !== origin) return finish('unavailable');
        const submitted = consumeSocialAttempt<{
          attempt: string; userId: string; sessionId: string; accountId: string; startedAt: number;
        }>(appleLinkAttemptKey, (saved) => saved.attempt === attempt);
        if (!submitted) return finish('failed');

        const user = clerk.user;
        if (!userId || !sessionId || userId !== submitted.userId || sessionId !== submitted.sessionId
            || user?.id !== userId || clerk.session?.id !== sessionId) return finish('failed');
        if (cancelled) return finish('cancelled');

        const refreshed = await user.reload();
        if (refreshed.id !== userId || clerk.user?.id !== userId || clerk.session?.id !== sessionId) return finish('failed');
        const account = refreshed.externalAccounts.find((item) => item.provider === 'apple' && item.id === submitted.accountId);
        if (account?.verification?.status === 'verified') return finish('connected');
        if (account?.verification?.error?.code === 'oauth_access_denied') return finish('cancelled');
        finish('failed');
      } catch {
        finish('failed');
      }
    }
    void check();
  }, [attempt, cancelled, clerk, isLoaded, origin, sessionId, userId]);

  return <>
    <h1>Connect Apple</h1>
    <p role="status">Checking your Apple connection…</p>
    <Link className="entry-action entry-secondary" href={appleLinkReturnPath('failed')}>Return to Profile</Link>
  </>;
}
