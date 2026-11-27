'use client';

import { SignInButton, UserButton, useAuth } from '@clerk/nextjs';
import { useCallback, useEffect, useState } from 'react';

type Driver = 'driver-a' | 'driver-b';
type Fixture = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  result: { count: number; mean: number; method: string } | null;
};
const localApi = 'http://127.0.0.1:8000/api/v1/local-fixtures';

async function request(api: string, authorization: string, signal: AbortSignal, submit = false): Promise<Fixture | null> {
  const response = await fetch(submit ? api : `${api}/current`, {
    method: submit ? 'POST' : 'GET',
    headers: { Authorization: authorization },
    signal,
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('Fixture request failed');
  return response.json();
}

function FixturePanel({ api, getAuthorization }: { api: string; getAuthorization: () => Promise<string> }) {
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
        const authorization = await getAuthorization();
        if (controller.signal.aborted) return;
        const next = await request(api, authorization, controller.signal, submit);
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
  }, [api, getAuthorization, pendingRequest, requestNumber]);

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

function LocalFixture() {
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
      {driver && <LocalDriverFixture key={driver} driver={driver} />}
    </main>
  );
}

function LocalDriverFixture({ driver }: { driver: Driver }) {
  const getAuthorization = useCallback(async () => `Bearer local-${driver}`, [driver]);
  return <FixturePanel api={localApi} getAuthorization={getAuthorization} />;
}

function hostedApi(): string | null {
  try {
    const origin = process.env.NEXT_PUBLIC_RAFIQ_API_ORIGIN;
    if (!origin) return null;
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) return null;
    return `${origin}/api/v1/local-fixtures`;
  } catch {
    return null;
  }
}

function HostedFixture() {
  const { isLoaded, isSignedIn, userId, getToken } = useAuth();
  const getAuthorization = useCallback(async () => {
    const token = await getToken();
    if (!token) throw new Error('Sign-in required');
    return `Bearer ${token}`;
  }, [getToken]);
  const api = hostedApi();
  return (
    <main>
      <h1>RAFIQ validation fixture</h1>
      <p>Submit synthetic samples 2, 4 and 6 to the R worker.</p>
      {!api && <p role="alert">The validation API is not configured.</p>}
      {!isLoaded && <p role="status">Loading sign-in…</p>}
      {isLoaded && !isSignedIn && <SignInButton mode="modal"><button>Sign in</button></SignInButton>}
      {isLoaded && isSignedIn && api && <><UserButton /><FixturePanel key={userId} api={api} getAuthorization={getAuthorization} /></>}
    </main>
  );
}

export default function Home() {
  return process.env.NEXT_PUBLIC_RAFIQ_HOSTED_VALIDATION === 'true' ? <HostedFixture /> : <LocalFixture />;
}
