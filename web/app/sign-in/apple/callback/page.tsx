import { SocialCallbackPage, type SocialCallbackProps } from '../../../account-entry/social-callback-page';

export const metadata = { title: 'Continue with Apple | RAFIQ', referrer: 'no-referrer' };

export default function AppleCallbackPage(props: SocialCallbackProps) {
  return <SocialCallbackPage {...props} provider="apple" />;
}
