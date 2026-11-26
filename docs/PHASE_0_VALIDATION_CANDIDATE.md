# Phase 0 HTTPS validation handoff

**Pending** · FND-05 · M01, M03, M06, M10 · NFR-01–NFR-05 · J1–J8 preparation. This is the release record for the synthetic validation candidate. Release records approval and the exact candidate before deployment. [Issue #11](https://github.com/alisameh05/RAFIQ/issues/11) · [Hosting runbook](PHASE_0_HOSTING.md) · [Provisioning evidence](PHASE_0_ACCESS_EVIDENCE.md)

## Candidate and operator record

| Item | Status and evidence to attach | Owner |
| --- | --- | --- |
| Reviewed revision and CI | Pending. Record the approved PR, passing gate run, resulting `master` commit and passing push run. Link an expanded-gate fork run and failure evidence. Record whether GitHub enforced the gate and which upstream check failed. The bootstrap run established a baseline for commit `98db96c554de61ee37b3f37371207c83d1a3d0f3`. [Baseline run](https://github.com/alisameh05/RAFIQ/actions/runs/45880296460) | Repository owner and independent PR reviewer |
| Registry and matching runtime images | Pending. Approve the registry, visibility, budget and host platform. Record the immutable API and worker manifest digests for the same reviewed revision, and the source and revision labels, provenance, SBOM and scan for each. Pull and smoke those digests before deploying. [Image publishing and verification](DOCKER.md#registry-and-candidate-publishing) | Platform and Release |
| Hosted entry points and runtime | Pending. Record the web deployment ID and browser HTTPS URL, API HTTPS origin, approved callback registration, worker host, effective Node, npm, Python, uv, R, renv and PostgreSQL versions, Alembic head and tested TLS role access from the actual hosts. Keep service IDs and credential retrieval paths in the private operations handoff. | Platform |
| Operator access and rollback | Pending. Name the deployment operator and independent reviewer. Confirm operator access to the private handoff and each runtime. Record the prior compatible web deployment, API and worker digests and schema. For the first deployment, confirm the containment path and approved local fallback. [Rollback procedure](GIT_WORKFLOW.md#14-cicd-failure-handling-and-rollback) | Release |

The current browser fixture targets loopback and uses two built-in synthetic identities. Hosted work requires an approved HTTPS API origin, a hosted API configuration that uses the host's assigned port, and an environment-specific identity adapter for the browser and API. Platform also needs the approved test callback contract and scoped object access path. The existing provisioning record documents account-level checks. Release still needs intended-host access evidence, callback registration and candidate authorization. [Local fixture](LOCAL_FIXTURE.md) · [Day 2 escalation](PHASE_0_DAY_2_ESCALATION.md)

## Deployed smoke record

For each run, record the date and time, environment, candidate and schema, synthetic fixture, expected and observed outcome, operator and reviewer. Link sanitized run evidence. Store test identities, headers, any object URLs containing signatures, and restricted provider evidence in the private operations handoff. [Evidence fields](IMPLEMENTATION_GUIDE.md#5-traceability-and-release-evidence)

| Check and entry point | Expected result | Status and owner |
| --- | --- | --- |
| Browser fixture at the approved validation URL | The authorized synthetic owner submits the fixture. Samples 2, 4 and 6 yield one committed `synthetic-mean-v1` result with count 3 and mean 4. Reload and repeat submission return the same fixture ID and result. | Pending approved identity adapter and deployed candidate. Platform and Identity. |
| Fixture API through the approved HTTPS origin | The missing or invalid identity is denied. A second synthetic identity cannot read the first owner's fixture. Requests from an unapproved browser origin receive no access-control allowance. | Pending deployed candidate. Platform and Identity. |
| Approved callback test registration | An allowed, correctly signed test event is accepted. A request with an invalid signature and an event signed for a different environment are rejected without recording a successful event. | Pending approved callback contract, test registration and signing-key scope. Platform and callback owner. |
| Private object path | The validation-scoped actor reads the approved synthetic object and matches its reference hash. Anonymous and out-of-scope access are denied. | Pending approved scoped access from the actual runtime. Platform. |
| Service probes | An attended request to web `/healthz` and API `/internal/readyz` succeeds. On the worker host, `python -m fixture.worker --check-health` succeeds after the worker starts. Record minimal status and timestamps. | Pending hosted services and confirmed operator access. Platform and Release. |
| Day 3 Clerk probe | An approved synthetic user receives and completes the development email verification flow on the validation origin. Record success or the prerequisite preventing the attempt. | Pending deployed identity path and Identity coordination. |
| Day 3 stationary camera probe | On supported Windows 11 and Chrome, Vision observes camera permission and readiness with the vehicle stationary. Record the device, Chrome version and outcome. | Pending the hosted camera-readiness path, secure validation origin, supported device access and Vision coordination. |

Release confirms the recorded revision and signs off reproducible smoke evidence before handoff. Public rollout and live providers remain gated by their independent qualifications. [Release gates](PRD.md#8-planning-decisions-and-release-gates)
