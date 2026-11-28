'use client';

import Link from 'next/link';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { privatePath } from '../account-entry/return';
import {
  acknowledgeRecordingWithdrawal, beginRecordingWithdrawal, defaultClipPreferences, pendingRecordingWithdrawal,
  RecordingRevisionConflict, recordingSnapshotForSession, sameClipPreferences, subscribeToRecordingWithdrawal,
  type ClipPreferences, type RecordingConsent, type RequestRecordingConsent,
} from './recording-consent';

type ConsentSource = { accountId: string; request: RequestRecordingConsent };

export function useRecordingSettings({ accountId, request }: ConsentSource, resume = 0) {
  const [current, setCurrent] = useState<RecordingConsent>();
  const [load, setLoad] = useState<'loading' | 'failed' | 'ready'>('loading');
  const [draft, setDraft] = useState<ClipPreferences>();
  const [optIn, setOptIn] = useState(false);
  const [review, setReview] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [withdrawalPending, setWithdrawalPending] = useState(() =>
    typeof window !== 'undefined' && Boolean(pendingRecordingWithdrawal(accountId)));
  const [withdrawing, setWithdrawing] = useState(false);
  const [unconfirmedEnable, setUnconfirmedEnable] = useState(false);
  const active = useRef<AbortController | null>(null);
  const localWithdrawal = useRef(false);
  const behaviorLabels = current?.catalog.behaviors ?? {};
  const values = draft ?? current?.settings ?? defaultClipPreferences;
  const preferences = { ...values, behaviors: values.behaviors.filter((code) => Object.hasOwn(behaviorLabels, code)) };
  const allowed = load === 'ready' && !withdrawalPending && Boolean(recordingSnapshotForSession(accountId, current));
  const enabled = allowed || optIn;
  const dirty = Boolean(current && !withdrawalPending && (optIn || (current.settings.enabled &&
    draft && !sameClipPreferences(draft, current.settings))));

  function replaceOperation() {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    return controller;
  }

  async function read(checkDraft = true) {
    const controller = replaceOperation();
    setLoad('loading');
    try {
      const consent = await request(controller.signal);
      if (controller.signal.aborted) return;
      if (checkDraft && dirty &&
          (current?.revision !== consent.revision || current.catalog.version !== consent.catalog.version)) setReview(true);
      setCurrent(consent);
      setLoad('ready');
    } catch {
      if (!controller.signal.aborted) setLoad('failed');
    } finally {
      if (active.current === controller) active.current = null;
    }
  }

  const refresh = useEffectEvent(() => {
    if (!active.current) void read();
  });

  const syncWithdrawal = useEffectEvent(() => {
    const pending = Boolean(pendingRecordingWithdrawal(accountId));
    if (localWithdrawal.current) return;
    setWithdrawalPending(pending);
    setOptIn(false);
    setDraft(undefined);
    setReview(false);
    setUnconfirmedEnable(false);
    setSaveState('idle');
    void read(false);
  });

  useEffect(() => {
    const unsubscribe = subscribeToRecordingWithdrawal(accountId, () => syncWithdrawal());
    return () => {
      unsubscribe();
      active.current?.abort();
      active.current = null;
    };
  }, [accountId]);

  useEffect(() => {
    refresh();
  }, [resume]);

  function update(patch: Partial<ClipPreferences>) {
    setDraft({ ...preferences, ...patch });
    setSaveState('idle');
  }

  function chooseOptIn(checked: boolean) {
    setOptIn(checked);
    setSaveState('idle');
  }

  async function save() {
    if (!current || !dirty || !enabled || review || load !== 'ready' || active.current ||
        pendingRecordingWithdrawal(accountId)) return;
    const controller = replaceOperation();
    const settings = { ...preferences, enabled: true };
    setSaveState('saving');
    setUnconfirmedEnable(true);
    try {
      const confirmed = await request(controller.signal, { expectedRevision: current.revision, settings });
      if (controller.signal.aborted || pendingRecordingWithdrawal(accountId)) return;
      if (confirmed.revision === current.revision || !confirmed.settings.enabled ||
          !sameClipPreferences(confirmed.settings, settings)) {
        throw new Error('Recording settings were not acknowledged');
      }
      setCurrent(confirmed);
      setDraft(undefined);
      setOptIn(false);
      setUnconfirmedEnable(false);
      setSaveState('saved');
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof RecordingRevisionConflict) {
        setUnconfirmedEnable(false);
        setReview(true);
        setSaveState('idle');
        await read();
      } else {
        setSaveState('failed');
      }
    } finally {
      if (active.current === controller) active.current = null;
    }
  }

  async function withdraw(onConfirmed: () => void) {
    if (localWithdrawal.current) return;
    localWithdrawal.current = true;
    const controller = replaceOperation();
    const { signal } = controller;
    const marker = beginRecordingWithdrawal(accountId);
    setWithdrawalPending(true);
    setWithdrawing(true);
    setOptIn(false);
    setDraft(undefined);
    setReview(false);
    setUnconfirmedEnable(false);
    setSaveState('idle');

    async function submit(consent: RecordingConsent) {
      const confirmed = await request(signal, {
        expectedRevision: consent.revision, settings: { ...consent.settings, enabled: false },
      });
      if (confirmed.revision === consent.revision || confirmed.settings.enabled) {
        throw new Error('Recording withdrawal was not acknowledged');
      }
      return confirmed;
    }

    let acknowledged = false;
    try {
      const consent = current ?? await request(signal);
      let confirmed: RecordingConsent;
      try {
        confirmed = await submit(consent);
      } catch (error) {
        if (!(error instanceof RecordingRevisionConflict)) throw error;
        confirmed = await submit(await request(signal));
      }
      if (signal.aborted || !acknowledgeRecordingWithdrawal(accountId, marker) ||
          pendingRecordingWithdrawal(accountId)) return;
      onConfirmed();
      setCurrent(confirmed);
      setLoad('ready');
      acknowledged = true;
      setWithdrawalPending(false);
    } catch {
      // Keep the local stop until the account acknowledges withdrawal.
    } finally {
      localWithdrawal.current = false;
      if (active.current === controller) {
        active.current = null;
        setWithdrawing(false);
        // A newer tab can complete withdrawal while this request is still in flight.
        if (!signal.aborted && !acknowledged && !pendingRecordingWithdrawal(accountId)) {
          setWithdrawalPending(false);
          void read(false);
        }
      }
    }
  }

  return {
    current, load, allowed, behaviorLabels, preferences, optIn, enabled, dirty, review, saveState,
    withdrawalPending, withdrawing, unconfirmedEnable, retry: read, save, update, chooseOptIn, withdraw,
    acceptReview: () => setReview(false),
  };
}

type RecordingEditor = ReturnType<typeof useRecordingSettings>;

function recordingStatus(editor: RecordingEditor, privacy: boolean) {
  if (editor.withdrawalPending) return 'Recording stopped on this device. Account update pending.';
  if (editor.load === 'loading') return privacy ? 'Checking…' : 'Checking recording consent…';
  if (editor.load === 'failed') return 'Couldn’t check recording status.';
  if (editor.allowed) return privacy ? 'Allowed for selected incidents' : 'Recording allowed';
  return privacy ? 'Off' : 'Recording off';
}

function RecordingStatus({ editor, privacy = false }: { editor: RecordingEditor; privacy?: boolean }) {
  const status = useRef<HTMLParagraphElement>(null);
  const action = useRef<HTMLButtonElement>(null);
  const showWithdraw = !privacy && (editor.withdrawalPending || editor.current?.settings.enabled || editor.unconfirmedEnable);
  return <>
    <p ref={status} tabIndex={-1} role="status">{recordingStatus(editor, privacy)}</p>
    {editor.load === 'failed' && !editor.withdrawalPending &&
      <button className="entry-action entry-secondary" type="button" onClick={() => {
        status.current?.focus();
        void editor.retry();
      }}>Retry recording status</button>}
    {showWithdraw && <>
      <p id="recording-withdrawal-help">Withdrawal stops capture, discards unsent clips and blocks pending publication. Monitoring and warnings continue.</p>
      <button ref={action} className="entry-action entry-secondary" type="button" aria-disabled={editor.withdrawing}
        aria-describedby="recording-withdrawal-help" onClick={() => void editor.withdraw(() => {
          if (document.activeElement === action.current) status.current?.focus();
        })}>
        {editor.withdrawing ? 'Updating account…' : editor.withdrawalPending ? 'Retry withdrawal' : 'Withdraw recording consent'}
      </button>
    </>}
  </>;
}

export function RecordingControls({ editor, saving, focusSave }: {
  editor: RecordingEditor;
  saving: boolean;
  focusSave: () => void;
}) {
  const disabled = saving || !editor.enabled || editor.load !== 'ready' || editor.withdrawalPending;
  const { preferences } = editor;
  function toggle(behavior: string, checked: boolean) {
    editor.update({ behaviors: checked ? [...preferences.behaviors, behavior]
      : preferences.behaviors.filter((selected) => selected !== behavior) });
  }
  return <section className="monitoring-section" aria-labelledby="incident-recording">
    <h2 id="incident-recording">Incident recording</h2>
    <RecordingStatus editor={editor} />
    <p>Monitoring stays available with recording off.</p>
    {editor.load === 'ready' && !editor.allowed && !editor.withdrawalPending &&
      <label className="monitoring-choice">
        <input type="checkbox" checked={editor.optIn} disabled={saving}
          onChange={(event) => editor.chooseOptIn(event.target.checked)} /> Allow video-only incident clips
      </label>}
    {editor.optIn && !editor.allowed && <p>Opt-in is a draft until you save and confirm it.</p>}
    {!editor.enabled && <p>Choose to allow recording to edit categories and context.</p>}
    <fieldset className="monitoring-visibility" disabled={disabled} aria-describedby="recording-empty-help">
      <legend>Behaviors to record</legend>
      {Object.entries(editor.behaviorLabels).map(([behavior, label]) =>
        <label key={behavior} className="monitoring-choice">
          <input type="checkbox" checked={preferences.behaviors.includes(behavior)}
            onChange={(event) => toggle(behavior, event.target.checked)} /> {label}
        </label>)}
    </fieldset>
    <p id="recording-empty-help">With no categories selected, no incidents match for recording.</p>
    <fieldset className="recording-context" disabled={disabled}>
      <legend>Clip context</legend>
      <div>
        <label htmlFor="recording-before">Before incident</label>
        <SecondsPicker id="recording-before" value={preferences.preSeconds}
          onChange={(preSeconds) => editor.update({ preSeconds })} />
      </div>
      <div>
        <label htmlFor="recording-after">After incident</label>
        <SecondsPicker id="recording-after" value={preferences.postSeconds}
          onChange={(postSeconds) => editor.update({ postSeconds })} />
      </div>
    </fieldset>
    <p>Clips are video-only. Each clip is limited to 30 seconds and 20 MB.</p>
    <details>
      <summary>How clips are saved</summary>
      <p>If a clip reaches either limit, RAFIQ keeps the first segment and labels it “Available first segment.”
        The live feed and unused temporary context stay on this device.</p>
    </details>
    <p><Link href={privatePath('privacy')} prefetch={false}>Privacy</Link></p>
    {editor.review && <div>
      <p role="alert">Recording consent changed. Review the current settings and your draft before saving again.</p>
      {editor.load === 'ready' && editor.current && <>
        <p>Current categories: {editor.current.settings.behaviors.flatMap((key) =>
          Object.hasOwn(editor.behaviorLabels, key) ? [editor.behaviorLabels[key]] : []).join(', ') || 'None'}.
          {' '}Current context: {durationLabel(editor.current.settings.preSeconds)} before and {durationLabel(editor.current.settings.postSeconds)} after.</p>
        <button className="entry-action entry-secondary" type="button" onClick={() => {
          editor.acceptReview();
          focusSave();
        }}>I reviewed the current settings and draft</button>
      </>}
    </div>}
  </section>;
}

function durationLabel(seconds: number) {
  return seconds + (seconds === 1 ? ' second' : ' seconds');
}

function SecondsPicker({ id, value, onChange }: { id: string; value: number; onChange: (value: number) => void }) {
  return <select id={id} value={value} onChange={(event) => onChange(Number(event.target.value))}>
    {[0, 1, 2, 3, 4, 5].map((seconds) =>
      <option key={seconds} value={seconds}>{durationLabel(seconds)}</option>)}
  </select>;
}

export function RecordingPrivacy({ request, accountId, resume }: ConsentSource & { resume: number }) {
  const editor = useRecordingSettings({ request, accountId }, resume);
  return <section className="monitoring-section" aria-labelledby="privacy-recording">
    <h2 id="privacy-recording">Incident recording</h2>
    <RecordingStatus editor={editor} privacy />
    <p>RAFIQ can save video-only clips for selected incident categories when consent is on. Monitoring runs with recording off.</p>
    <p>Withdrawing consent stops capture, discards unsent clips and blocks pending publication.</p>
    <Link href={privatePath('monitoring') + '#incident-recording'} prefetch={false}>Manage recording</Link>
  </section>;
}
