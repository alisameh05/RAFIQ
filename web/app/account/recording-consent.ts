export type ClipPreferences = { behaviors: string[]; preSeconds: number; postSeconds: number };
export type RecordingSettings = ClipPreferences & { enabled: boolean };
export type RecordingCatalog = { version: string; behaviors: Record<string, string> };
export type RecordingConsent = { revision: string; settings: RecordingSettings; catalog: RecordingCatalog };
export type RecordingChange = { expectedRevision: string; settings: RecordingSettings };
export type RequestRecordingConsent = (signal: AbortSignal, change?: RecordingChange) => Promise<RecordingConsent>;

export class RecordingRevisionConflict extends Error {}

export const defaultClipPreferences: ClipPreferences = { behaviors: [], preSeconds: 3, postSeconds: 3 };

export function parseRecordingConsent(value: unknown): RecordingConsent {
  if (!value || typeof value !== 'object') throw new Error('Invalid recording consent');
  const { revision, settings, catalog } = value as Record<string, unknown>;
  if (typeof revision !== 'string' || !revision || revision.length > 64 || !settings || typeof settings !== 'object') {
    throw new Error('Invalid recording consent');
  }
  if (!catalog || typeof catalog !== 'object') throw new Error('Invalid recording catalog');
  const { version, behaviors: labels } = catalog as Record<string, unknown>;
  const isBehavior = (code: unknown): code is string =>
    typeof code === 'string' && /^[a-z][a-zA-Z0-9]{0,39}$/.test(code);
  if (typeof version !== 'string' || !version || version.length > 64 || !labels ||
      typeof labels !== 'object' || Array.isArray(labels) || Object.keys(labels).length > 30 ||
      !Object.entries(labels).every(([code, label]) => isBehavior(code) && typeof label === 'string' && label.length > 0)) {
    throw new Error('Invalid recording catalog');
  }
  const { enabled, behaviors, preSeconds = 3, postSeconds = 3 } = settings as Record<string, unknown>;
  const isSeconds = (seconds: unknown): seconds is number =>
    typeof seconds === 'number' && Number.isInteger(seconds) && seconds >= 0 && seconds <= 5;
  if (typeof enabled !== 'boolean' || !Array.isArray(behaviors) || new Set(behaviors).size !== behaviors.length ||
      behaviors.length > 30 || !behaviors.every(isBehavior) ||
      !isSeconds(preSeconds) || !isSeconds(postSeconds)) throw new Error('Invalid recording settings');
  return {
    revision, settings: { enabled, behaviors, preSeconds, postSeconds },
    catalog: { version, behaviors: labels as RecordingCatalog['behaviors'] },
  };
}

export function sameClipPreferences(a: ClipPreferences, b: ClipPreferences) {
  return a.preSeconds === b.preSeconds && a.postSeconds === b.postSeconds &&
    a.behaviors.length === b.behaviors.length && a.behaviors.every((key) => b.behaviors.includes(key));
}

const withdrawalEvent = 'rafiq:recording-withdrawal';
const withdrawalPrefix = (accountId: string) => 'rafiq:pending-recording-withdrawal:' + accountId + ':';
const inMemoryWithdrawals = new Map<string, string>();

function storedWithdrawalKeys(accountId: string) {
  const prefix = withdrawalPrefix(accountId);
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

export function pendingRecordingWithdrawal(accountId: string) {
  if (inMemoryWithdrawals.has(accountId)) return true;
  try {
    return storedWithdrawalKeys(accountId).length > 0;
  } catch {
    return false;
  }
}

export function subscribeToRecordingWithdrawal(accountId: string, listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(withdrawalPrefix(accountId))) listener();
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
  const marker = crypto.randomUUID();
  try {
    // Use distinct keys so an acknowledgment from another tab cannot remove this stop.
    const previous = storedWithdrawalKeys(accountId);
    localStorage.setItem(withdrawalPrefix(accountId) + marker, 'pending');
    inMemoryWithdrawals.delete(accountId);
    for (const key of previous) localStorage.removeItem(key);
  } catch {
    inMemoryWithdrawals.set(accountId, marker);
  }
  window.dispatchEvent(new CustomEvent(withdrawalEvent, { detail: accountId }));
  return marker;
}

export function acknowledgeRecordingWithdrawal(accountId: string, marker: string) {
  const memory = inMemoryWithdrawals.get(accountId) === marker;
  if (memory) inMemoryWithdrawals.delete(accountId);
  try {
    const key = withdrawalPrefix(accountId) + marker;
    if (!memory && localStorage.getItem(key) === null) return false;
    localStorage.removeItem(key);
  } catch {
    if (!memory) return false;
  }
  window.dispatchEvent(new CustomEvent(withdrawalEvent, { detail: accountId }));
  return true;
}

/** Session scope comes from the current authorized account. Unknown intent fails closed. */
export function recordingSnapshotForSession(accountId: string, consent: RecordingConsent | undefined) {
  if (!consent?.settings.enabled || pendingRecordingWithdrawal(accountId)) return undefined;
  return {
    ...consent, settings: {
      ...consent.settings, behaviors: consent.settings.behaviors.filter((key) => Object.hasOwn(consent.catalog.behaviors, key)),
    },
  };
}
