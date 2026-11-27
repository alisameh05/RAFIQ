import { ClerkProvider } from '@clerk/nextjs';
import type { ReactNode } from 'react';
import './styles.css';
import { accountEntryEnabled } from './account-entry/config';

export const metadata = { title: 'RAFIQ' };

export default function RootLayout({ children }: { children: ReactNode }) {
  const hosted = process.env.NEXT_PUBLIC_RAFIQ_HOSTED_VALIDATION === 'true';
  const content = hosted && !accountEntryEnabled() ? <ClerkProvider>{children}</ClerkProvider> : children;
  return <html lang="en"><body>{content}</body></html>;
}
