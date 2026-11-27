import Image from 'next/image';
import Link from 'next/link';
import { SampleEvidence } from './sample-evidence';
import './landing.css';

function EntryActions({ open, ending = false }: { open: boolean; ending?: boolean }) {
  return (
    <div className="landing-entry">
      {!open && <p className="landing-pending">Public signup is pending release.</p>}
      <div className="landing-actions">
        {open && (
          <Link className="landing-button landing-primary" href="/sign-up">
            {ending ? 'Join RAFIQ' : 'Create account'} <span aria-hidden="true">→</span>
          </Link>
        )}
        <Link className="landing-button" href="/sign-in">Sign in</Link>
      </div>
    </div>
  );
}

export function Landing({ signupOpen }: { signupOpen: boolean }) {
  return (
    <div className="landing" id="top">
      <a className="landing-skip" href="#sample">Skip to sample session</a>
      <header className="landing-shell">
        <div className="landing-nav">
          <Image src="/landing/rafiq-static.svg" alt="RAFIQ" width={472} height={132} unoptimized />
          <nav aria-label="Landing">
            <a href="#sample">How it works</a>
            <a href="#agent">RAFIQ Agent</a>
          </nav>
        </div>
        <div className="landing-hero">
          <div className="landing-intro">
            <h1>See what<br />{' '}RAFIQ sees.</h1>
            <p className="landing-lede">On-device driver monitoring.<br />A private record of what happened.</p>
            <p id="landing-eligibility">
              For adults 18 and older using a supported desktop browser with a built-in camera.
              Set up and operate driver controls while stationary. Vehicle motion requires an approved supervised procedure.
            </p>
            <EntryActions open={signupOpen} />
            <a className="landing-button" href="#sample">See how RAFIQ works <span aria-hidden="true">↓</span></a>
          </div>
          <div className="landing-lens">
            <Image src="/landing/hero-lens.webp" alt="" width={595} height={530} preload unoptimized />
          </div>
        </div>
      </header>

      <main className="landing-main">
        <section className="landing-shell landing-sample" id="sample" aria-labelledby="sample-title" tabIndex={-1}>
          <p className="landing-label">Sample session · Synthetic data</p>
          <h2 id="sample-title">Parked vehicle</h2>
          <figure className="landing-scene">
            <Image src="/landing/generated.png" alt="Staged driver with eyes closed in a parked vehicle"
              width={1584} height={672} unoptimized />
            <figcaption>
              <span className="landing-symbol" aria-hidden="true">!</span>
              <span><strong>Drowsiness observed</strong><br />Sustained eye closure · 2 s</span>
            </figcaption>
          </figure>
          <ul className="landing-facts">
            <li><span className="landing-symbol" aria-hidden="true">!</span><div><h3>Warning</h3><p>Eyes closed for 2 seconds at 00:08.</p></div></li>
            <li><span className="landing-symbol" aria-hidden="true">Ⅱ</span><div><h3>Monitoring paused</h3><p>The camera view became obstructed at 00:16.</p></div></li>
            <li><span className="landing-symbol" aria-hidden="true">≡</span><div><h3>Private review</h3><a href="#session-review">Inspect the sample timeline</a></div></li>
          </ul>
        </section>

        <SampleEvidence />

        <section className="landing-shell landing-ending" aria-labelledby="launch-title">
          <h2 id="launch-title">Your drive.<br />Your story.</h2>
          <p>Review the moments that mattered, privately.</p>
          <EntryActions open={signupOpen} ending />
        </section>
      </main>

      <footer className="landing-shell landing-footer">
        <p>Artwork adapted from <a href="https://sketchfab.com/3d-models/miibot-3d-model-7606b66321934033a5dcfecf0f7925e5">Miibot by itsmejhade</a>
          {' · '}<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>{' · RAFIQ materials and mark'}</p>
        <a href="#top">Back to the lens <span aria-hidden="true">↑</span></a>
      </footer>
    </div>
  );
}
