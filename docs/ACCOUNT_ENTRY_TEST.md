# Phase 1 email account entry

[Issue #24](https://github.com/alisameh05/RAFIQ/issues/24) covers ACC-01, FR-01/AC-01, FR-02/AC-02, NFR-04/NFR-05, and J1 screens P01–P03. [Screen requirements](SCREENS.md#public-access-and-onboarding) · [Account API](API.md#7-detailed-endpoint--operation-specifications)

## Configure an isolated instance

Use a dedicated Clerk development instance for the email/password test. Enable email as a required sign-up identifier, verification at sign-up with **Email verification code**, and password sign-up and sign-in. Leave other required signup fields and social connections off for this slice. Use Clerk's instance-specific password and verification policies. The Phase 0 email-code sign-in fixture has its own configuration and remains a separate API surface. [Clerk email/password setup](https://clerk.com/docs/guides/development/custom-flows/authentication/email-password)

| Environment | RAFIQ web | Clerk access mode |
| --- | --- | --- |
| Isolated signup test | `RAFIQ_ACCOUNT_ENTRY=true`, `RAFIQ_SIGNUP_MODE=test-open`, matching development keys | **Open**, without an affiliation, allowlist or invitation requirement |
| Closed signup with authorized sign-in | `RAFIQ_ACCOUNT_ENTRY=true`, `RAFIQ_SIGNUP_MODE=closed` | **Invite-only** (`restricted`), with no public invitations or public enrollment links |
| Phase 0 fixture | Keep `RAFIQ_ACCOUNT_ENTRY` unset | Preserve the fixture instance settings |

Pair the website setting with Clerk access mode before exposing the origin. The web route controls P01 and P02. Clerk enforces admission on its Frontend API independently of the web route. Existing authorized accounts use the Clerk sign-in entry in closed mode. For future social enablement, use the same Clerk access mode for first-time social identities, require verified linking to any existing account, and verify both a returning social sign-in and a denied first-time social identity before enabling that provider. Keep unqualified providers disabled in Clerk. Product UI and Release own approval of the public-signup policy and pending copy. [Clerk access modes](https://clerk.com/docs/guides/secure/restricting-access)

Set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` for the web build and runtime, and set `CLERK_SECRET_KEY` in the web server's secret store. Use `RAFIQ_ACCOUNT_API_ORIGIN` for the exact HTTPS service origin. Local Next development accepts `http://127.0.0.1:8000` with the development build. The signup switch requires both development key prefixes.

Provision a separate database for hosted Phase 1 signup qualification. Run Alembic with the dedicated migration connection using the existing database bootstrap for that environment. Revision `0004_driver_accounts` adds the account table to the existing migration-managed namespace. Its API grants use the existing restricted runtime role. This role can insert a verified subject and read its scoped status. The worker has no account grant. The transaction-scoped subject is derived after Clerk verification. Clerk remains the source of the current primary email. The updated Phase 0 services accept revisions `0003_validation_callback` and `0004_driver_accounts`. On an existing Phase 0 environment, update those services before applying the additive migration. The account API requires the new revision. Keep the new schema when rolling back to a compatible build. Prefer forward repair for a partially applied or populated database.

For the account API, use `RAFIQ_API_SURFACE=accounts` with the existing `RAFIQ_MODE` and API database URL conventions. Set `RAFIQ_WEB_ORIGIN`, `CLERK_ISSUER`, `CLERK_JWT_KEY`, `CLERK_SECRET_KEY`, and `RAFIQ_CONTROLLED_USE_VERSION` in the API environment. Clerk values must come from the same isolated instance. Set `RAFIQ_SUPPORT_CONTACT` when the published support address is supplied. Use the API startup entry point `python -m fixture.serve`. Keep the Clerk secret and PostgreSQL URLs in their environment secret stores. Hosted API/database configuration retains the fixture scaffold's explicit HTTPS and verified PostgreSQL TLS. Local testing uses the loopback web origin `http://127.0.0.1:3000`.

## Collect evidence

1. Run the [CI fixture workflow](../.github/workflows/local-fixture.yml). It starts PostgreSQL from an empty volume, runs Alembic to head, and runs `server/tests/test_accounts.py` under the non-owner API and worker roles. The test signs synthetic Clerk assertions and substitutes only the Clerk Backend API responses. It checks simultaneous first reads, stable account identity, unverified and revoked denial, wrong issuer/origin, and transaction-scoped ownership.
2. Against the configured local or isolated HTTPS app, set `RAFIQ_ACCOUNT_E2E_URL`, `RAFIQ_ACCOUNT_E2E_MODE=open`, `RAFIQ_ACCOUNT_E2E_CLERK_ORIGIN`, and `RAFIQ_ACCOUNT_E2E_CLERK_TOKEN` for the browser runner. Use a short-lived development Testing Token from the Clerk Backend API. Run `npm run test:e2e -- account-entry.spec.ts` from `web/`. The run uses a unique `+clerk_test` identity and Clerk's synthetic code. Use the same command with `RAFIQ_ACCOUNT_E2E_MODE=closed` and the closed configuration. Repeat authorized sign-in with a pre-provisioned test account. Retire the synthetic identity and its development data according to the test environment's retention policy. [Clerk testing tokens](https://clerk.com/docs/guides/development/testing/overview) · [Clerk test email addresses](https://clerk.com/docs/guides/development/testing/test-emails-and-phones)
3. On P03, confirm an expired code prioritizes **Resend verification**. Exercise a provider throttle with a retry delay and a transient resend failure. After recovery, confirm the code field is empty and focused. Check the native one-time-code suggestion on a supported device and clipboard paste at 320 CSS px.
4. Record the candidate SHA, environment, Clerk/DB contract and config versions, synthetic identity reference, setup, timestamp, expected and observed outcomes, reviewer, and disposition. Share sanitized evidence only. Keep real-email delivery and authorization for a public release in their respective qualifications. [Evidence record](IMPLEMENTATION_GUIDE.md#5-traceability-and-release-evidence)

## Returning driver sign-in and recovery

[Issue #26](https://github.com/alisameh05/RAFIQ/issues/26) covers P04 sign-in, returning-driver P03 verification and P05 password recovery. P04 and P05 carry the fixed account-entry context to the account API gate. Issue #27 owns onboarding acceptance and the allowlist and authorization checks for additional destinations.

- Identity configures email/password sign-in, email-code recovery and Strict enumeration protection in the isolated Clerk instance. Confirm the reset delivery and session behavior before enabling that configuration. Product UI reviews the generic receipt and retry copy. [Clerk recovery setup](https://clerk.com/docs/guides/development/custom-flows/authentication/forgot-password) · [Enumeration protection](https://clerk.com/docs/guides/protect/user-enumeration-protection)
- For the local browser checks, build the web application, set `RAFIQ_LANDING_LOCAL=1` and run `npm run test:e2e -- driver-access.spec.ts` in `web/`. The browser uses the Next.js routes with simulated Clerk responses. The suite checks rejected credentials and retry, a returning email challenge and correction, the signed-out account entry, generic recovery, invalid and expired code feedback, throttled resend, password reset confirmation and keyboard focus at 320 CSS pixels.
- Run `account-entry.spec.ts` with the isolated browser configuration above. Record the same driver ID before recovery and after fresh sign-in with the new password. With an approved test mailbox, confirm code delivery, expiry, resend and the actual provider throttle. Set `RAFIQ_ACCOUNT_E2E_UNVERIFIED_EMAIL` and `RAFIQ_ACCOUNT_E2E_UNVERIFIED_PASSWORD` for a freshly provisioned unverified synthetic identity to confirm P03 verifies the registered address and **Change email** restarts sign-in without modifying the identity. Revoke or expire the test session and open `/account` again to confirm the resumable P04 entry. The unrelated-inbox rollout evidence has its own qualification.
- Run keyboard and screen-reader checks at narrow width and 200% zoom. Confirm names and help for the email, password and code fields, announcements for progress, errors and completion, and focus after code send, expiry, retry and reset. Record the evidence fields above with the exact candidate SHA.

## Controlled-use acceptance and private entry

[Issue #27](https://github.com/alisameh05/RAFIQ/issues/27) covers ACC-02, FR-01/AC-01, FR-02/AC-02, the FR-04/AC-04 handoff, NFR-04/NFR-05, and J1 screens P06, D01 and D02. The readiness endpoint provides current verified, eligible context for the MON-01 handoff. Camera access, recording consent and session start belong to MON-01.

Deploy the compatible account build on `0004_driver_accounts`, then migrate the isolated account database to `0005_controlled_use`. An empty publication table holds P06 acceptance and both private destinations closed. `RAFIQ_CONTROLLED_USE_VERSION` remains the account-status fallback before publication. Identity and Product UI review the exact conditions and fixed return allowlist before publication. The allowlist contains Dashboard (`/account/dashboard`) and the stationary readiness handoff (`/account/readiness`). Both resolve against the current driver and carry no resource identifiers. Add future record links only after the owning module supplies an authorization check.

The migration role publishes the four approved strings using this transaction. Use a fresh immutable version for every text change and retain the exact approved version and text in the publication evidence. The API role can read the publication and record the owning driver's acceptance. It has no publication write access.

~~~sql
BEGIN;
SELECT pg_advisory_xact_lock(27001);
INSERT INTO rafiq_fixture.controlled_use_publication (singleton, version, conditions)
VALUES (true, '<new-approved-version>', '{
  "stationary": "<approved stationary setup>",
  "supervised": "<approved supervised-use conditions>",
  "camera": "<approved initial camera guidance>",
  "recording": "<approved separate recording choice>"
}'::jsonb)
ON CONFLICT (singleton) DO UPDATE
SET version = excluded.version, conditions = excluded.conditions;
COMMIT;
~~~

To hold private access, take the same exclusive lock and delete the publication in that transaction. Preserve driver acceptance records for recovery. Verify a populated `0004` account survives the upgrade. Before rolling back to a build restricted to schema `0004`, hold the publication, retain its exact text and version in evidence, and downgrade to `0004_driver_accounts`. The downgrade removes the publication and acceptance write permission while retaining driver rows and accepted versions.

- Run `server/tests/test_accounts.py` using the disposable PostgreSQL fixture roles and migration connection. Compare the accepted version across concurrent replay, a fresh signed assertion and a publication change. Verify direct protected GET and POST denial for unverified, unaccepted, expired and restricted callers and isolation between two drivers.
- Run `RAFIQ_LANDING_LOCAL=1 npm run test:e2e -- controlled-use.spec.ts` after building the web app. The browser fixture substitutes the identity and account network responses. It checks validated return paths, session switch, keyboard focus, accessible headings and checkbox, progress, retriable failures, version change and the D02 handoff.
- In the isolated Open Clerk environment above, publish synthetic conditions and set `RAFIQ_ACCOUNT_E2E_CONTROLLED_USE=1` for `account-entry.spec.ts`. Confirm signup, recovery, current acceptance, readiness, reload and a fresh sign-in using the same account. Record an actual supported Chrome screen-reader run covering the conditions, progress, retry, changed version and sign-out.
- Record the candidate SHA, timestamp, environment and runtime, Clerk and conditions versions, fixture identity, setup, expected and observed results, and reviewer and disposition. Link sanitized runs in the candidate PR. Keep route enablement pending Identity and Product UI review. [Evidence fields](IMPLEMENTATION_GUIDE.md#5-traceability-and-release-evidence)
