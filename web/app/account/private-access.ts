export type PrivateAccessChange =
  | { type: 'identityChanged' | 'signedOut' | 'authorityExpired'; sessionId: string }
  | { type: 'restricted'; userId: string; sessionId: string; supportContact?: string };

const channelName = 'rafiq-private-access';
const signingOutPrefix = channelName + ':sign-out:';
let receiver: BroadcastChannel | undefined;
let listeners = 0;

export function hasPendingSignOut(sessionId: string) {
  return localStorage.getItem(signingOutPrefix + sessionId) !== null;
}

export function setPendingSignOut(sessionId: string, pending: boolean) {
  const key = signingOutPrefix + sessionId;
  if (pending) localStorage.setItem(key, '1');
  else localStorage.removeItem(key);
}

export function notifyPrivateAccess(change: PrivateAccessChange) {
  const channel = receiver ?? new BroadcastChannel(channelName);
  channel.postMessage(change);
  if (!receiver) channel.close();
}

export function listenForPrivateAccess(listener: (change: PrivateAccessChange) => void) {
  const channel = receiver ??= new BroadcastChannel(channelName);
  listeners++;
  const receive = (event: MessageEvent<PrivateAccessChange>) => listener(event.data);
  channel.addEventListener('message', receive);
  function storageChanged(event: StorageEvent) {
    if (event.key?.startsWith(signingOutPrefix) && event.newValue === '1') {
      listener({ type: 'signedOut', sessionId: event.key.slice(signingOutPrefix.length) });
    }
  }
  window.addEventListener('storage', storageChanged);
  return () => {
    window.removeEventListener('storage', storageChanged);
    channel.removeEventListener('message', receive);
    if (--listeners === 0) {
      channel.close();
      receiver = undefined;
    }
  };
}
