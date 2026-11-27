'use client';

import { isClerkAPIResponseError } from '@clerk/nextjs/errors';
import { useEffect, useRef, useState } from 'react';

export async function clerkAction(action: Promise<{ error: unknown }>) {
  const { error } = await action;
  if (error) throw error;
}

export function codeExpired(code: string) {
  return ['verification_expired', 'verification_failed', 'resource_not_found', 'sign_in_attempt_expired'].includes(code);
}

function useCooldown() {
  const [until, setUntil] = useState(0);
  useEffect(() => {
    if (!until) return;
    const timer = setTimeout(() => setUntil(0), Math.max(0, until - Date.now()));
    return () => clearTimeout(timer);
  }, [until]);
  return { waiting: Boolean(until), start: (seconds = 30) => setUntil(Date.now() + seconds * 1000) };
}

export const useResendDelay = useCooldown;

export function useEntryRequest() {
  const running = useRef(false);
  const [pending, setPending] = useState('');
  const throttle = useCooldown();

  async function run(label: string, action: () => Promise<void>, failed: (code: string) => void) {
    if (running.current || throttle.waiting) return;
    running.current = true;
    setPending(label);
    try {
      await action();
    } catch (error) {
      const api = isClerkAPIResponseError(error) ? error : null;
      const code = api?.errors[0]?.code ?? '';
      if (api?.status === 429 || code === 'verification_code_too_many_requests') {
        throttle.start(Math.max(30, api?.retryAfter ?? 0));
        failed('rate_limited');
      } else {
        failed(code);
      }
    } finally {
      setPending('');
      running.current = false;
    }
  }

  return { pending, throttled: throttle.waiting, run };
}
