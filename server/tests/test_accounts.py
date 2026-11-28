from concurrent.futures import ThreadPoolExecutor
import base64
import json
from datetime import datetime, timezone
from time import time
from uuid import uuid4

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import ProgrammingError
from svix.webhooks import Webhook

from fixture.account_lifecycle import ClerkCallback
from fixture.accounts import AccountSettings, create_account_app
from fixture.database import engine_for

WEB = "https://entry.example"
ISSUER = "https://identity.example"
ACCOUNT = "/api/v1/account"
TABLE = "rafiq_fixture.driver_accounts"
LINKS = "rafiq_fixture.workspace_links"
CALLBACK = "/webhooks/clerk"
CLERK_INSTANCE = "ins_synthetic"
SIGNING_SECRET = "whsec_" + base64.b64encode(b"synthetic-callback-secret").decode()
CONDITIONS = {
    "stationary": "Set up and operate driver controls while stationary.",
    "supervised": "Use the approved supervised procedure when the vehicle is moving.",
    "camera": "Check the front-facing camera view at readiness.",
    "recording": "Choose separately at readiness whether to allow recording.",
}


@pytest.fixture
def accounts():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode()
    settings = AccountSettings(WEB, ISSUER, public, "sk_test_synthetic", "controlled-use-1", "support@example.net")
    engine = engine_for("api")
    callback_engine = engine_for("callback")
    subjects, users = {}, {}

    def session(*, verified=True, status="active", banned=False, claims=None, subject=None, created_at=None):
        subject = subject or f"user_{uuid4().hex}"
        sid = f"sess_{uuid4().hex}"
        now = int(time())
        subjects[sid] = (subject, status, created_at if created_at is not None else now * 1000)
        users.setdefault(subject, {
            "id": subject, "verified": verified, "banned": banned, "locked": False, "updated_at": now * 1000,
        })
        token = jwt.encode({
            "iss": ISSUER, "azp": WEB, "sub": subject, "sid": sid,
            "iat": now, "nbf": now - 1, "exp": now + 60, **(claims or {}),
        }, key, algorithm="RS256")
        return subject, {"Authorization": f"Bearer {token}"}

    def clerk(request):
        assert request.headers["authorization"] == "Bearer sk_test_synthetic"
        identifier = request.url.path.rsplit("/", 1)[1]
        if request.url.path.startswith("/v1/sessions/"):
            subject, status, created_at = subjects[identifier]
            return httpx.Response(200, json={
                "id": identifier, "user_id": subject, "status": status, "created_at": created_at,
            })
        user = users.get(identifier)
        if user is None:
            return httpx.Response(404)
        return httpx.Response(200, json={
            **user, "primary_email_address_id": "idn_primary",
            "email_addresses": [
                {"id": "idn_secondary", "email_address": "secondary@example.net",
                 "verification": {"status": "verified"}},
                {"id": "idn_primary", "email_address": "driver@example.net",
                 "verification": {"status": "verified" if user["verified"] else "unverified"}},
            ],
        })

    with httpx.Client(transport=httpx.MockTransport(clerk), base_url="https://api.clerk.com/v1/") as provider:
        callback = ClerkCallback(callback_engine, CLERK_INSTANCE, SIGNING_SECRET)
        with TestClient(create_account_app(settings, engine, provider, callback=callback)) as client:
            client.app.state.synthetic_users = users
            yield client, session, engine
    engine.dispose()
    callback_engine.dispose()


def test_verified_session_resolves_one_durable_driver_across_concurrent_retries(accounts):
    client, session, _ = accounts
    _, headers = session()
    with ThreadPoolExecutor(max_workers=2) as callers:
        first, replay = list(callers.map(lambda _: client.get(ACCOUNT, headers=headers), range(2)))
    assert first.status_code == replay.status_code == 200
    assert first.headers["cache-control"] == "private, no-store"
    result = first.json()
    assert result == replay.json() == {
        "accountId": result["accountId"], "status": "onboardingRequired", "displayName": None,
        "registeredEmail": "driver@example.net", "verified": True, "acceptedVersion": None,
        "requiredVersion": "controlled-use-1", "supportContact": None,
    }
    _, other_headers = session()
    assert client.get(ACCOUNT, headers=other_headers).json()["accountId"] != result["accountId"]


def test_unverified_and_invalid_sessions_do_not_create_or_read_accounts(accounts):
    client, session, engine = accounts
    assert client.get(ACCOUNT).status_code == 401
    for options, expected in (
        ({"verified": False}, 403),
        ({"status": "revoked"}, 401),
        ({"claims": {"azp": "https://other.example"}}, 401),
        ({"claims": {"iss": "https://other.example"}}, 401),
        ({"claims": {"exp": 1}}, 401),
        ({"claims": {"sts": "pending"}}, 401),
        ({"claims": {"act": {"sub": "user_syntheticActor"}}}, 401),
    ):
        subject, headers = session(**options)
        response = client.get(ACCOUNT, headers=headers)
        assert response.status_code == expected
        assert response.headers["cache-control"] == "private, no-store"
        assert "accountId" not in response.json()
        with engine.begin() as connection:
            connection.execute(text("SELECT set_config('rafiq.driver_subject', :subject, true)"), {"subject": subject})
            assert connection.execute(text(f"SELECT id FROM {TABLE}")).all() == []


def test_runtime_role_cannot_read_write_across_drivers_or_change_eligibility(accounts):
    client, session, engine = accounts
    subject_a, headers_a = session()
    subject_b, headers_b = session()
    assert client.get(ACCOUNT, headers=headers_a).status_code == 200
    assert client.get(ACCOUNT, headers=headers_b).status_code == 200
    with engine.begin() as connection:
        assert connection.execute(text(f"SELECT id FROM {TABLE}")).all() == []
        connection.execute(text("SELECT set_config('rafiq.driver_subject', :subject, true)"), {"subject": subject_a})
        assert connection.execute(text(f"SELECT clerk_subject FROM {TABLE}")).scalars().all() == [subject_a]
        with pytest.raises(ProgrammingError, match="row-level security"):
            connection.execute(text(f"INSERT INTO {TABLE} (clerk_subject) VALUES (:subject)"),
                               {"subject": subject_b})
    with engine.begin() as connection:
        assert connection.execute(text(f"SELECT id FROM {TABLE}")).all() == []
        with pytest.raises(ProgrammingError, match="permission denied"):
            connection.execute(text(f"UPDATE {TABLE} SET restricted = false"))
    worker = engine_for("worker")
    try:
        with worker.begin() as connection, pytest.raises(ProgrammingError, match="permission denied"):
            connection.execute(text(f"SELECT id FROM {TABLE}"))
    finally:
        worker.dispose()

def test_restricted_driver_receives_only_the_problem_and_published_contact(accounts):
    client, session, _ = accounts
    _, headers = session(banned=True)
    response = client.get(ACCOUNT, headers=headers)
    assert response.status_code == 403
    assert response.headers["content-type"] == "application/problem+json"
    assert response.json() == {
        "type": "urn:rafiq:problem:account_restricted", "title": "Account access restricted",
        "status": 403, "code": "account_restricted", "supportContact": "support@example.net",
        "requestId": response.headers["x-request-id"],
    }

@pytest.fixture
def published_conditions():
    engine = engine_for("migrate")
    try:
        with engine.begin() as connection:
            connection.execute(text("""
                INSERT INTO rafiq_fixture.controlled_use_publication (singleton, version, conditions)
                VALUES (true, 'controlled-use-1', CAST(:conditions AS jsonb))
            """), {"conditions": json.dumps(CONDITIONS)})
        yield engine
    finally:
        with engine.begin() as connection:
            connection.execute(text("DELETE FROM rafiq_fixture.controlled_use_publication"))
        engine.dispose()


def test_private_workspace_link_resolves_only_for_its_eligible_owner(accounts, published_conditions):
    client, session, engine = accounts
    subject_a, headers_a = session()
    subject_b, headers_b = session()
    consent = {"version": "controlled-use-1", "accepted": True}
    owners = []
    for headers in (headers_a, headers_b):
        result = client.put(ACCOUNT + "/controlled-use", headers=headers, json=consent)
        assert result.status_code == 200
        owners.append(result.json()["accountId"])
    active, expired, deleted = [uuid4() for _ in range(3)]
    with published_conditions.begin() as connection:
        connection.execute(text(f"""
            INSERT INTO {LINKS} (id, driver_id, expires_at, deleted_at)
            VALUES (:active, :owner, now() + interval '1 hour', NULL),
                   (:expired, :owner, now() - interval '1 hour', NULL),
                   (:deleted, :owner, now() + interval '1 hour', now())
        """), {"owner": owners[0], "active": active, "expired": expired, "deleted": deleted})
    path = ACCOUNT + "/links/"
    for headers, identifier in (
        (headers_b, active), (headers_a, expired), (headers_a, deleted),
        (headers_a, uuid4()), (headers_a, "invalid"),
    ):
        result = client.get(path + str(identifier), headers=headers)
        assert result.status_code == 404
        assert result.headers["cache-control"] == "private, no-store"
        assert result.json() == {
            "type": "urn:rafiq:problem:resource_unavailable", "title": "Resource unavailable",
            "status": 404, "code": "resource_unavailable", "requestId": result.headers["x-request-id"],
        }
    context = client.get(path + str(active), headers=headers_a).json()
    assert 0 < context.pop("expiresInMs") <= 3_600_000
    assert context == {"destination": "dashboard", "accountId": owners[0], "acceptedVersion": "controlled-use-1"}

    forged = client.put(ACCOUNT + "/controlled-use", headers=headers_b, json={**consent, "accountId": owners[0]})
    assert forged.status_code == 422
    assert "accountId" not in forged.json()

    # Pin the physical connection and reuse it across several transaction owners.
    with engine.connect() as connection:
        for subject, rows in ((subject_a, [active]), (subject_b, []), (None, [])):
            with connection.begin():
                if subject:
                    connection.execute(text("SELECT set_config('rafiq.driver_subject', :subject, true)"),
                                       {"subject": subject})
                assert connection.execute(text(f"SELECT id FROM {LINKS}")).scalars().all() == rows
        with connection.begin():
            connection.execute(text("SELECT set_config('rafiq.driver_subject', :subject, true)"),
                               {"subject": subject_b})
            assert connection.execute(text(f"""
                UPDATE {TABLE} SET accepted_version = 'changed' WHERE id = :owner
            """), {"owner": owners[0]}).rowcount == 0
        with connection.begin(), pytest.raises(ProgrammingError, match="permission denied"):
            connection.execute(text(f"DELETE FROM {LINKS} WHERE id = :active"), {"active": active})


def test_a_linked_subject_keeps_its_driver_workspace_and_signed_provider_claims_grant_no_extra_access(
    accounts, published_conditions,
):
    client, session, _ = accounts
    subject, email = session()
    consent = {"version": "controlled-use-1", "accepted": True}
    original = client.put(ACCOUNT + "/controlled-use", headers=email, json=consent).json()
    profile = client.patch(ACCOUNT, headers=email, json={"displayName": "Original owned profile"}).json()
    assert profile["accountId"] == original["accountId"]
    link = uuid4()
    with published_conditions.begin() as connection:
        connection.execute(text(f"""
            INSERT INTO {LINKS} (id, driver_id, expires_at) VALUES (:link, :owner, now() + interval '1 hour')
        """), {"link": link, "owner": original["accountId"]})

    path = ACCOUNT + "/links/" + str(link)
    for _ in range(2):
        _, linked = session(subject=subject)
        assert client.get(ACCOUNT, headers=linked).json() == profile
        assert client.get(path, headers=linked).json()["accountId"] == original["accountId"]

    _, other = session(claims={"role": "staff"})
    account = client.get(ACCOUNT, headers=other).json()
    assert account["registeredEmail"] == original["registeredEmail"]
    assert account["accountId"] != original["accountId"]
    assert account["acceptedVersion"] is None
    assert client.get(ACCOUNT + "/workspace", headers=other).status_code == 403
    assert client.put(ACCOUNT + "/controlled-use", headers=other, json=consent).status_code == 200
    assert client.get(path, headers=other).status_code == 404


def sign_delivery(subject, event_type, revision, *, instance=CLERK_INSTANCE, banned=False):
    event_id = "msg_" + uuid4().hex
    when = datetime.now(timezone.utc)
    body = json.dumps({
        "object": "event", "instance_id": instance, "type": event_type, "timestamp": revision,
        "data": {"id": subject, "updated_at": revision, "banned": banned, "locked": False},
    })
    signature = Webhook(SIGNING_SECRET).sign(event_id, when, body)
    return body, {"svix-id": event_id, "svix-timestamp": str(int(when.timestamp())), "svix-signature": signature}


def test_clerk_callback_reconciles_durable_lifecycle_without_reopening_stale_authority(accounts, published_conditions):
    client, session, engine = accounts
    subject, old_headers = session()
    users = client.app.state.synthetic_users
    user = users[subject]
    revision = user["updated_at"]
    consent = {"version": "controlled-use-1", "accepted": True}
    assert client.put(ACCOUNT + "/controlled-use", headers=old_headers, json=consent).status_code == 200

    def delivery(event_type="user.updated", *, data_revision=revision, instance=CLERK_INSTANCE):
        return sign_delivery(subject, event_type, data_revision, instance=instance)

    def post(event):
        body, headers = event
        return client.post(CALLBACK, content=body, headers=headers)

    wrong_environment = delivery(instance="ins_elsewhere")
    assert post(wrong_environment).status_code == 400
    body, headers = delivery()
    assert post((body + " ", headers)).status_code == 400
    assert post(delivery("session.created")).status_code == 200

    user.update(banned=True, updated_at=revision + 100)
    restriction = delivery(data_revision=revision + 100)
    with ThreadPoolExecutor(max_workers=2) as callers:
        applied, duplicate = callers.map(post, [restriction, restriction])
    assert applied.status_code == duplicate.status_code == 200
    assert applied.content == duplicate.content == b""
    assert applied.headers["cache-control"] == "private, no-store"
    assert client.post(ACCOUNT + "/readiness", headers=old_headers).json()["code"] == "account_restricted"

    # Clerk's current restriction and our durable ban can become visible at different times.
    user.update(banned=False, updated_at=revision + 200)
    assert post(delivery()).status_code == 200
    assert client.get(ACCOUNT, headers=old_headers).json()["code"] == "account_restricted"
    # An unrelated provider update must not move the known reinstatement cutoff forward.
    user["updated_at"] = revision + 250
    assert post(delivery(data_revision=revision + 200)).status_code == 200
    assert client.get(ACCOUNT, headers=old_headers).status_code == 401
    _, fresh = session(subject=subject, created_at=revision + 201)
    assert client.get(ACCOUNT + "/workspace", headers=fresh).status_code == 200

    users.pop(subject)
    transient = delivery(data_revision=revision + 300)
    assert post(transient).status_code == 503
    user.update(updated_at=revision + 300)
    users[subject] = user
    assert post(transient).status_code == 200
    deletion = delivery("user.deleted", data_revision=revision + 301)
    assert post(deletion).status_code == 503
    users.pop(subject)
    assert post(deletion).status_code == 200
    assert client.get(ACCOUNT, headers=fresh).status_code == 401
    users[subject] = user
    assert post(delivery(data_revision=revision + 400)).status_code == 200
    assert post(deletion).status_code == 200
    assert client.get(ACCOUNT, headers=fresh).status_code == 401
    assert client.put(ACCOUNT + "/controlled-use", headers=fresh, json=consent).status_code == 401

    lifecycle = "rafiq_fixture.driver_identity_lifecycle"
    receipts = "rafiq_fixture.clerk_callback_receipts"
    callback = engine_for("callback")
    try:
        with callback.begin() as connection:
            assert connection.execute(text(f"SELECT state FROM {lifecycle} WHERE clerk_subject = :subject"),
                                      {"subject": subject}).scalar_one() == "deleted"
            assert connection.execute(text(f"SELECT count(*) FROM {receipts} WHERE event_id = :event"),
                                      {"event": restriction[1]["svix-id"]}).scalar_one() == 1
            assert connection.execute(text(f"SELECT count(*) FROM {receipts} WHERE event_id = :event"),
                                      {"event": wrong_environment[1]["svix-id"]}).scalar_one() == 0
        with callback.begin() as connection, pytest.raises(ProgrammingError, match="permission denied"):
            connection.execute(text(f"SELECT id FROM {TABLE}"))
        with engine.begin() as connection, pytest.raises(ProgrammingError, match="permission denied"):
            connection.execute(text(f"UPDATE {lifecycle} SET state = 'active'"))
        with engine.begin() as connection, pytest.raises(ProgrammingError, match="permission denied"):
            connection.execute(text(f"SELECT event_id FROM {receipts}"))
    finally:
        callback.dispose()


@pytest.mark.parametrize("restore_first", [True, False])
def test_delayed_restriction_still_retires_sessions_after_clerk_restores_access(accounts, restore_first):
    client, session, _ = accounts
    subject, old_headers = session()
    user = client.app.state.synthetic_users[subject]
    revision = user["updated_at"]
    assert client.get(ACCOUNT, headers=old_headers).status_code == 200

    restriction = sign_delivery(subject, "user.updated", revision + 100, banned=True)
    restore = sign_delivery(subject, "user.updated", revision + 200)
    user["updated_at"] = revision + 300
    profile_change = sign_delivery(subject, "user.updated", revision + 300)
    deliveries = (restore, profile_change, restriction) if restore_first else (restriction, profile_change, restore)
    for body, headers in deliveries:
        assert client.post(CALLBACK, content=body, headers=headers).status_code == 200

    assert client.get(ACCOUNT, headers=old_headers).status_code == 401
    _, fresh = session(subject=subject, created_at=revision + 201)
    assert client.get(ACCOUNT, headers=fresh).status_code == 200


def test_controlled_use_replay_and_private_access_for_the_current_driver(accounts):
    client, session, engine = accounts
    publisher = engine_for("migrate")
    conditions = CONDITIONS

    def publish(version):
        with publisher.begin() as connection:
            connection.execute(text("SELECT pg_advisory_xact_lock(27001)"))
            connection.execute(text("""
                INSERT INTO rafiq_fixture.controlled_use_publication (singleton, version, conditions)
                VALUES (true, :version, CAST(:conditions AS jsonb))
                ON CONFLICT (singleton) DO UPDATE SET version = excluded.version, conditions = excluded.conditions
            """), {"version": version, "conditions": json.dumps(conditions)})

    acceptance = ACCOUNT + "/controlled-use"
    dashboard = ACCOUNT + "/workspace"
    readiness = ACCOUNT + "/readiness"
    try:
        publish("controlled-use-1")
        subject, headers = session()
        for options, expected in (({"verified": False}, 403), ({"banned": True}, 403),
                                  ({"claims": {"exp": 1}}, 401)):
            _, ineligible = session(**options)
            assert client.get(dashboard, headers=ineligible).status_code == expected
            assert client.post(readiness, headers=ineligible).status_code == expected
            assert client.put(acceptance, headers=ineligible,
                              json={"version": "controlled-use-1", "accepted": True}).status_code == expected
        assert client.get(dashboard, headers=headers).json()["code"] == "controlled_use_required"
        assert client.post(readiness, headers=headers).status_code == 403
        assert client.get(acceptance, headers=headers).json() == {"version": "controlled-use-1", **conditions}
        rejected = client.put(acceptance, headers=headers, json={"version": "controlled-use-1", "accepted": False})
        assert rejected.status_code == 422
        assert rejected.json()["errors"] == [{"pointer": "/accepted", "code": "required"}]
        invalid = client.put(acceptance, headers=headers, json={"accepted": "untrusted", "other": "untrusted"})
        assert invalid.status_code == 422
        assert invalid.headers["content-type"] == "application/problem+json"
        assert "untrusted" not in invalid.text
        assert invalid.json()["errors"] == [
            {"pointer": "/accepted", "code": "invalid"}, {"pointer": "/version", "code": "required"},
        ]
        malformed = client.put(acceptance, headers={**headers, "Content-Type": "application/json"}, content="{")
        assert malformed.status_code == 400
        assert malformed.json()["code"] == "malformed_request"

        consent = {"version": "controlled-use-1", "accepted": True}
        with ThreadPoolExecutor(max_workers=2) as callers:
            saved, replay = callers.map(lambda _: client.put(acceptance, headers=headers, json=consent), range(2))
        assert saved.status_code == replay.status_code == 200
        assert saved.json() == replay.json()
        assert saved.json()["status"] == "active"
        assert client.get(ACCOUNT, headers=session(subject=subject)[1]).json() == saved.json()
        assert client.get(dashboard, headers=headers).json()["destination"] == "dashboard"
        assert client.post(readiness, headers=headers).json() == {
            "destination": "readiness", "accountId": saved.json()["accountId"],
            "acceptedVersion": "controlled-use-1",
        }
        assert client.get(dashboard, headers=session()[1]).status_code == 403
        with engine.begin() as connection:
            result = connection.execute(text(f"UPDATE {TABLE} SET accepted_version = 'other'"))
            assert result.rowcount == 0

        publish("controlled-use-2")
        conflict = client.put(acceptance, headers=headers, json=consent)
        assert conflict.status_code == 409
        assert conflict.json()["code"] == "controlled_use_changed"
        assert client.get(acceptance, headers=headers).json()["version"] == "controlled-use-2"
        assert client.get(ACCOUNT, headers=headers).json()["acceptedVersion"] == "controlled-use-1"
        assert client.post(readiness, headers=headers).status_code == 403
        assert client.put(acceptance, headers=headers,
                          json={"version": "controlled-use-2", "accepted": True}).status_code == 200
    finally:
        with publisher.begin() as connection:
            connection.execute(text("DELETE FROM rafiq_fixture.controlled_use_publication"))
        publisher.dispose()



def test_monitoring_preferences_are_owned_replacements_and_keep_live_policy_out(accounts):
    client, session, _ = accounts
    publisher = engine_for("migrate")
    preferences = ACCOUNT + "/preferences"
    version = "controlled-use-1"
    default = {"cameraDeviceId": None, "warningAudio": False, "warningVisibility": "default"}
    enhanced = {"cameraDeviceId": "synthetic-integrated-camera", "warningAudio": True, "warningVisibility": "enhanced"}
    try:
        with publisher.begin() as connection:
            connection.execute(text("""
                INSERT INTO rafiq_fixture.controlled_use_publication (singleton, version, conditions)
                VALUES (true, :version, CAST(:conditions AS jsonb))
            """), {"version": version, "conditions": json.dumps(CONDITIONS)})
        subject_a, driver_a = session()
        _, driver_b = session()
        assert client.get(preferences).status_code == 401
        assert client.put(preferences, json=enhanced).status_code == 401
        assert client.get(preferences, headers=driver_a).json()["code"] == "controlled_use_required"
        assert client.put(preferences, headers=driver_a, json=enhanced).status_code == 403
        for driver in (driver_a, driver_b):
            assert client.put(ACCOUNT + "/controlled-use", headers=driver,
                              json={"version": version, "accepted": True}).status_code == 200
        initial = client.get(preferences, headers=driver_a)
        assert initial.status_code == 200
        assert initial.headers["cache-control"] == "private, no-store"
        assert initial.json() == default
        saved = client.put(preferences, headers=driver_a, json=enhanced)
        assert saved.status_code == 200
        assert saved.headers["cache-control"] == "private, no-store"
        assert saved.json() == enhanced
        assert client.get(preferences, headers=session(subject=subject_a)[1]).json() == enhanced
        assert client.get(preferences, headers=driver_b).json() == default

        for invalid in (
            {"warningAudio": True},
            {**enhanced, "warningAudio": "false"},
            {**enhanced, "warningVisibility": "bright"},
            {**enhanced, "cameraDeviceId": ""},
            {**enhanced, "cameraDeviceId": "x" * 129},
            {**enhanced, "cameraDeviceId": "\x00"},
            {**enhanced, "accountId": "another-driver"},
            {**enhanced, "warningPolicy": {"severity": "off", "dwellMs": 0}},
        ):
            rejected = client.put(preferences, headers=driver_a, json=invalid)
            assert rejected.status_code == 422
            assert rejected.headers["content-type"] == "application/problem+json"
            assert "another-driver" not in rejected.text
        assert client.get(preferences, headers=driver_a).json() == enhanced
        assert client.put(preferences, headers=driver_b, json={**default, "warningAudio": True}).status_code == 200
        assert client.put(preferences, headers=driver_a, json=default).json() == default
        assert client.get(preferences, headers=driver_b).json() == {**default, "warningAudio": True}
        client.app.state.synthetic_users[subject_a]["banned"] = True
        assert client.get(preferences, headers=driver_a).status_code == 403
        assert client.put(preferences, headers=driver_a, json=enhanced).status_code == 403
    finally:
        with publisher.begin() as connection:
            connection.execute(text("DELETE FROM rafiq_fixture.controlled_use_publication"))
        publisher.dispose()


def test_recording_consent_defaults_replay_and_withdrawal_fence(accounts, published_conditions):
    client, session, _ = accounts
    owner, headers = session()
    _, other = session()
    path = "/api/v1/recording-consent"
    assert client.get(path).status_code == 401
    assert client.get(path, headers=headers).status_code == 403
    for driver in (headers, other):
        assert client.put(ACCOUNT + "/controlled-use", headers=driver,
                          json={"version": "controlled-use-1", "accepted": True}).status_code == 200

    initial = client.get(path, headers=headers)
    assert initial.status_code == 200
    assert initial.headers["cache-control"] == "private, no-store"
    default = {"enabled": False, "behaviors": [], "preSeconds": 3, "postSeconds": 3}
    assert initial.json()["settings"] == default
    assert initial.json()["catalog"] == {
        "version": "phase-1-fixture-1",
        "behaviors": {
            "drowsiness": "Drowsiness", "distraction": "Distraction", "phoneUse": "Phone use",
            "eating": "Eating", "drinking": "Drinking",
        },
    }

    def change(revision, settings):
        return client.put(path, headers=headers, json={"expectedRevision": revision, "settings": settings})

    start = initial.json()["revision"]
    for invalid in ({"preSeconds": -1}, {"postSeconds": 6}, {"postSeconds": 1.5},
                    {"preSeconds": True}, {"behaviors": ["reaching"]}, {"behaviors": ["eating", "eating"]}):
        assert change(start, {**default, **invalid}).status_code == 422

    allowed = {"enabled": True, "behaviors": []}
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(lambda _: change(start, allowed), range(4)))
    assert all(response.status_code == 200 for response in responses)
    acknowledged = responses[0].json()
    assert all(response.json() == acknowledged for response in responses)
    assert acknowledged["revision"] != start
    assert acknowledged["settings"] == {**default, "enabled": True}
    assert client.get(path, headers=session(subject=owner)[1]).json() == acknowledged
    assert client.get(path, headers=other).json()["settings"] == default

    revision = acknowledged["revision"]
    updated = {**allowed, "behaviors": ["phoneUse"], "preSeconds": 0, "postSeconds": 5}
    withdrawn = {**acknowledged["settings"], "enabled": False}
    with ThreadPoolExecutor(max_workers=2) as pool:
        edit = pool.submit(change, revision, updated)
        stop = pool.submit(change, revision, withdrawn)
        edit, stop = edit.result(), stop.result()
    assert sorted([edit.status_code, stop.status_code]) == [200, 409]
    if stop.status_code == 409:
        current = client.get(path, headers=headers).json()
        withdrawn = {**current["settings"], "enabled": False}
        revision = current["revision"]
        stop = change(revision, withdrawn)
    assert stop.json()["settings"] == withdrawn
    assert change(revision, withdrawn).json() == stop.json()
    assert change(start, allowed).status_code == 409
    assert change(acknowledged["revision"], updated).status_code == 409
    assert client.get(path, headers=headers).json() == stop.json()

    # Withdrawal while already off still fences a delayed enable based on that revision.
    assert change(stop.json()["revision"], withdrawn).status_code == 200
    assert change(stop.json()["revision"], allowed).status_code == 409



def test_recording_publication_gate_rejects_captures_from_before_withdrawal(accounts, published_conditions):
    from fixture.recording_consent import admits_recording_revision

    client, session, engine = accounts
    subject, headers = session()
    other_subject, other_headers = session()
    path = "/api/v1/recording-consent"
    for driver in (headers, other_headers):
        assert client.put(ACCOUNT + "/controlled-use", headers=driver,
                          json={"version": "controlled-use-1", "accepted": True}).status_code == 200
    account_id = client.get(ACCOUNT, headers=headers).json()["accountId"]

    def update(settings):
        current = client.get(path, headers=headers).json()
        response = client.put(path, headers=headers,
                              json={"expectedRevision": current["revision"], "settings": settings})
        assert response.status_code == 200
        return response.json()

    def eligible(consent, behavior, driver=subject):
        # The configured synthetic session retained the authorized category snapshot.
        if behavior not in consent["settings"]["behaviors"]:
            return False
        with engine.begin() as connection:
            connection.execute(text("SELECT set_config('rafiq.driver_subject', :subject, true)"), {"subject": driver})
            return admits_recording_revision(connection, account_id, consent["revision"])

    empty = update({"enabled": True, "behaviors": []})
    assert not eligible(empty, "drowsiness")
    captured = update({"enabled": True, "behaviors": ["drowsiness"]})
    assert eligible(captured, "drowsiness")
    assert not eligible(captured, "drowsiness", other_subject)
    later = update({"enabled": True, "behaviors": ["eating"]})
    assert eligible(captured, "drowsiness")
    assert not eligible(later, "drowsiness")
    update({**later["settings"], "enabled": False})
    assert not eligible(captured, "drowsiness")
    assert not eligible(later, "eating")
    reenabled = update({"enabled": True, "behaviors": ["drowsiness"]})
    assert eligible(reenabled, "drowsiness")
    assert not eligible(captured, "drowsiness")
