import { ClerkProvider } from '@clerk/nextjs';
import type { ReactNode } from 'react';
import './styles.css';

export const metadata = { title: 'RAFIQ Local Fixture' };

export default function RootLayout({ children }: { children: ReactNode }) {
  const hosted = process.env.NEXT_PUBLIC_RAFIQ_HOSTED_VALIDATION === 'true';
  return <html lang="en"><body>{hosted ? <ClerkProvider>{children}</ClerkProvider> : children}</body></html>;
}
