'use client';

import { useEffect, useState } from 'react';

type Driver = 'driver-a' | 'driver-b';
type Fixture = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  result: { count: number; mean: number; method: string } | null;
};
const api = 'http://127.0.0.1:8000/api/v1/local-fixtures';

async function request(driver: Driver, signal: AbortSignal, submit = false): Promise<Fixture | null> {
  const response = await fetch(submit ? api : `${api}/current`, {
    method: submit ? 'POST' : 'GET',
    headers: { Authorization: `Bearer local-${driver}` },
    signal,
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('Fixture request failed');
  return response.json();
}

function DriverFixture({ driver }: { driver: Driver }) {
  const [fixture, setFixture] = useState<Fixture | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [pendingRequest, setPendingRequest] = useState<'read' | 'submit'>('read');
  const [requestNumber, setRequestNumber] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load(submit = false) {
      try {
        const next = await request(driver, controller.signal, submit);
        if (controller.signal.aborted) return;
        setFixture(next);
        setLoading(false);
        if (next?.status === 'queued' || next?.status === 'running') {
          timer = setTimeout(() => void load(), 500);
        }
      } catch {
        if (controller.signal.aborted) return;
        setError(true);
        setLoading(false);
      }
    }

    void load(pendingRequest === 'submit');
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [driver, pendingRequest, requestNumber]);

  function run(action: 'read' | 'submit') {
    setError(false);
    setLoading(true);
    setPendingRequest(action);
    setRequestNumber((number) => number + 1);
  }

  return (
    <section aria-label="Fixture">
      <button disabled={loading} onClick={() => run('submit')}>Submit fixture</button>
      {error && <button className="secondary" onClick={() => run('read')}>Reload fixture</button>}
      <div role="status">
        {loading && <p>Loading fixture…</p>}
        {error && <p>Could not reach the fixture API.</p>}
        {!loading && !error && !fixture && <p>No fixture has been submitted.</p>}
        {fixture && (
          <dl>
            <dt>Committed fixture</dt>
            <dd data-testid="fixture-id">{fixture.id}</dd>
            <dt>Worker result</dt>
            <dd>{fixture.result
              ? `${fixture.result.count} samples · mean ${fixture.result.mean} · ${fixture.result.method}`
              : fixture.status === 'failed' ? 'Calculation failed' : 'Waiting for the worker…'}</dd>
          </dl>
        )}
      </div>
    </section>
  );
}

export default function Home() {
  const [driver, setDriver] = useState<Driver | null>(null);

  useEffect(() => {
    const stored = sessionStorage.getItem('rafiq-fixture-driver');
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Read the tab's identity after hydration.
    setDriver(stored === 'driver-b' ? stored : 'driver-a');
  }, []);

  return (
    <main>
      <h1>RAFIQ local fixture</h1>
      <p>Submit synthetic samples 2, 4 and 6 to the R worker.</p>
      <label htmlFor="driver">Synthetic identity</label>
      <select id="driver" value={driver ?? 'driver-a'} disabled={!driver} onChange={(event) => {
        const next = event.target.value === 'driver-b' ? 'driver-b' : 'driver-a';
        sessionStorage.setItem('rafiq-fixture-driver', next);
        setDriver(next);
      }}>
        <option value="driver-a">Driver A</option>
        <option value="driver-b">Driver B</option>
      </select>
      {driver && <DriverFixture key={driver} driver={driver} />}
    </main>
  );
}
