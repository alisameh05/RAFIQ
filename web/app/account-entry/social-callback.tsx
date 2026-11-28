'use client';

import { useAuth, useClerk } from '@clerk/nextjs';
import { isClerkAPIResponseError } from '@clerk/nextjs/errors';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { consumeSocialAttempt } from './social-attempt';
import { socialAttemptKey, socialNames, socialReturnPath, type SocialProvider, type SocialResult } from './social-return';
import { accountPath, type EntryContext } from './return';

type Props = { provider: SocialProvider; origin: string; attempt: string; entry: EntryContext; signupOpen: boolean; cancelled: boolean };

function providerResult(code: string | undefined): SocialResult | undefined {
  switch (code) {
    case 'oauth_access_denied':
      return 'cancelled';
    case 'user_banned':
    case 'user_locked':
      return 'restricted';
    case 'sign_up_mode_restricted':
    case 'sign_up_restricted_waitlist':
      return 'signup-held';
  }
}

export function SocialCallback({ provider, origin, attempt, entry, signupOpen, cancelled }: Props) {
  const clerk = useClerk();
  const { isLoaded } = useAuth();
  const handled = useRef(false);
  const fallback = socialReturnPath(provider, entry, 'failed');

  useEffect(() => {
    if (!isLoaded || handled.current) return;
    handled.current = true;
    const returnToSignIn = (result: SocialResult) => window.location.replace(socialReturnPath(provider, entry, result));
    const failure = () => {
      const signIn = clerk.client?.signIn;
      const result = providerResult(signIn?.firstFactorVerification.error?.code);
      if (result) return returnToSignIn(result);
      if (!signupOpen && signIn?.firstFactorVerification.status === 'transferable') {
        return returnToSignIn('signup-held');
      }
      if (signIn?.status === 'needs_second_factor' || signIn?.status === 'needs_client_trust') {
        return returnToSignIn('verify');
      }
      returnToSignIn('failed');
    };

    async function finish() {
      try {
        if (window.location.origin !== origin) return returnToSignIn('unavailable');
        const query = new URLSearchParams({ attempt });
        if (entry) query.set('entry', entry);
        const submitted = consumeSocialAttempt<{ query: string; signInId: string; startedAt: number }>(
          socialAttemptKey(provider), (saved) => saved.query === query.toString(),
        );
        if (!submitted) return returnToSignIn('failed');
        if (cancelled) return returnToSignIn('cancelled');

        const signIn = clerk.client?.signIn;
        if (!signIn?.id || signIn.id !== submitted.signInId) return returnToSignIn('failed');
        await signIn.reload();
        if (clerk.client?.signIn.id !== submitted.signInId) return returnToSignIn('failed');
        const canTransfer = signIn.firstFactorVerification.status === 'transferable';
        if (signIn.status !== 'complete' && !(signupOpen && canTransfer)) return failure();

        const destination = origin + accountPath(entry);
        let fallbackUsed = false;
        await clerk.handleRedirectCallback({
          transferable: signupOpen,
          signInUrl: fallback,
          signUpUrl: fallback,
          signInForceRedirectUrl: destination,
          signUpForceRedirectUrl: destination,
        }, async () => {
          // Clerk reports incomplete flows through its navigation hook.
          fallbackUsed = true;
          failure();
        });
        if (!fallbackUsed && !clerk.session) failure();
      } catch (error) {
        const code = isClerkAPIResponseError(error) ? error.errors[0]?.code : undefined;
        returnToSignIn(providerResult(code) ?? 'failed');
      }
    }
    void finish();
  }, [attempt, cancelled, clerk, entry, fallback, isLoaded, origin, provider, signupOpen]);

  return <>
    <h1>Continue with {socialNames[provider]}</h1>
    <p role="status">Finishing {socialNames[provider]} sign-in…</p>
    <Link className="entry-action entry-secondary" href={fallback}>Return to sign in</Link>
  </>;
}
