'use client';

import Image from 'next/image';
import { useRef, useState } from 'react';
import { Miibot } from './miibot';

const events = [
  { name: 'Warning', time: '00:08', title: 'Drowsiness observed', description: 'Eyes closed for 2 seconds.' },
  { name: 'Pause', time: '00:16', title: 'Monitoring paused', description: 'The camera view became obstructed.' },
] as const;

const trends = [
  { name: 'Session 1', count: 0, description: 'Session 1 recorded no eye-closure warnings.' },
  { name: 'Session 2', count: 2, description: 'Session 2 recorded two eye-closure warnings.' },
  { name: 'This session', count: 1, description: 'This session recorded one eye-closure warning at 00:08.' },
] as const;

function ReportFindings() {
  return (
    <>
      <p>Select a finding to inspect its source.</p>
      <details>
        <summary>One warning and one monitoring pause</summary>
        <p>Parked session, 00:08 — sustained eye closure for 2 s. At 00:16 an obstructed camera view paused monitoring.</p>
      </details>
      <details>
        <summary>Two of three sessions included a warning</summary>
        <p>Eye-closure warning counts were 0 in session 1, 2 in session 2, and 1 in the parked session.</p>
      </details>
      <p>These illustrative counts describe the sample sessions. They do not establish driving risk.</p>
    </>
  );
}

export function SampleEvidence() {
  const [event, setEvent] = useState<(typeof events)[number]>(events[0]);
  const [trend, setTrend] = useState<(typeof trends)[number]>(trends[2]);
  const report = useRef<HTMLDialogElement>(null);
  const reportTrigger = useRef<HTMLButtonElement>(null);
  const chapters = useRef<HTMLDivElement>(null);

  return (
    <section className="landing-agent" id="agent" aria-labelledby="agent-title">
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
                <div className="landing-timeline" role="group" aria-label="Sample session timeline">
                  <span>Start</span>
                  {events.map((item) => (
                    <button key={item.name} type="button" aria-pressed={event === item} onClick={() => setEvent(item)}>
                      {item.name}
                    </button>
                  ))}
                  <span>End</span>
                </div>
                <div role="status" aria-atomic="true">
                  <p className="landing-kicker">{event.time} · {event.name}</p>
                  <h4>{event.title}</h4>
                  <p>{event.description}</p>
                </div>
                {event.name === 'Pause' && (
                  <Image className="landing-pause-view" src="/landing/camera-obstructed.webp"
                    alt="The staged camera view is obscured" width={1000} height={424} unoptimized />
                )}
              </div>
            </article>

            <article className="landing-chapter" id="sample-trends" tabIndex={-1}>
              <div>
                <p className="landing-label">Personal trends</p>
                <h3>Has this happened before?</h3>
              </div>
              <div className="landing-evidence">
                <p className="landing-kicker" id="landing-trend-label">Eye-closure warnings by session</p>
                <div className="landing-trend" role="group" aria-labelledby="landing-trend-label">
                  {trends.map((item) => (
                    <button key={item.name} type="button" aria-pressed={trend === item} onClick={() => setTrend(item)}>
                      <span>{item.name}</span>
                      <span className="landing-bar" aria-hidden="true"><span style={{ width: `${item.count * 50}%` }} /></span>
                      <b>{item.count}</b>
                    </button>
                  ))}
                </div>
                <h4>Two of three sessions.</h4>
                <p role="status">{trend.description}</p>
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
                <p>Eye closure lasted 2 seconds. Later, an obstructed view paused monitoring.</p>
                <button className="landing-button landing-report-open" type="button" ref={reportTrigger}
                  onClick={() => report.current?.showModal()}>
                  Open sample report <span aria-hidden="true">↗</span>
                </button>
                <noscript>
                  <style>{'.landing-report-open { display: none !important; }'}</style>
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
