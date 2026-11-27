'use client';

import Image from 'next/image';
import { useRef, useState } from 'react';
import { Miibot } from './miibot';
import { sampleEvents, sampleTrends } from './sample-data';

const [warning, pause] = sampleEvents;
const [first, second, current] = sampleTrends;

function eventDescription(event: (typeof sampleEvents)[number]) {
  return event.name === 'Warning' ? `Eyes closed for ${event.durationSeconds} seconds.` : event.reason + '.';
}

function ReportFindings() {
  return (
    <>
      <p>Select a finding to inspect its source.</p>
      <details>
        <summary>One warning and one monitoring pause</summary>
        <p>Parked session, {warning.time} — sustained eye closure for {warning.durationSeconds} s.
          At {pause.time} an obstructed camera view paused monitoring.</p>
      </details>
      <details>
        <summary>Two of three sessions included a warning</summary>
        <p>Eye-closure warning counts were {first.count} in session 1, {second.count} in session 2, and {current.count} in the parked session.</p>
      </details>
      <p>These illustrative counts describe the sample sessions. They do not establish driving risk.</p>
    </>
  );
}

export function SampleEvidence() {
  const [event, setEvent] = useState<(typeof sampleEvents)[number]>(warning);
  const [trend, setTrend] = useState<(typeof sampleTrends)[number]>(current);
  const report = useRef<HTMLDialogElement>(null);
  const reportTrigger = useRef<HTMLButtonElement>(null);
  const chapters = useRef<HTMLDivElement>(null);

  return (
    <section className="landing-agent" id="agent" aria-labelledby="agent-title">
      <noscript><style>{'.landing-interactive { display: none !important; }'}</style></noscript>
      <div className="landing-shell">
        <div className="landing-agent-rail">
          <div><h2 id="agent-title">RAFIQ Agent</h2><p className="landing-label">Parked vehicle · Sample data</p></div>
          <nav aria-label="Sample evidence">
            <a href="#session-review">Session</a><a href="#sample-trends">Trends</a><a href="#sample-report">Report</a>
          </nav>
        </div>
        <div className="landing-agent-grid" ref={chapters}>
          <Miibot chapters={chapters} />
          <div className="landing-chapters">
            <article className="landing-chapter" id="session-review" tabIndex={-1} aria-labelledby="session-review-title">
              <div>
                <p className="landing-label">Session review</p>
                <h3 id="session-review-title">What happened in my session?</h3>
              </div>
              <div className="landing-evidence">
                <p className="landing-kicker">Parked session / Event timeline</p>
                <div className="landing-timeline landing-interactive" role="group" aria-label="Sample session timeline">
                  <span>Start</span>
                  {sampleEvents.map((item) => (
                    <button key={item.name} type="button" aria-pressed={event === item} onClick={() => setEvent(item)}>
                      {item.name}
                    </button>
                  ))}
                  <span>End</span>
                </div>
                <div className="landing-interactive" role="status" aria-atomic="true">
                  <p className="landing-kicker">{event.time} · {event.name}</p>
                  <h4>{event.title}</h4>
                  <p>{eventDescription(event)}</p>
                </div>
                {event.name === 'Pause' && (
                  <Image className="landing-pause-view" src="/landing/camera-obstructed.webp"
                    alt="The staged camera view is obscured" width={1000} height={424} unoptimized />
                )}
                <noscript>
                  <ul className="landing-static-events">
                    {sampleEvents.map((item) => (
                      <li key={item.name}><strong>{item.time} · {item.title}</strong><br />{eventDescription(item)}</li>
                    ))}
                  </ul>
                </noscript>
              </div>
            </article>

            <article className="landing-chapter" id="sample-trends" tabIndex={-1}>
              <div>
                <p className="landing-label">Personal trends</p>
                <h3>Has this happened before?</h3>
              </div>
              <div className="landing-evidence">
                <p className="landing-kicker" id="landing-trend-label">Eye-closure warnings by session</p>
                <div className="landing-trend landing-interactive" role="group" aria-labelledby="landing-trend-label">
                  {sampleTrends.map((item) => (
                    <button key={item.name} type="button" aria-pressed={trend === item} onClick={() => setTrend(item)}>
                      <span>{item.name}</span>
                      <span className="landing-bar" aria-hidden="true"><span style={{ width: `${item.count * 50}%` }} /></span>
                      <b>{item.count}</b>
                    </button>
                  ))}
                </div>
                <noscript>
                  <ul className="landing-static-events">
                    {sampleTrends.map((item) => <li key={item.name}>{item.name} · {item.count}</li>)}
                  </ul>
                </noscript>
                <h4>Two of three sessions.</h4>
                <p className="landing-interactive" role="status">
                  {trend.name} recorded {trend.count} eye-closure {trend.count === 1 ? 'warning' : 'warnings'}
                  {trend === current && ` at ${warning.time}`}.
                </p>
              </div>
            </article>

            <article className="landing-chapter" id="sample-report" tabIndex={-1}>
              <div>
                <p className="landing-label">Evidence-backed report</p>
                <h3>Can you put that in a report?</h3>
              </div>
              <div className="landing-evidence">
                <p className="landing-kicker">Private report / Sample excerpt</p>
                <h4>One warning. One pause.</h4>
                <p>Eye closure lasted {warning.durationSeconds} seconds. Later, an obstructed view paused monitoring.</p>
                <button className="landing-button landing-report-open landing-interactive" type="button" ref={reportTrigger}
                  onClick={() => report.current?.showModal()}>
                  Open sample report <span aria-hidden="true">↗</span>
                </button>
                <noscript>
                  <details className="landing-report-inline">
                    <summary>Open sample report</summary>
                    <h4>Parked session review</h4>
                    <ReportFindings />
                  </details>
                </noscript>
              </div>
            </article>
          </div>
        </div>
      </div>

      <dialog className="landing-report" ref={report} aria-labelledby="landing-report-title"
        onClose={() => reportTrigger.current?.focus()}>
        <form method="dialog"><button className="landing-button" type="submit">Close report</button></form>
        <p className="landing-label">RAFIQ Agent · Sample report</p>
        <h2 id="landing-report-title">Parked session review</h2>
        <ReportFindings />
      </dialog>
    </section>
  );
}
