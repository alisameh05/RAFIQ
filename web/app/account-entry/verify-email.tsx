'use client';

import { type FormEvent, useEffect, useRef, useState } from 'react';
import { codeExpired, useEntryRequest, useResendDelay } from './request';
import { VerificationCode, verificationCodeLength } from './verification-code';

type Props = {
  address: string;
  send: () => Promise<void>;
  verify: (code: string) => Promise<boolean>;
  changeEmail: () => Promise<void>;
};

export function VerifyEmail({ address, send, verify, changeEmail }: Props) {
  const { run, pending, throttled } = useEntryRequest();
  const resend = useResendDelay();
  const [delivery, setDelivery] = useState<'initial' | 'sent' | 'expired'>('initial');
  const sent = delivery === 'sent';
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState('');
  const [feedback, setFeedback] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const codeField = useRef<HTMLInputElement>(null);
  const sendButton = useRef<HTMLButtonElement>(null);
  const busy = Boolean(pending);

  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    if (sent && !busy && notice) codeField.current?.focus();
  }, [sent, busy, notice]);

  function sendCode() {
    if (busy || throttled || resend.waiting) return;
    setFeedback('');
    setNotice('');
    void run('Sending code…', async () => {
      await send();
      resend.start();
      setDelivery('sent');
      setCode('');
      setNotice('Verification code sent.');
    }, (failure) => {
      setFeedback(failure === 'rate_limited' ? 'Too many attempts. Wait before trying again.' : 'We couldn’t send a code. Try again.');
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!sent || busy || throttled) return;
    setFeedback('');
    setNotice('');
    if (code.length !== verificationCodeLength) {
      setFeedback('Enter the six-digit code.');
      codeField.current?.focus();
      return;
    }
    void run('Verifying…', async () => {
      if (await verify(code)) setCode('');
      else setFeedback('We couldn’t finish verification. Return to sign in and try again.');
    }, (failure) => {
      if (codeExpired(failure)) {
        setDelivery('expired');
        setCode('');
        setFeedback('This code has expired. Request a new one.');
        requestAnimationFrame(() => sendButton.current?.focus());
      } else {
        setFeedback(failure === 'rate_limited' ? 'Too many attempts. Wait before trying again.'
          : failure === 'form_code_incorrect' ? 'That code is incorrect. Check the message and try again.'
            : 'We couldn’t verify the code. Try again.');
        codeField.current?.focus();
      }
    });
  }

  return <>
    <h1 ref={heading} tabIndex={-1}>Verify your email</h1>
    <p id="driver-verification-help">Verify <strong>{address}</strong> before continuing to RAFIQ.</p>
    <p role="status" className="entry-status">{pending || notice}</p>
    <button className="entry-link" type="button" disabled={busy} onClick={() => {
      void changeEmail().catch(() => setFeedback('We couldn’t restart sign-in. Try again.'));
    }}>Change email</button>
    <form method="post" onSubmit={submit}>
      {sent && <>
        <label htmlFor="driver-verification-code">Verification code</label>
        <VerificationCode ref={codeField} id="driver-verification-code" value={code} readOnly={busy}
          onCodeChange={setCode}
          aria-invalid={Boolean(feedback)} aria-describedby={'driver-verification-help' + (feedback ? ' driver-verification-error' : '')} />
      </>}
      {feedback && <p id="driver-verification-error" className="entry-error" role="alert">{feedback}</p>}
      {resend.waiting && <p>Please wait before requesting another code.</p>}
      <div className="entry-actions">
        {sent && <button className="entry-action" disabled={busy || throttled}>Verify email</button>}
        <button className={sent ? 'entry-link' : 'entry-action'} ref={sendButton} type="button"
          aria-disabled={busy || throttled || resend.waiting}
          onClick={sendCode}>{delivery === 'initial' ? 'Send verification code' : 'Resend verification'}</button>
      </div>
    </form>
  </>;
}
