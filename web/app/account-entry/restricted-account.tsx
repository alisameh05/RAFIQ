export function RestrictedAccountMessage({ supportContact }: { supportContact?: string }) {
  return <>
    <p>New sessions and hosted synchronization are blocked.</p>
    {supportContact && <p>Contact <a href={'mailto:' + supportContact}>{supportContact}</a> for RAFIQ support.</p>}
    <p>Sign in again after your access is restored.</p>
  </>;
}
