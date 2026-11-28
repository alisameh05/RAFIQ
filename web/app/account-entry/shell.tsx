import { ClerkProvider } from '@clerk/nextjs';
import Link from 'next/link';
import Image from 'next/image';
import type { ReactNode } from 'react';
import './entry.css';

export function EntryShell({ children, artwork = false }: { children: ReactNode; artwork?: boolean }) {
  return (
    <div className="entry">
      <header className="entry-header">
        <Link className="entry-wordmark" href="/" aria-label="RAFIQ home">RAFIQ</Link>
      </header>
      <main className={artwork ? 'entry-main entry-split' : 'entry-main'}>
        {artwork && (
          <div className="entry-artwork" aria-hidden="true">
            <Image src="/account-entry/signup-lens.webp" width={880} height={941} alt="" sizes="(min-width: 801px) 45vw, 0px" />
          </div>
        )}
        <div className="entry-content">{children}</div>
      </main>
    </div>
  );
}


export function EntryIdentity({ children, redirectOrigin }: { children: ReactNode; redirectOrigin?: string }) {
  return <ClerkProvider signInUrl="/sign-in" signInFallbackRedirectUrl="/account"
    allowedRedirectOrigins={redirectOrigin ? [redirectOrigin] : undefined}>{children}</ClerkProvider>;
}
