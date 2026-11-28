export const recordingBehaviors = {
  drowsiness: 'Drowsiness',
  distraction: 'Distraction',
  phoneUse: 'Phone use',
  eating: 'Eating',
  drinking: 'Drinking',
} as const;

export type RecordingBehavior = keyof typeof recordingBehaviors;
export type ClipPreferences = { behaviors: RecordingBehavior[]; preSeconds: number; postSeconds: number };
export type RecordingSettings = ClipPreferences & { enabled: boolean };
export type RecordingConsent = { revision: string; settings: RecordingSettings };
export type RecordingChange = { expectedRevision: string; settings: RecordingSettings };
export type RequestRecordingConsent = (signal: AbortSignal, change?: RecordingChange) => Promise<RecordingConsent>;

export class RecordingRevisionConflict extends Error {}

export const defaultClipPreferences: ClipPreferences = { behaviors: [], preSeconds: 3, postSeconds: 3 };

export function parseRecordingConsent(value: unknown): RecordingConsent {
  if (!value || typeof value !== 'object') throw new Error('Invalid recording consent');
  const { revision, settings } = value as { revision: unknown; settings: unknown };
  if (typeof revision !== 'string' || !revision || revision.length > 64 || !settings || typeof settings !== 'object') {
    throw new Error('Invalid recording consent');
  }
  const { enabled, behaviors, preSeconds = 3, postSeconds = 3 } = settings as Record<string, unknown>;
  const isSeconds = (seconds: unknown): seconds is number =>
    typeof seconds === 'number' && Number.isInteger(seconds) && seconds >= 0 && seconds <= 5;
  if (typeof enabled !== 'boolean' || !Array.isArray(behaviors) || new Set(behaviors).size !== behaviors.length ||
      !behaviors.every((key) => typeof key === 'string' && Object.hasOwn(recordingBehaviors, key)) ||
      !isSeconds(preSeconds) || !isSeconds(postSeconds)) throw new Error('Invalid recording settings');
  return { revision, settings: { enabled, behaviors: behaviors as RecordingBehavior[], preSeconds, postSeconds } };
}

export function sameClipPreferences(a: ClipPreferences, b: ClipPreferences) {
  return a.preSeconds === b.preSeconds && a.postSeconds === b.postSeconds &&
    a.behaviors.length === b.behaviors.length && a.behaviors.every((key) => b.behaviors.includes(key));
}

const withdrawalEvent = 'rafiq:recording-withdrawal';
const withdrawalKey = (accountId: string) => 'rafiq:pending-recording-withdrawal:' + accountId;
const inMemoryWithdrawals = new Map<string, string>();

export function pendingRecordingWithdrawal(accountId: string): string | null {
  try {
    return localStorage.getItem(withdrawalKey(accountId)) ?? inMemoryWithdrawals.get(accountId) ?? null;
  } catch {
    return inMemoryWithdrawals.get(accountId) ?? null;
  }
}

export function subscribeToRecordingWithdrawal(accountId: string, listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === withdrawalKey(accountId) || event.key === null) listener();
  };
  const local = (event: Event) => {
    if ((event as CustomEvent<string>).detail === accountId) listener();
  };
  window.addEventListener('storage', storage);
  window.addEventListener(withdrawalEvent, local);
  return () => {
    window.removeEventListener('storage', storage);
    window.removeEventListener(withdrawalEvent, local);
  };
}

export function beginRecordingWithdrawal(accountId: string) {
  const marker = pendingRecordingWithdrawal(accountId) ?? crypto.randomUUID();
  try {
    localStorage.setItem(withdrawalKey(accountId), marker);
  } catch {
    inMemoryWithdrawals.set(accountId, marker);
  }
  window.dispatchEvent(new CustomEvent(withdrawalEvent, { detail: accountId }));
  return marker;
}

export function acknowledgeRecordingWithdrawal(accountId: string, marker: string) {
  if (pendingRecordingWithdrawal(accountId) !== marker) return;
  try {
    localStorage.removeItem(withdrawalKey(accountId));
  } catch {
    // The in-memory stop still covers this page when browser storage is unavailable.
  }
  inMemoryWithdrawals.delete(accountId);
  window.dispatchEvent(new CustomEvent(withdrawalEvent, { detail: accountId }));
}

/** Session scope comes from the current authorized account. Unknown intent fails closed. */
export function recordingSnapshotForSession(accountId: string, consent: RecordingConsent | undefined) {
  return consent?.settings.enabled && !pendingRecordingWithdrawal(accountId) ? consent : undefined;
}
