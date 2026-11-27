export type PrivateAccessChange =
  | { type: 'identityChanged' | 'signedOut' | 'authorityExpired'; sessionId: string }
  | { type: 'restricted'; userId: string; sessionId: string; supportContact?: string };

const channelName = 'rafiq-private-access';

export function notifyPrivateAccess(change: PrivateAccessChange) {
  const channel = new BroadcastChannel(channelName);
  channel.postMessage(change);
  channel.close();
}

export function listenForPrivateAccess(listener: (change: PrivateAccessChange) => void) {
  const channel = new BroadcastChannel(channelName);
  channel.onmessage = (event: MessageEvent<PrivateAccessChange>) => listener(event.data);
  return () => channel.close();
}
