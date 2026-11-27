'use client';

import { isClerkAPIResponseError, isClerkRuntimeError } from '@clerk/nextjs/errors';
import Link from 'next/link';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { clerkAction, codeExpired, useEntryRequest, useResendDelay } from '../account-entry/request';
import { signInPath, type EntryContext } from '../account-entry/return';
import { VerificationCode, verificationCodeLength } from '../account-entry/verification-code';
import type { ClerkSignIn } from './driver-access';

const genericReply = 'If that address can receive a reset code, check your inbox and spam folder.';
const incorrectCode = 'That code is incorrect or unavailable. Check the email or request another code.';
const membershipErrors = new Set(['form_identifier_not_found', 'form_identifier_not_verified', 'strategy_for_user_invalid']);

type Step = 'email' | 'code' | 'password' | 'complete';

export function RecoverAccess({ signIn, entry }: { signIn: ClerkSignIn; entry: EntryContext }) {
  const { run, pending, throttled } = useEntryRequest();
  const resend = useResendDelay();
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [expired, setExpired] = useState(false);
  const [notice, setNotice] = useState('');
  const [feedback, setFeedback] = useState('');
  const delivery = useRef(false);
  const [lastRequested, setLastRequested] = useState('');
  const nextFocus = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const resendButton = useRef<HTMLButtonElement>(null);
  const busy = Boolean(pending);
  const waitingToResend = resend.waiting && lastRequested === email.trim().toLowerCase();

  useEffect(() => {
    if (!busy && nextFocus.current) {
      nextFocus.current = false;
      if (step === 'complete') heading.current?.focus();
      else input.current?.focus();
    }
  }, [step, busy, notice]);

  function fail(failure: string, fallback: string) {
    setFeedback(failure === 'rate_limited' ? 'Too many attempts. Wait before trying again.' : fallback);
  }

  function requestCode() {
    if (busy || throttled || waitingToResend) return;
    setFeedback('');
    void run('Requesting code…', async () => {
      delivery.current = false;
      try {
        await clerkAction(signIn.reset());
        await clerkAction(signIn.create({ identifier: email.trim() }));
        await clerkAction(signIn.resetPasswordEmailCode.sendCode());
        delivery.current = true;
      } catch (error) {
        const unknownIdentity = isClerkAPIResponseError(error) && membershipErrors.has(error.errors[0]?.code);
        const unavailableFactor = isClerkRuntimeError(error) && error.code === 'factor_not_found';
        if (!unknownIdentity && !unavailableFactor) throw error;
      }
      resend.start();
      setLastRequested(email.trim().toLowerCase());
      setCode('');
      setExpired(false);
      setNotice(genericReply);
      nextFocus.current = true;
      setStep('code');
    }, (failure) => fail(failure, 'We couldn’t request a code. Try again.'));
  }

  function checkCode() {
    setFeedback('');
    if (code.length !== verificationCodeLength) {
      setFeedback('Enter the six-digit code.');
      input.current?.focus();
      return;
    }
    void run('Checking code…', async () => {
      if (!delivery.current) {
        setFeedback(incorrectCode);
        input.current?.focus();
        return;
      }
      await clerkAction(signIn.resetPasswordEmailCode.verifyCode({ code }));
      if (signIn.status !== 'needs_new_password') {
        setFeedback(incorrectCode);
        return;
      }
      setCode('');
      setNotice('Code accepted.');
      nextFocus.current = true;
      setStep('password');
    }, (failure) => {
      if (codeExpired(failure)) {
        setCode('');
        setExpired(true);
        setFeedback('This code has expired. Request a new one.');
        resendButton.current?.focus();
      } else {
        fail(failure, incorrectCode);
        input.current?.focus();
      }
    });
  }

  function savePassword() {
    if (!input.current) return;
    const password = input.current.value;
    input.current.value = '';
    setFeedback('');
    void run('Resetting password…', async () => {
      await clerkAction(signIn.resetPasswordEmailCode.submitPassword({ password, signOutOfOtherSessions: true }));
      if (signIn.status !== 'complete' && signIn.status !== 'needs_second_factor' && signIn.status !== 'needs_client_trust') {
        setFeedback('We couldn’t confirm the reset. Restart recovery or return to sign in.');
        return;
      }
      nextFocus.current = true;
      setNotice('Password reset.');
      setStep('complete');
    }, (failure) => {
      if (codeExpired(failure)) {
        restart();
        setFeedback('This reset attempt has expired. Request a new code.');
      } else {
        fail(failure, failure.startsWith('form_password_')
          ? 'Choose a different password that meets the requirements.'
          : 'We couldn’t reset your password. Enter a new password and try again.');
        input.current?.focus();
      }
    });
  }

  function restart(clear = false) {
    delivery.current = false;
    setCode('');
    setExpired(false);
    if (clear) setEmail('');
    setNotice('');
    setFeedback('');
    nextFocus.current = true;
    setStep('email');
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || throttled) return;
    if (step === 'email') requestCode();
    if (step === 'code' && !expired) checkCode();
    if (step === 'password') savePassword();
  }

  const label = { email: 'Recover access', code: 'Check your email', password: 'Choose a new password', complete: 'Sign in with your new password' };
  const describedBy = 'recovery-help' + (feedback ? ' recovery-error' : '');

  return <>
    <h1 ref={heading} tabIndex={-1}>{label[step]}</h1>
    <p className="entry-status" role="status">{pending || notice}</p>
    {step !== 'complete' &&
      <form method="post" onSubmit={submit}>
        {step === 'email' && <>
          <p id="recovery-help">Enter the email address you registered with RAFIQ.</p>
          <label htmlFor="recovery-address">Email address</label>
          <input id="recovery-address" type="email" autoComplete="email" ref={input} value={email}
            readOnly={busy} onChange={(event) => setEmail(event.target.value)} required aria-describedby={describedBy} />
        </>}
        {step === 'code' && <>
          <p id="recovery-help">Enter the six-digit reset code for <strong>{email}</strong>.</p>
          <label htmlFor="recovery-code">Reset code</label>
          <VerificationCode id="recovery-code" ref={input} value={code} readOnly={busy || expired}
            onCodeChange={setCode}
            aria-invalid={Boolean(feedback)} aria-describedby={describedBy} />
        </>}
        {step === 'password' && <>
          <label htmlFor="recovery-password">New password</label>
          <input id="recovery-password" type="password" autoComplete="new-password" ref={input} readOnly={busy}
            required aria-invalid={Boolean(feedback)} aria-describedby={describedBy} />
          <p id="recovery-help">Use a unique password. Clerk checks the password requirements.</p>
        </>}
        {feedback && <p role="alert" className="entry-error" id="recovery-error">{feedback}</p>}
        {(step === 'email' || step === 'code') && waitingToResend && <p>Wait before requesting another code.</p>}
        <div className="entry-actions">
          {step === 'email' && <button className="entry-action" disabled={busy || throttled || waitingToResend}>Request reset code</button>}
          {step === 'code' && <>
            {!expired && <button className="entry-action" disabled={busy || throttled}>Verify code</button>}
            <button className={expired ? 'entry-action' : 'entry-link'} type="button" ref={resendButton}
              onClick={requestCode} aria-disabled={busy || throttled || waitingToResend}>Resend code</button>
          </>}
          {step === 'password' && <button className="entry-action" disabled={busy || throttled}>Reset password</button>}
        </div>
      </form>}
    {step === 'code' && <button className="entry-link" type="button" disabled={busy} onClick={() => restart(true)}>Use a different email</button>}
    {step === 'password' && <button className="entry-link" type="button" disabled={busy} onClick={() => restart()}>Restart recovery</button>}
    <p><Link className={step === 'complete' ? 'entry-action' : undefined} href={signInPath(entry)}>
      {step === 'complete' ? 'Sign in' : 'Back to sign in'}
    </Link></p>
  </>;
}
