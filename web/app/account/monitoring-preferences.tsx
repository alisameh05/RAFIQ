'use client';

import Link from 'next/link';
import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from 'react';
import { privatePath } from '../account-entry/return';

export type Preferences = {
  cameraDeviceId: string | null;
  warningAudio: boolean;
  warningVisibility: 'default' | 'enhanced';
};

type RequestPreferences = (signal: AbortSignal, draft?: Preferences) => Promise<Preferences>;
type Camera = { deviceId: string; label: string };
type CameraCheck = { state: 'listed'; cameras: Camera[] } | {
  state: 'checking' | 'unchecked' | 'blocked' | 'missing' | 'unavailable';
};

function deviceIdIsValid(value: unknown): value is string {
  // Device IDs are opaque, origin-scoped strings.
  return typeof value === 'string' && value.length > 0 && [...value].length <= 128 &&
    !/[\u0000\uD800-\uDFFF]/u.test(value);
}

export function parsePreferences(value: unknown): Preferences {
  if (!value || typeof value !== 'object') throw new Error('Invalid preferences');
  const fields = value as Record<string, unknown>;
  const { cameraDeviceId, warningAudio, warningVisibility } = fields;
  if (Object.keys(fields).length !== 3 || !(cameraDeviceId === null || deviceIdIsValid(cameraDeviceId)) ||
      typeof warningAudio !== 'boolean' || (warningVisibility !== 'default' && warningVisibility !== 'enhanced')) {
    throw new Error('Invalid preferences');
  }
  return { cameraDeviceId, warningAudio, warningVisibility };
}

function samePreferences(first: Preferences, second: Preferences) {
  return first.cameraDeviceId === second.cameraDeviceId && first.warningAudio === second.warningAudio &&
    first.warningVisibility === second.warningVisibility;
}

async function inspectCameras(signal: AbortSignal, probe = false, selected?: Camera): Promise<CameraCheck> {
  const media = navigator.mediaDevices;
  if (!media?.enumerateDevices || !media.getUserMedia) return { state: 'unavailable' };
  try {
    let permissionGranted = probe;
    let failedDevice: string | undefined;
    if (probe) {
      try {
        const stream = await media.getUserMedia({
          audio: false,
          video: selected ? { deviceId: { exact: selected.deviceId } } : { facingMode: { ideal: 'user' } },
        });
        for (const track of stream.getTracks()) track.stop();
      } catch (error) {
        // A saved input can vanish between enumeration and opening it. Relist alternatives.
        if (!selected || !(error instanceof DOMException) ||
            !['NotFoundError', 'OverconstrainedError', 'NotReadableError'].includes(error.name)) throw error;
        failedDevice = selected.deviceId;
      }
    } else {
      const permission = await navigator.permissions?.query({ name: 'camera' }).catch(() => null);
      if (permission?.state === 'denied') return { state: 'blocked' };
      permissionGranted = permission?.state === 'granted';
    }
    signal.throwIfAborted();
    const devices = (await media.enumerateDevices()).filter((device) => device.kind === 'videoinput');
    // MediaDevices has no built-in flag. Keep unlabeled and unrecognized inputs out of the picker.
    const cameras = devices.filter((device) => device.deviceId !== failedDevice && deviceIdIsValid(device.deviceId) &&
      /\b(integrated|built[- ]in|internal)\b/i.test(device.label) &&
      !/\b(external|virtual|rear|infrared|ir)\b/i.test(device.label));
    if (cameras.length) return { state: 'listed', cameras };
    if (permissionGranted || devices.some((device) => device.label)) return { state: 'missing' };
    return { state: 'unchecked' };
  } catch (error) {
    if (error instanceof DOMException) {
      if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return { state: 'blocked' };
      if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') return { state: 'missing' };
    }
    return { state: 'unavailable' };
  }
}

function WarningExample({ visibility }: { visibility: Preferences['warningVisibility'] }) {
  return <div className="warning-example" data-visibility={visibility}>
    <span className="warning-example-cue" aria-hidden="true">!</span>
    <div><strong>Example warning</strong><p>Eyes closed for 2 seconds</p></div>
  </div>;
}

function PreferencesRead({ request, resume = 0, children }: {
  request: RequestPreferences;
  resume?: number;
  children: (preferences: Preferences) => React.ReactNode;
}) {
  const [load, setLoad] = useState<{ preferences: Preferences } | 'loading' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);
  const content = useRef<HTMLDivElement>(null);
  const read = useEffectEvent((signal: AbortSignal) => typeof load === 'object' ? null : request(signal));

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void read(signal)?.then(
      (preferences) => { if (!signal.aborted) setLoad({ preferences }); },
      () => { if (!signal.aborted) setLoad('failed'); },
    );
    return () => controller.abort();
  }, [attempt, resume]);

  return <div ref={content} tabIndex={-1}>
    {load === 'loading' ? <p role="status">Loading monitoring preferences…</p>
      : load === 'failed' ? <div className="profile-actions">
        <p role="alert">Couldn’t load monitoring preferences.</p>
        <button className="entry-action entry-secondary" type="button" onClick={() => {
          content.current?.focus();
          setLoad('loading');
          setAttempt((previous) => previous + 1);
        }}>Retry</button>
      </div>
      : children(load.preferences)}
  </div>;
}

type PreferencesEditor = {
  request: RequestPreferences;
  draft?: Preferences;
  changeDraft: (draft?: Preferences) => void;
};

export function MonitoringSettings({ resume, ...editor }: PreferencesEditor & { resume: number }) {
  return <PreferencesRead request={editor.request} resume={resume}>
    {(preferences) => <PreferencesForm initial={preferences} {...editor} />}
  </PreferencesRead>;
}

function useCameraCheck() {
  const [check, setCheck] = useState<CameraCheck>({ state: 'checking' });
  const [rechecking, setRechecking] = useState(false);
  const pending = useRef<AbortController | null>(null);

  function refresh(probe: boolean, selected?: Camera) {
    if (pending.current && !pending.current.signal.aborted) return false;
    const controller = new AbortController();
    pending.current = controller;
    void inspectCameras(controller.signal, probe, selected).then((result) => {
      if (controller.signal.aborted) return;
      pending.current = null;
      setCheck(result);
      if (probe) setRechecking(false);
    });
    return true;
  }

  useEffect(() => {
    const media = navigator.mediaDevices;
    const list = () => refresh(false);
    list();
    media?.addEventListener('devicechange', list);
    return () => {
      media?.removeEventListener('devicechange', list);
      pending.current?.abort();
    };
  }, []);

  function recheck(selected?: Camera) {
    if (refresh(true, selected)) setRechecking(true);
  }

  return { check, recheck, rechecking };
}

function cameraStatus(check: CameraCheck, savedMissing: boolean, draftMissing: boolean) {
  switch (check.state) {
    case 'checking': return 'Checking camera access…';
    case 'unchecked': return 'Check camera access while stationary. RAFIQ requests camera video only.';
    case 'blocked': return 'Camera permission is blocked. Allow camera access in Chrome site permissions and Windows camera settings, then recheck.';
    case 'missing': return savedMissing
      ? 'Saved camera is unavailable. Enable your built-in camera, then recheck. You can also use automatic selection.'
      : 'No supported built-in camera was found. Enable your built-in camera, then recheck.';
    case 'unavailable': return 'Camera access is unavailable. Close other apps using the built-in camera and recheck in Chrome.';
    case 'listed':
      if (draftMissing) return 'Selected camera is unavailable. Choose an available built-in camera or recheck.';
      if (savedMissing) return 'Saved camera is unavailable. Choose an available built-in camera or recheck.';
      return 'Built-in camera found. Complete camera readiness when starting a session.';
  }
}

function PreferencesForm({ initial, request, draft: pendingDraft, changeDraft }: PreferencesEditor & { initial: Preferences }) {
  const [confirmed, setConfirmed] = useState(initial);
  const draft = pendingDraft ?? confirmed;
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [fieldError, setFieldError] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const cameraInput = useRef<HTMLSelectElement>(null);
  const { check, recheck, rechecking } = useCameraCheck();
  const cameras = check.state === 'listed' ? check.cameras : [];
  const selected = cameras.find((camera) => camera.deviceId === draft.cameraDeviceId);
  const savedMissing = confirmed.cameraDeviceId !== null &&
    !cameras.some((camera) => camera.deviceId === confirmed.cameraDeviceId);
  const draftMissing = draft.cameraDeviceId !== null && !selected && draft.cameraDeviceId !== confirmed.cameraDeviceId;
  const dirty = !samePreferences(confirmed, draft);
  const saving = saveState === 'saving';

  useEffect(() => () => pending.current?.abort(), []);

  function change(patch: Partial<Preferences>) {
    if (pending.current) return;
    const next = { ...draft, ...patch };
    changeDraft(samePreferences(confirmed, next) ? undefined : next);
    setSaveState('idle');
    setFieldError(false);
  }

  async function save(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (pending.current || !dirty || rechecking) return;
    if (draftMissing) {
      setFieldError(true);
      cameraInput.current?.focus();
      return;
    }

    const controller = new AbortController();
    pending.current = controller;
    setSaveState('saving');
    try {
      const result = await request(controller.signal, draft);
      if (!samePreferences(result, draft)) throw new Error('Unconfirmed preferences');
      if (controller.signal.aborted) return;
      setConfirmed(result);
      changeDraft();
      setFieldError(false);
      setSaveState('saved');
    } catch {
      if (!controller.signal.aborted) setSaveState('failed');
    } finally {
      pending.current = null;
    }
  }

  return <form className="monitoring-form" onSubmit={save}>
    <p>Set up your monitoring preferences while stationary.</p>
    <section className="monitoring-section" aria-labelledby="camera-settings">
      <h2 id="camera-settings">Camera</h2>
      <label htmlFor="monitoring-camera">Built-in camera</label>
      <select id="monitoring-camera" ref={cameraInput} value={draft.cameraDeviceId ?? ''} disabled={saving}
        aria-describedby="camera-help camera-state" aria-invalid={fieldError && draftMissing || undefined}
        onChange={(event) => change({ cameraDeviceId: event.target.value || null })}>
        <option value="">Automatic selection</option>
        {draft.cameraDeviceId !== null && !selected &&
          <option value={draft.cameraDeviceId}>
            {draft.cameraDeviceId === confirmed.cameraDeviceId ? 'Saved camera' : 'Selected camera'}
          </option>}
        {cameras.map((camera) => <option key={camera.deviceId} value={camera.deviceId}>{camera.label}</option>)}
      </select>
      <p id="camera-help">This choice applies to later sessions. Camera preview and readiness are in Start session.</p>
      <p id="camera-state" role="status">{rechecking ? 'Checking camera access…' : cameraStatus(check, savedMissing, draftMissing)}</p>
      <button className="entry-action entry-secondary" type="button"
        aria-disabled={check.state === 'checking' || rechecking || saving}
        onClick={() => { if (!pending.current) void recheck(selected); }}>Recheck</button>
    </section>
    <section className="monitoring-section" aria-labelledby="warning-settings">
      <h2 id="warning-settings">Warnings</h2>
      <label className="monitoring-choice">
        <input type="checkbox" role="switch" checked={draft.warningAudio} disabled={saving}
          onChange={(event) => change({ warningAudio: event.target.checked })} />
        <span>Warning audio <span className="monitoring-choice-state" aria-hidden="true">{draft.warningAudio ? 'On' : 'Off'}</span></span>
      </label>
      <fieldset className="monitoring-visibility" disabled={saving} aria-describedby="visibility-help">
        <legend>Warning visibility</legend>
        <label className="monitoring-choice">
          <input type="radio" name="warning-visibility" checked={draft.warningVisibility === 'default'}
            onChange={() => change({ warningVisibility: 'default' })} /> Default
        </label>
        <label className="monitoring-choice">
          <input type="radio" name="warning-visibility" checked={draft.warningVisibility === 'enhanced'}
            onChange={() => change({ warningVisibility: 'enhanced' })} /> Enhanced visibility
        </label>
      </fieldset>
      <p id="visibility-help">Enhanced visibility makes warning text and its symbol larger.</p>
      <WarningExample visibility={draft.warningVisibility} />
    </section>
    <div className="monitoring-section">
      <p id="save-preferences-help">Saved changes apply to later sessions.</p>
      <div className="profile-actions">
        <button className="entry-action profile-save" type="submit" ref={saveButton}
          aria-disabled={!dirty || saving || rechecking} aria-describedby="save-preferences-help">
          Save
        </button>
        <span className="profile-status" role="status">
          {saving ? 'Saving…' : saveState === 'saved' ? 'Saved. Changes apply to later sessions.' : dirty && 'Unsaved changes'}
        </span>
      </div>
      {saveState === 'failed' && <div className="profile-actions">
        <p role="alert">Couldn’t save monitoring preferences. Your changes are still here.</p>
        <button className="entry-link" type="button" onClick={() => {
          saveButton.current?.focus();
          void save();
        }}>Retry</button>
      </div>}
    </div>
  </form>;
}

export function ReadinessPreferences({ request }: { request: RequestPreferences }) {
  return <section aria-labelledby="readiness-preferences">
    <h2 id="readiness-preferences">Saved monitoring preferences</h2>
    <PreferencesRead request={request}>{(preferences) => <ReadinessPreferenceSummary preferences={preferences} />}</PreferencesRead>
    <Link href={privatePath('monitoring')} prefetch={false}>Change monitoring preferences</Link>
  </section>;
}

function ReadinessPreferenceSummary({ preferences }: { preferences: Preferences }) {
  const { check } = useCameraCheck();
  const camera = check.state === 'listed' && check.cameras.find((item) => item.deviceId === preferences.cameraDeviceId);
  return <>
    <p>{preferences.cameraDeviceId === null ? 'Built-in camera selected automatically'
      : camera ? camera.label
      : check.state === 'listed' || check.state === 'missing' ? 'Saved camera is unavailable on this device'
      : 'Saved built-in camera preference'}</p>
    <p>Warning audio {preferences.warningAudio ? 'on' : 'off'} · {preferences.warningVisibility === 'enhanced' ? 'Enhanced visibility' : 'Default visibility'}</p>
    <WarningExample visibility={preferences.warningVisibility} />
  </>;
}
