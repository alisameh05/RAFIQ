# Run the local browser-to-R fixture

Issue #5 implements FND-02 for modules M01, M03, M06 and M10 and prepares NFR-03 and NFR-05 evidence. This synthetic page has no product screen ID. Its only inputs are the two local identities and the built-in samples 2, 4 and 6. The expected result is three samples with a mean of 4 and method `synthetic-mean-v1`. [Issue #5](https://github.com/alisameh05/RAFIQ/issues/5) · [Implementation guide](IMPLEMENTATION_GUIDE.md#phase-0--running-foundation-and-qualification-intake)

## Clean startup

Use a working Docker Engine with Compose v2 or newer and Linux containers. On Windows, start Docker Desktop with its WSL 2 backend. From a clean checkout, run these commands. The example file already contains the synthetic settings.

```powershell
docker compose --env-file .env.fixture.example config --quiet
docker compose --env-file .env.fixture.example up --build --wait --wait-timeout 180
docker compose --env-file .env.fixture.example ps -a
```

The first build restores `web/package-lock.json` with npm, `server/uv.lock` with uv, and `server/renv.lock` with renv. Pin and restore the dependencies used by this slice according to the [TRD baseline](TRD.md#11-runtime-and-dependency-baseline). The Dockerfiles and Compose file pin upstream image index digests. The API uses a pinned Ubuntu base while Debian's current API base has unresolved high-severity scan findings. The API and worker use uv-managed Python, and the worker build verifies the renv and jsonlite source archives. The fixture workflow records observed runtime versions, image IDs and lockfile hashes.

| Service | Entry point and evidence |
| --- | --- |
| PostgreSQL | Private Compose network. The TCP health check waits for the official entry point to finish bootstrap. |
| Alembic | `migrate` runs `alembic upgrade head` once for startup under the migration login. API and worker wait for its successful exit. |
| Web | Open `http://127.0.0.1:3000`. `GET /healthz` confirms the Next.js process responds. |
| API | `GET /internal/livez` checks the process. `GET /internal/readyz` returns 200 when the expected schema revision is available under the API login, or 503 when unavailable. Use `http://127.0.0.1:8000`. |
| Worker | `python -m fixture.worker` checks the pinned R and jsonlite versions and processes PostgreSQL leases. `python -m fixture.worker --check-health` checks for a fresh heartbeat from the claim loop. |

The browser calls FastAPI directly. Use the literal loopback address above so the browser origin matches the CORS policy. The API resolves the bearer token to a fixed synthetic identity before opening an owner-scoped transaction. Choose Driver A, submit the fixture, wait for the result and reload. The same fixture UUID and result should appear. Driver B on an empty fixture volume starts with an empty history. The fixture API returns 401 without a recognized synthetic bearer and 404 for another driver's fixture UUID.

## PostgreSQL parity and role scope

The fixture uses the official PostgreSQL 17.12 Debian Bookworm image. PostgreSQL 17 is the local major-version target for the Supabase PostgreSQL 17 family. This slice uses core UUID, JSONB, transaction, row-locking and RLS features and requires zero extensions. Hosted project patch, extension inventory, TLS, pooler semantics and release readiness require evidence from the isolated hosted environment. [PostgreSQL 17.12 release](https://www.postgresql.org/docs/17/release-17-12.html) · [Supabase upgrade guidance](https://supabase.com/docs/guides/platform/upgrading)

The first startup creates the dedicated private fixture schema and three separate logins. Alembic owns DDL under the migration login. The API's transaction-local identity limits its RLS reads and inserts to the owner and its grants exclude updates. The worker can read only its job columns, claim queued or expired jobs, and update the lease and result columns. A publish succeeds only for the running job's current, unexpired generation. The fixture input and its one logical job share a row to commit both atomically. The result is available to the owner after the worker commits it.

The named `pgdata` volume is mounted at `/var/lib/postgresql/data`. A normal `docker compose --env-file .env.fixture.example down` preserves it. Use a unique Compose project and its fresh volume for a disposable cold run. For that disposable project only, `down --volumes` removes its database. Run one stack at a time because the browser and API use fixed loopback ports.

## Verification

### PDF and Word render smoke

Issue #7 verifies the renderer baseline for FND-02 and modules M06 and M10. The smoke reads Driver A's completed fixture through the existing owner-scoped API after the worker commits it. It validates the result version, method and figures, then passes one immutable snapshot to WeasyPrint and python-docx. The output contains synthetic fixture values and omits the fixture ID and identity. [Issue #7](https://github.com/alisameh05/RAFIQ/issues/7) · [TRD baseline](TRD.md#11-runtime-and-dependency-baseline)

| Measure | Expected in both files |
| --- | --- |
| Samples | 2, 4, 6 (unitless) |
| Sample count | 3 samples |
| Mean | 4 (unitless) |
| Method | `synthetic-mean-v1` |
| Result version | 1 |

To repeat the smoke for a validation candidate, use its exact Git revision with a disposable Compose project on Linux x86-64. Start the stack as described above, submit Driver A's fixture using the browser, and wait for `completed`. Install LibreOffice Writer, Poppler utilities, Fontconfig and DejaVu Sans on the inspection host, then run from the repository root with Bash. Use a fresh output directory for each run.

```bash
docker compose --env-file .env.fixture.example --profile render build --no-cache renderer
bash ops/fixture-render/smoke.sh logs/render-fixture
```

The renderer target in [server/Dockerfile](../server/Dockerfile) pins the Python 3.14.10 Bookworm image by digest, the signed Debian and Debian Security archives to `20261120T000000Z`, and the Pango, HarfBuzz, Fontconfig and DejaVu package versions. [server/uv.lock](../server/uv.lock) locks WeasyPrint 70.0, python-docx 1.2.0 and their Python dependencies. The build uses the optional `render` dependency group. The one-shot renderer consumes the synthetic API response through stdin and writes to the mounted output directory with networking disabled.

The smoke checks the text and embedded fonts in the PDF and in a LibreOffice render of the DOCX. Open `pdf-page.png` and `word-page.png` to check alignment, legibility and matching numbers and units. The GitHub workflow publishes both source documents, both previews, `comparison.txt` and `dependencies.txt` as `synthetic-render-fixture`. The dependency record includes the tested revision, Linux image ID and architecture, lock and output hashes, and the renderer's Python and native package inventories. It also records inspection tool versions and the hashes of the regular and bold fonts selected in both environments.

### Browser, database and recovery checks

The [local fixture job in RAFIQ CI](https://github.com/alisameh05/RAFIQ/actions/workflows/ci.yml) runs the clean build, real Chromium browser smoke, PostgreSQL role checks, R result and lease fencing checks, and a restart using the same volume. Reproduce the browser smoke on a fresh running stack with the pinned Node and npm versions.

```powershell
Push-Location web
npm ci
npm run lint
npm run typecheck
npm exec playwright install chromium
npm run test:e2e
Pop-Location
```

Optionally set `RAFIQ_BROWSER_CHANNEL=chrome` in your shell before the test to use installed Chrome. Once the browser smoke succeeds, stop the ordinary worker before running the deterministic role and lease tests. These tests submit Driver B's fixture, so use a fresh disposable volume for each full suite.

```powershell
docker compose --env-file .env.fixture.example stop worker
docker compose --env-file .env.fixture.example run --build --rm --no-deps worker-test
```

The fixture uses no provider credentials. Its public synthetic defaults require the explicit `local-fixture` mode and a disposable database. Real secrets and local logs belong in ignored files. Check with `git check-ignore .env server/.env.local web/debug.log logs/fixture.txt`. The committed `.env.fixture.example` contains public test values.

## Recovery drill

The drill implements the recovery portion of FND-02 for M03, M06 and M10. It prepares NFR-03 and NFR-05 evidence using the PostgreSQL 17.12 Compose configuration, synthetic identities and the fixture page. It uses the same one-shot migration service as startup. [Issue #6](https://github.com/alisameh05/RAFIQ/issues/6) · [Docker implementation checklist](DOCKER.md#19-implementation-checklist) · [API verification matrix](API.md#15-api-testing-and-contract-validation)

Build the images and install the browser tooling as described above. Stop the original Compose stack to free ports 3000 and 8000. The drill creates and removes its own uniquely named Compose project and synthetic volumes. If you built with a custom Compose project name, set `RAFIQ_RECOVERY_IMAGE_PROJECT` to that name so the drill can find its web and worker images.

```powershell
docker compose --env-file .env.fixture.example down
Push-Location web
$env:RAFIQ_RECOVERY_DRILL = '1'
npm run test:e2e -- recovery.spec.ts
Remove-Item Env:RAFIQ_RECOVERY_DRILL
Pop-Location
```

The workflow step **Verify populated upgrade, probes, drain, reclaim and browser recovery** records these observations under the tested revision.

| Scenario | Expected evidence |
| --- | --- |
| Fresh and populated migration | Create head on an empty volume. On a separate volume, seed one queued and one completed job under revision `0001_local_fixture`, then run `migrate` to `0002_fixture_claim_index` and recreate the stack. Compare schema dumps, including grants and RLS, and verify each row, its job state and result, the owner reads, and the 401 and 404 denials. |
| API and worker signals | With the prior revision and again with PostgreSQL stopped, API liveness stays at 200 while readiness returns 503. Valid fixture requests return a generic 503. The worker stays running with an unhealthy heartbeat. Restart PostgreSQL and observe readiness and heartbeat recover on the same processes. An absent or stale heartbeat exits 1. |
| Graceful drain | Hold the first job at the real R calculation, submit a second job, signal `SIGTERM` and release R. The worker finishes one job, leaves the second queued and exits 0. |
| Forced interruption and browser recovery | Kill a worker after generation 1 has committed its claim. Wait for the PostgreSQL lease to expire naturally. A replacement claims generation 2 and the old generation's publication updates zero rows. Chromium reload shows the same UUID and exactly one validated R result. Retry the same browser read after database recovery. |

### Local probe and recovery defaults

**Platform approval is pending.** Review these defaults with the drill evidence. Record the approver, date and evidence link on issue #6 before marking the approval criterion complete. No production alert or release threshold is set by this drill.

| Setting | Local behavior |
| --- | --- |
| Liveness and readiness | Liveness checks HTTP process responsiveness without touching PostgreSQL. Readiness requires the API role and current Alembic revision. The Compose readiness check runs every 2 seconds with a 2-second HTTP deadline and a 3-second command timeout. Compose uses 15 consecutive failures for the API and worker container health status. The drill measures the underlying signals directly. |
| PostgreSQL reconnection | Runtime and one-shot migration connections use a 3-second connection timeout, a 3-second pool checkout timeout and a 5-second per-statement timeout. TCP uses a 5-second user timeout and keepalives after 2 seconds of idle time with 1-second intervals and 3 probes. API operations return to the caller after an error. The worker retries DB and schema errors with jittered waits of 0.5–1, 1–2 and then 2–4 seconds until a claim-loop transaction succeeds. |
| Worker heartbeat | Check freshness locally every 2 seconds. Missing or age 20 seconds or greater is unhealthy. Only a successful claim-loop transaction refreshes the file. Startup, detected DB/schema failure and graceful stop clear it. |
| Drain and lease | An idle worker checks for jobs every 0.5 seconds. On terminate, it stops starting claims and can finish an in-flight claim. R has a 10-second deadline, Compose allows 20 seconds before forced stop, and PostgreSQL owns the 30-second lease clock. A lost or expired generation cannot publish. |
