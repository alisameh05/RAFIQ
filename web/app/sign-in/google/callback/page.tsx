import { SocialCallbackPage, type SocialCallbackProps } from '../../../account-entry/social-callback-page';

export const metadata = { title: 'Continue with Google | RAFIQ', referrer: 'no-referrer' };

export default function GoogleCallbackPage(props: SocialCallbackProps) {
  return <SocialCallbackPage {...props} provider="google" />;
}
