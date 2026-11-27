'use client';

import { useAuth, useSignUp } from '@clerk/nextjs';
import { isClerkAPIResponseError } from '@clerk/nextjs/errors';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useRef, useState } from 'react';

type ClerkSignup = ReturnType<typeof useSignUp>['signUp'];
type ProviderError = NonNullable<Awaited<ReturnType<ClerkSignup['password']>>['error']>;
type Field = 'email' | 'password' | 'code' | 'form';
type Feedback = { field: Field; message: string };
type Focus = 'heading' | 'email' | 'password' | 'code' | 'change' | 'resend';
const resendDelay = 30;

export function Signup() {
  const { isLoaded, isSignedIn } = useAuth();
  const { signUp } = useSignUp();
  if (!isLoaded) return <><h1>Create an account</h1><p role="status">Loading secure signup…</p></>;
  if (isSignedIn) return <><h1>Continue to RAFIQ</h1><Link href="/account">Check account status</Link></>;
  return <SignupForm signUp={signUp} />;
}

function SignupForm({ signUp }: { signUp: ClerkSignup }) {
  const router = useRouter();
  const [address, setAddress] = useState(signUp.hasPassword && signUp.status !== 'complete' ? signUp.emailAddress : null);
  const [email, setEmail] = useState('');
  const [editEmail, setEditEmail] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [selection, setSelection] = useState([0, 0]);
  const [needsCode, setNeedsCode] = useState(() => !signUp.verifications.emailAddress.strategy);
  const [expired, setExpired] = useState(() => signUp.verifications.emailAddress.status === 'expired');
  const [complete, setComplete] = useState(() => signUp.status === 'complete');
  const [pending, setPending] = useState('');
  const [notice, setNotice] = useState('');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [focus, setFocus] = useState<{ target: Focus } | null>(null);
  const [cooldown, setCooldown] = useState<{ until: number; scope: 'resend' | 'send' | 'verify' } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const changeButton = useRef<HTMLButtonElement>(null);
  const resendButton = useRef<HTMLButtonElement>(null);
  const running = useRef(false);

  useEffect(() => {
    if (!focus) return;
    const targets = { heading, email: emailInput, password: passwordInput, code: codeInput,
      change: changeButton, resend: resendButton };
    targets[focus.target].current?.focus();
  }, [focus]);

  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown(null), Math.max(0, cooldown.until - Date.now()));
    return () => clearTimeout(timer);
  }, [cooldown]);

  function moveFocus(target: Focus) {
    setFocus({ target });
  }

  function showError(field: Field, message: string) {
    setFeedback({ field, message });
    if (field !== 'form') moveFocus(field);
  }

  function handleProviderError(error: ProviderError, fallback: string, field: Field = 'form', verifying = false) {
    const apiError = isClerkAPIResponseError(error) ? error : null;
    const detail = apiError?.errors[0];
    const errorCode = detail?.code ?? error.code;
    if (['sign_up_mode_restricted', 'sign_up_restricted_waitlist'].includes(errorCode)) {
      router.replace('/?signup=pending');
    } else if (apiError?.status === 429 || errorCode === 'verification_code_too_many_requests') {
      const wait = apiError?.retryAfter ?? resendDelay;
      setCooldown({ until: Date.now() + Math.max(resendDelay, wait) * 1000, scope: verifying ? 'verify' : 'send' });
      showError('form', 'Too many attempts. Wait before trying again.');
    } else if (verifying && ['verification_expired', 'verification_failed', 'sign_up_outdated_verification'].includes(errorCode)) {
      setExpired(true);
      showError('form', 'This code has expired. Request a new one.');
      moveFocus('resend');
    } else if (verifying && errorCode === 'form_code_incorrect') {
      showError('code', 'That code is incorrect. Check the message and try again.');
    } else if (errorCode.startsWith('form_password_') || detail?.meta?.paramName === 'password') {
      showError('password', detail?.longMessage || 'Choose a password that meets the requirements.');
    } else if (errorCode === 'form_identifier_exists') {
      showError('email', 'Use another address or sign in to an existing account.');
    } else if (['email_address', 'emailAddress'].includes(detail?.meta?.paramName ?? '')) {
      showError('email', 'Check your email address or try a different one.');
    } else {
      showError(field, fallback);
    }
  }

  async function run(label: string, failure: string, action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setPending(label);
    setFeedback(null);
    setNotice('');
    try {
      await action();
    } catch {
      showError('form', failure);
    } finally {
      running.current = false;
      setPending('');
    }
  }

  async function sendCode() {
    const { error } = await signUp.verifications.sendEmailCode();
    if (error) {
      handleProviderError(error, 'We couldn’t send a code. Try again.');
      return;
    }
    setCooldown({ until: Date.now() + resendDelay * 1000, scope: 'resend' });
    setNeedsCode(false);
    setExpired(false);
    setCode('');
    setSelection([0, 0]);
    setEditEmail(null);
    setNotice('Verification code sent.');
    moveFocus('code');
  }

  function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = passwordInput.current?.value ?? '';
    if (passwordInput.current) passwordInput.current.value = '';
    void run('Creating account…', 'We couldn’t start signup. Enter your password to try again.', async () => {
      const { error } = await signUp.password({ emailAddress: email.trim(), password });
      if (error) {
        handleProviderError(error, 'We couldn’t start signup. Enter your password to try again.');
        return;
      }
      if (!signUp.emailAddress || !signUp.unverifiedFields.includes('email_address')) {
        showError('form', 'Email verification is unavailable. Try again later or sign in.');
        return;
      }
      setAddress(signUp.emailAddress);
      setNeedsCode(true);
      moveFocus('heading');
      await sendCode();
    });
  }

  function correctAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editEmail === null) return;
    const corrected = editEmail.trim();
    void run('Sending code…', 'We couldn’t send a code. Try again.', async () => {
      if (corrected !== address) {
        const { error } = await signUp.update({ emailAddress: corrected });
        if (error) {
          handleProviderError(error, 'We couldn’t change the address. Try again.', 'email');
          return;
        }
        setAddress(signUp.emailAddress ?? corrected);
        setCode('');
        setSelection([0, 0]);
        setExpired(false);
        setNeedsCode(true);
      }
      await sendCode();
    });
  }

  function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (needsCode || expired || cooldown?.scope === 'verify') return;
    if (code.length !== 6) {
      showError('code', 'Enter the six-digit code.');
      return;
    }
    void run('Verifying…', 'We couldn’t verify the code. Try again.', async () => {
      const { error } = await signUp.verifications.verifyEmailCode({ code });
      if (error) {
        handleProviderError(error, 'We couldn’t verify the code. Try again.', 'form', true);
        return;
      }
      if (signUp.status !== 'complete') {
        showError('form', 'We couldn’t finish signup. Continue through sign in.');
        return;
      }
      setCode('');
      const { error: activationError } = await signUp.finalize({
        navigate: ({ session, decorateUrl }) => {
          if (!session || session.currentTask) {
            setComplete(true);
            moveFocus('heading');
            return;
          }
          const url = decorateUrl('/account?verified=1');
          if (url.startsWith('http')) window.location.assign(url);
          else router.replace(url);
        },
      }).catch(() => ({ error: true }));
      if (activationError) {
        setComplete(true);
        moveFocus('heading');
      }
    });
  }

  const disabled = Boolean(pending);
  const resendFirst = needsCode || expired;
  const errorFor = (field: Field) => feedback?.field === field;
  const errorText = feedback && <p id="signup-error" className="entry-error" role="alert">{feedback.message}</p>;
  const resend = (
    <button ref={resendButton} type="button"
      className={resendFirst ? 'entry-action' : 'entry-link'}
      aria-disabled={disabled || Boolean(cooldown)} aria-describedby={cooldown ? 'resend-wait' : undefined}
      onClick={() => {
        if (!cooldown) void run('Sending code…', 'We couldn’t send a code. Try again.', sendCode);
      }}>{needsCode ? 'Send verification code' : 'Resend verification'}</button>
  );

  return (
    <>
      <h1 ref={heading} tabIndex={-1}>{complete ? 'Continue to sign in' : address ? 'Verify your email' : 'Create an account'}</h1>
      <p className="entry-status" role="status">{complete ? 'Email verified' : pending || notice}</p>
      {complete ? (
        <Link className="entry-action" href="/sign-in">Sign in</Link>
      ) : address ? (
        <>
          <p id="verification-destination">
            {needsCode ? 'Send a six-digit code to ' : 'Enter the six-digit code sent to '}
            <strong>{address}</strong> to verify your email.
          </p>
          {editEmail !== null ? (
            <form method="post" onSubmit={correctAddress}>
              <label htmlFor="corrected-email">Corrected email address</label>
              <input id="corrected-email" ref={emailInput} type="email" autoComplete="email"
                value={editEmail} onChange={(event) => setEditEmail(event.target.value)} required readOnly={disabled}
                aria-invalid={errorFor('email')} aria-describedby={errorFor('email') ? 'signup-error' : undefined} />
              {errorText}
              {cooldown && <p id="resend-wait">Please wait before requesting another code.</p>}
              <div className="entry-actions">
                <button className="entry-action" disabled={disabled || cooldown?.scope === 'verify'
                  || (Boolean(cooldown) && (cooldown?.scope === 'send' || editEmail.trim() === address))}>Send code</button>
                <button className="entry-action entry-secondary" type="button" disabled={disabled} onClick={() => {
                  setEditEmail(null);
                  setFeedback(null);
                  moveFocus('change');
                }}>Cancel</button>
              </div>
            </form>
          ) : (
            <>
              <button ref={changeButton} type="button" className="entry-link" disabled={disabled} onClick={() => {
                setEditEmail(address);
                setFeedback(null);
                setNotice('');
                moveFocus('email');
              }}>Change email</button>
              <form method="post" onSubmit={verify}>
                <label htmlFor="signup-code">Verification code</label>
                <div className="entry-code">
                  {Array.from({ length: 6 }, (_, index) => (
                    <span key={index} aria-hidden="true"
                      data-caret={index === Math.min(5, selection[0]) && selection[0] === selection[1] ? '' : undefined}
                      data-selected={index >= selection[0] && index < selection[1] ? '' : undefined}>{code[index]}</span>
                  ))}
                  <input id="signup-code" type="text" inputMode="numeric" autoComplete="one-time-code"
                    spellCheck={false} ref={codeInput} value={code} readOnly={disabled || resendFirst}
                    aria-invalid={errorFor('code')} aria-describedby={errorFor('code') ? 'signup-error' : 'verification-destination'}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    onSelect={(event) => setSelection([event.currentTarget.selectionStart ?? 0, event.currentTarget.selectionEnd ?? 0])} />
                </div>
                {errorText}
                {cooldown && <p id="resend-wait">Please wait before requesting another code.</p>}
                <div className="entry-actions">
                  {resendFirst && resend}
                  {!resendFirst && <button className="entry-action" disabled={disabled || cooldown?.scope === 'verify'}>Verify email</button>}
                  {!resendFirst && resend}
                </div>
              </form>
            </>
          )}
        </>
      ) : (
        <>
          <p>RAFIQ is for adults 18 and older.</p>
          <form method="post" onSubmit={register}>
            <label htmlFor="signup-email">Email address</label>
            <input id="signup-email" ref={emailInput} type="email" autoComplete="email"
              required value={email} onChange={(event) => setEmail(event.target.value)} readOnly={disabled}
              aria-invalid={errorFor('email')} aria-describedby={errorFor('email') ? 'signup-error' : undefined} />
            {errorFor('email') && errorText}
            <label htmlFor="signup-password">Password</label>
            <input id="signup-password" ref={passwordInput} type="password" autoComplete="new-password"
              required readOnly={disabled}
              aria-invalid={errorFor('password')}
              aria-describedby={errorFor('password') ? 'signup-password-help signup-error' : 'signup-password-help'} />
            <p id="signup-password-help">Use a unique password. Clerk checks the requirements for this environment.</p>
            {feedback && !errorFor('email') && errorText}
            <div id="clerk-captcha" />
            <div className="entry-actions">
              <button className="entry-action" disabled={disabled || Boolean(cooldown)}>Create account</button>
            </div>
          </form>
        </>
      )}
      {!complete && <p>Already have an account? <Link href="/sign-in">Sign in</Link></p>}
    </>
  );
}
