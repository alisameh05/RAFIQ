import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const root = resolve(__dirname, '../..');
const api = 'http://127.0.0.1:8000';
const project = `fixture-recovery-${randomUUID()}`;
const ownerA = { Authorization: 'Bearer local-driver-a' };
const ownerB = { Authorization: 'Bearer local-driver-b' };
const result = { version: 1, method: 'synthetic-mean-v1', count: 3, mean: 4 };
const display = '3 samples · mean 4 · synthetic-mean-v1';
type PersistedFixture = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  generation: number;
  lease_until: string | null;
  result: typeof result | null;
};
const composeArgs = [
  'compose', '--project-name', project, '--env-file', '.env.fixture.example',
  '-f', 'compose.yaml', '-f', 'ops/fixture-recovery/compose.yaml',
];
const psql = ['exec', '-T', 'db', 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'rafiq'];

function docker(args: string[], input?: string) {
  return execFileSync('docker', args, { cwd: root, encoding: 'utf8', input, stdio: 'pipe', timeout: 90_000 }).trim();
}

function compose(...args: string[]) {
  return docker([...composeArgs, ...args]);
}

function sql(query: string) {
  return compose(...psql, '-c', query);
}

function bootDb() {
  compose('up', '--wait', '--wait-timeout', '60', 'db');
}

function startWorker() {
  compose('up', '-d', '--no-build', '--no-deps', '--force-recreate', 'worker');
}

function workerCommand(command: string) {
  return compose('exec', '-T', 'worker', 'sh', '-c', command);
}

function inspect(service: string, format: string) {
  const id = compose('ps', '-a', '-q', service);
  return docker(['inspect', '--format', format, id]);
}

function schemaDump() {
  // pg_dump generates a different psql restriction key on each invocation.
  return compose('exec', '-T', 'db', 'pg_dump', '-U', 'postgres', '--schema-only', '--schema=rafiq_fixture', 'rafiq')
    .split(/\r?\n/).filter((line) => !/^\\(?:un)?restrict /.test(line)).join('\n').trim();
}

function fixtureRows(): PersistedFixture[] {
  return JSON.parse(sql("SELECT json_agg(fixtures ORDER BY owner_id) FROM rafiq_fixture.fixtures"));
}

async function waitForR() {
  await expect.poll(() => workerCommand('test ! -f /tmp/rafiq-recovery-r-ready || echo ready'), {
    timeout: 45_000, intervals: [250],
  }).toBe('ready');
}

test.skip(process.env.RAFIQ_RECOVERY_DRILL !== '1', 'Run the recovery drill separately on a disposable stack');

test('recover the fixture through upgrade, database outage and worker interruption', async ({ browser, page, request }) => {
  test.setTimeout(300_000);
  const probe = async (path: string) => (await request.get(`${api}/internal/${path}`, { timeout: 8_000 })
    .catch(() => null))?.status();
  const heartbeat = () => workerCommand('python -m fixture.worker --check-health; echo $?');
  const fixture = (headers = ownerA) => request.get(`${api}/api/v1/local-fixtures/current`, { headers });

  try {
    const fresh = await test.step('fresh PostgreSQL migration and graceful drain', async () => {
      bootDb();
      compose('run', '--rm', '--no-deps', 'migrate');
      const schema = schemaDump();
      expect(schema).toContain('CREATE INDEX fixtures_claimable_id');
      compose('up', '-d', '--no-deps', 'api');
      await expect.poll(() => probe('readyz'), { timeout: 15_000 }).toBe(200);

      const submit = (headers: Record<string, string>) => request.post(`${api}/api/v1/local-fixtures`, { headers });
      expect((await (await submit(ownerA)).json()).status).toBe('queued');
      startWorker();
      await waitForR();
      expect(heartbeat()).toBe('0');
      expect((await (await submit(ownerB)).json()).status).toBe('queued');
      compose('kill', '-s', 'SIGTERM', 'worker');
      workerCommand('touch /tmp/rafiq-recovery-r-release');
      await expect.poll(() => inspect('worker', '{{.State.Status}} {{.State.ExitCode}}')).toBe('exited 0');
      expect((await (await fixture()).json()).result).toEqual(result);
      expect((await (await fixture(ownerB)).json()).status).toBe('queued');
      console.log('Drain: SIGTERM after Driver A entered R; exit 0, Driver A completed, Driver B still queued.');
      compose('down', '--volumes');
      return schema;
    });

    const prior = await test.step('seed revision 0001, upgrade and restart with identical rows and schema', async () => {
      bootDb();
      compose('run', '--rm', '--no-deps', 'migrate', 'alembic', 'upgrade', '0001_local_fixture');
      const seed = readFileSync(resolve(root, 'ops/fixture-recovery/seed.sql'), 'utf8');
      docker([...composeArgs, ...psql], seed);
      const rows = fixtureRows();
      expect(rows.map((row) => row.status)).toEqual(['queued', 'completed']);
      compose('up', '-d', '--no-deps', 'api');
      startWorker();
      await expect.poll(() => probe('livez'), { timeout: 15_000 }).toBe(200);
      expect(await probe('readyz')).toBe(503);
      expect((await fixture()).status()).toBe(503);
      await expect.poll(() => compose('logs', 'worker')).toContain('database or schema unavailable');
      expect(inspect('worker', '{{.State.Status}}')).toBe('running');
      expect(heartbeat()).toBe('1');
      compose('stop', 'worker');

      compose('run', '--rm', '--no-deps', 'migrate');
      await expect.poll(() => probe('readyz')).toBe(200);
      compose('down');
      bootDb();
      expect(schemaDump()).toBe(fresh);
      expect(fixtureRows()).toEqual(rows);
      compose('up', '--wait', '--wait-timeout', '30', '--no-build', '--no-deps', 'api', 'web');
      expect(await probe('readyz')).toBe(200);
      expect(await (await fixture()).json()).toEqual({ id: rows[0].id, status: 'queued', result: null });
      expect(await (await fixture(ownerB)).json()).toEqual({ id: rows[1].id, status: 'completed', result });
      for (const headers of [{}, ownerB]) {
        const denial = await request.get(`${api}/api/v1/local-fixtures/${rows[0].id}`, { headers });
        expect(denial.status()).toBe(headers === ownerB ? 404 : 401);
      }
      console.log('Upgrade: revision 0001 live 200, ready 503, heartbeat 1; current head ready 200.');
      console.log('Fresh and upgraded schema dumps match, including grants and RLS. Both rows survived restart; owner restrictions held.');
      return rows;
    });

    await test.step('kill the claimed worker, reclaim after lease expiry, and reject a late publish', async () => {
      await page.goto('http://127.0.0.1:3000');
      await expect(page.getByTestId('fixture-id')).toHaveText(prior[0].id);
      await expect(page.getByText('Waiting for the worker…')).toBeVisible();
      startWorker();
      await waitForR();
      const first = fixtureRows()[0];
      expect(first).toMatchObject({ id: prior[0].id, status: 'running', generation: 1, result: null });
      compose('kill', '-s', 'SIGKILL', 'worker');
      await expect.poll(() => inspect('worker', '{{.State.Status}} {{.State.ExitCode}}')).toBe('exited 137');
      expect(fixtureRows()[0]).toEqual(first);
      console.log(`Interruption: exited 137 after generation ${first.generation} claimed ${first.id}; lease expires ${first.lease_until}.`);

      startWorker();
      await waitForR();
      const second = fixtureRows()[0];
      expect(second).toMatchObject({ id: first.id, status: 'running', generation: 2, result: null });
      // The claim sets a 30-second lease using the same database clock as the expiry check.
      expect(Date.parse(second.lease_until ?? '') - 30_000).toBeGreaterThanOrEqual(Date.parse(first.lease_until ?? ''));
      const latePublish = compose('exec', '-T', 'worker', 'python', '-c', [
        'from fixture.database import engine_for',
        'from fixture.worker import PUBLISH',
        'import sys',
        'with engine_for("worker").begin() as connection:',
        '    print(connection.execute(PUBLISH, dict(id=sys.argv[1], generation=1, status="completed", result=sys.argv[2])).rowcount)',
      ].join('\n'), first.id, JSON.stringify(result));
      expect(latePublish).toBe('0');
      expect(fixtureRows()[0]).toEqual(second);
      workerCommand('touch /tmp/rafiq-recovery-r-release');
      console.log(`Reclaim: generation ${second.generation} lease expires ${second.lease_until}; generation 1 publish updated ${latePublish} rows.`);

      await expect(page.getByText(display)).toHaveCount(1);
      await page.reload();
      await expect(page.getByText(display)).toHaveCount(1);
      await expect(page.getByTestId('fixture-id')).toHaveText(first.id);
      expect(fixtureRows()[0]).toMatchObject({ id: first.id, generation: 2, status: 'completed', result });
      console.log(`${browser.browserType().name()} ${browser.version()}: ${first.id} reloaded with one durable result (${display}).`);
    });

    await test.step('lose PostgreSQL and recover probes on the same API and worker processes', async () => {
      const running = '{{.Id}} {{.State.StartedAt}}';
      const apiProcess = inspect('api', running);
      const workerProcess = inspect('worker', running);
      expect(await probe('readyz')).toBe(200);
      expect(heartbeat()).toBe('0');
      compose('stop', 'db');
      await expect.poll(() => probe('readyz'), { timeout: 15_000 }).toBe(503);
      expect(await probe('livez')).toBe(200);
      await expect.poll(heartbeat, { timeout: 15_000 }).toBe('1');
      const unavailable = await fixture();
      expect(unavailable.status()).toBe(503);
      expect(await unavailable.json()).toEqual({ detail: 'Fixture database unavailable' });
      await page.reload();
      await expect(page.getByRole('button', { name: 'Reload fixture' })).toBeVisible();
      bootDb();
      await expect.poll(() => probe('readyz'), { timeout: 15_000 }).toBe(200);
      await expect.poll(heartbeat, { timeout: 15_000 }).toBe('0');
      expect(inspect('api', running)).toBe(apiProcess);
      expect(inspect('worker', running)).toBe(workerProcess);
      await page.getByRole('button', { name: 'Reload fixture' }).click();
      await expect(page.getByText(display)).toHaveCount(1);
      await expect(page.getByTestId('fixture-id')).toHaveText(prior[0].id);
      console.log('PostgreSQL stop: live 200, ready 503, heartbeat 1. Restart: ready 200 and heartbeat 0 on the same processes.');
    });

    await test.step('a stale heartbeat does not satisfy the worker probe', async () => {
      const readProbe = 'python -m fixture.worker --check-health; echo $?';
      const probes = compose('run', '--rm', '--no-deps', 'worker', 'sh', '-c', [
        readProbe,
        'touch -t 200001010000 /tmp/rafiq-fixture-worker.heartbeat || exit 2',
        readProbe,
      ].join('\n'));
      expect(probes.split(/\r?\n/)).toEqual(['1', '1']);
      console.log('Worker probe: a missing file and a stale file both exited 1.');
    });
  } catch (error) {
    console.log(compose('logs', '--no-color', '--tail', '60'));
    throw error;
  } finally {
    compose('down', '--volumes');
  }
});
