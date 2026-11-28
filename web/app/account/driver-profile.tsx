'use client';

import { UserProfile } from '@clerk/nextjs';
import Link from 'next/link';
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { AppleLinkResult } from '../account-entry/apple-link-return';
import { AppleLink } from './apple-link';
import { privatePath } from '../account-entry/return';

export type ProfileAccount = { accountId: string; displayName: string | null; registeredEmail: string };

type IdentityState = 'ready' | 'manage' | 'checking' | 'failed';
type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

export function DriverProfile({ account, draftValue, changeDraft, requestProfile, canManageIdentity, signOut, appleOrigin, appleLinkResult }: {
  account: ProfileAccount;
  draftValue: string | undefined;
  changeDraft: (value?: string) => void;
  requestProfile: (displayName?: string) => Promise<void>;
  canManageIdentity: boolean;
  signOut: () => void;
  appleOrigin?: string;
  appleLinkResult?: AppleLinkResult;
}) {
  const draft = draftValue ?? account.displayName ?? '';
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [identity, setIdentity] = useState<IdentityState>('ready');
  const [fieldError, setFieldError] = useState(false);
  const name = useRef<HTMLInputElement>(null);
  const saveTrigger = useRef<HTMLButtonElement>(null);
  const signOutTrigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const confirmExit = useRef<HTMLButtonElement>(null);
  const manageTrigger = useRef<HTMLButtonElement>(null);
  const returnFromIdentity = useRef<HTMLButtonElement>(null);
  const returningToProfile = useRef(false);
  const dirty = draft !== (account.displayName ?? '');
  const saving = saveState === 'saving';
  const submittedSave = saveState !== 'idle';

  useLayoutEffect(() => {
    if (identity === 'manage') returnFromIdentity.current?.focus();
    if (identity === 'ready' && returningToProfile.current) {
      returningToProfile.current = false;
      manageTrigger.current?.focus();
    }
  }, [identity]);

  function showFieldError() {
    setFieldError(true);
    name.current?.focus();
  }

  async function save(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!dirty || saving || identity !== 'ready') return;
    const displayName = draft.trim();
    if (!displayName || [...displayName].length > 100 || /[\u0000\uD800-\uDFFF]/u.test(displayName)) {
      showFieldError();
      return;
    }

    setFieldError(false);
    setSaveState('saving');
    try {
      await requestProfile(displayName);
      changeDraft();
      setSaveState('saved');
    } catch (error) {
      if (error instanceof Error && error.message === 'validation_failed') {
        setSaveState('idle');
        showFieldError();
      } else {
        setSaveState('failed');
      }
    }
  }

  async function refreshIdentity() {
    returningToProfile.current = true;
    if (window.location.hash) {
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    }
    setIdentity('checking');
    try {
      await requestProfile();
      setIdentity('ready');
    } catch {
      setIdentity('failed');
    }
  }

  function confirmSignOut() {
    if (!dirty) {
      signOut();
      return;
    }
    dialog.current?.showModal();
    keepEditing.current?.focus();
  }

  return <>
    {identity === 'manage' ? <section aria-labelledby="identity-management">
      <h2 id="identity-management">Manage sign-in details</h2>
      <button className="entry-action entry-secondary" type="button" ref={returnFromIdentity} onClick={() => void refreshIdentity()}>
        Return to Profile
      </button>
      {canManageIdentity && <div className="profile-clerk">
        <UserProfile routing="hash" apiKeysProps={{ hide: true }} />
      </div>}
    </section> : <>
      <form className="profile-row" onSubmit={save} noValidate>
        <label htmlFor="display-name">Display name</label>
        <input id="display-name" ref={name} value={draft} readOnly={saving} autoComplete="nickname"
          aria-invalid={fieldError || undefined} aria-describedby="display-name-guidance"
          onChange={(event) => {
            const value = event.target.value;
            changeDraft(value === (account.displayName ?? '') ? undefined : value);
            setFieldError(false);
            setSaveState('idle');
          }} />
        <p id="display-name-guidance" className={fieldError ? 'entry-error' : undefined}>
          {fieldError ? 'Enter a display name from 1 to 100 characters.' : '1–100 characters'}
        </p>
        <div className="profile-actions">
          <button className="entry-action profile-save" type="submit" ref={saveTrigger}
            aria-disabled={!dirty || saving || identity !== 'ready'}>
            Save changes
          </button>
          <span className="profile-status" role="status">
            {saving && 'Saving…'}
            {saveState === 'saved' && <><span aria-hidden="true">✓ </span>Saved</>}
          </span>
        </div>
        {saveState === 'failed' && <div className="profile-actions">
          <p role="alert">Couldn’t save your display name</p>
          <button className="entry-link" type="button" disabled={identity !== 'ready'} onClick={() => {
            saveTrigger.current?.focus();
            void save();
          }}>Retry</button>
        </div>}
      </form>
      <section className="profile-row" aria-labelledby="registered-email">
        <h2 id="registered-email">Registered email</h2>
        {identity === 'ready' && <p className="profile-email">{account.registeredEmail}</p>}
        <p className="profile-status" role="status">
          {identity === 'ready' && <><span aria-hidden="true">✓ </span>Verified</>}
          {identity === 'checking' && 'Checking verification…'}
        </p>
        {identity === 'failed' && <div className="profile-actions">
          <p role="alert">Couldn’t check verification</p>
          <button className="entry-link" type="button" onClick={() => void refreshIdentity()}>Retry verification</button>
        </div>}
        <button className="entry-action entry-secondary" type="button" ref={manageTrigger}
          disabled={!canManageIdentity || identity !== 'ready' || saving} onClick={() => setIdentity('manage')}>
          Manage sign-in details
        </button>
        {!canManageIdentity && <p>Sign-in details management is currently unavailable.</p>}
      </section>
      {(appleOrigin || appleLinkResult) && <AppleLink origin={appleOrigin} result={appleLinkResult}
        recheck={requestProfile} busy={dirty || saving || identity !== 'ready'} />}
      <div className="profile-row profile-links">
        <Link href={privatePath('sessions')} prefetch={false}>View session history</Link>
        <Link href={privatePath('privacy')} prefetch={false}>Privacy</Link>
      </div>
      <div className="profile-row">
        <button className="entry-action entry-secondary" type="button" ref={signOutTrigger} onClick={confirmSignOut}>
          Sign out
        </button>
      </div>
      <dialog ref={dialog} className="profile-dialog" role="alertdialog" aria-labelledby="sign-out-title"
        aria-describedby="sign-out-description" onClose={() => signOutTrigger.current?.focus()}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const [first, last] = [keepEditing.current, confirmExit.current];
          const edge = event.shiftKey ? first : last;
          if (document.activeElement === edge) {
            event.preventDefault();
            (event.shiftKey ? last : first)?.focus();
          }
        }}>
        <h2 id="sign-out-title">{submittedSave ? 'Sign out?' : 'Sign out without saving?'}</h2>
        <p id="sign-out-description">
          {saveState === 'saved' ? 'Your display name was saved.'
            : submittedSave ? 'Your submitted display name may still be saved if you sign out now.'
            : 'Any unsaved display name changes will be discarded.'}
        </p>
        <div className="profile-actions">
          <button className="entry-action" type="button" ref={keepEditing} onClick={() => dialog.current?.close()}>
            Keep editing
          </button>
          <button className="entry-action entry-secondary" type="button" ref={confirmExit} onClick={() => {
            dialog.current?.close();
            signOut();
          }}>Sign out</button>
        </div>
      </dialog>
    </>}
  </>;
}
