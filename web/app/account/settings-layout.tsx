import Link from 'next/link';
import type { ReactNode, Ref } from 'react';
import { privatePath, privateTitles } from '../account-entry/return';
import './settings.css';

type Section = 'profile' | 'privacy' | 'sessions';

export function DriverNavigation({ current }: { current: 'dashboard' | 'sessions' | 'settings' }) {
  return <nav className="driver-navigation" aria-label="Driver workspace">
    <Link href={privatePath('dashboard')} prefetch={false}
      aria-current={current === 'dashboard' ? 'page' : undefined}>Dashboard</Link>
    <Link href={privatePath('sessions')} prefetch={false}
      aria-current={current === 'sessions' ? 'page' : undefined}>Sessions</Link>
    <Link href={privatePath('profile')} prefetch={false}
      aria-current={current === 'settings' ? 'true' : undefined}>Settings</Link>
  </nav>;
}

function SettingsLinks({ current }: { current: 'profile' | 'privacy' }) {
  return <nav aria-label="Settings">
    <Link href={privatePath('profile')} prefetch={false}
      aria-current={current === 'profile' ? 'page' : undefined}>Profile</Link>
    <Link href={privatePath('privacy')} prefetch={false}
      aria-current={current === 'privacy' ? 'page' : undefined}>Privacy</Link>
  </nav>;
}

export function SettingsLayout({ current, heading, children }: {
  current: Section;
  heading: Ref<HTMLHeadingElement>;
  children: ReactNode;
}) {
  return <>
    <a className="driver-skip" href="#driver-content">Skip to content</a>
    <DriverNavigation current={current === 'sessions' ? 'sessions' : 'settings'} />
    <div className="driver-layout">
      {current !== 'sessions' && <>
        <div className="settings-navigation"><SettingsLinks current={current} /></div>
        <details className="settings-selector">
          <summary>Settings · {privateTitles[current]}</summary>
          <SettingsLinks current={current} />
        </details>
      </>}
      <div className="settings-content">
        <h1 id="driver-content" ref={heading} tabIndex={-1}>{privateTitles[current]}</h1>
        {children}
      </div>
    </div>
  </>;
}
