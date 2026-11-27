from concurrent.futures import ThreadPoolExecutor
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

from fixture.accounts import AccountSettings, create_account_app
from fixture.database import engine_for

WEB = "https://entry.example"
ISSUER = "https://identity.example"
ACCOUNT = "/api/v1/account"
TABLE = "rafiq_fixture.driver_accounts"


@pytest.fixture
def accounts():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode()
    settings = AccountSettings(WEB, ISSUER, public, "sk_test_synthetic", "controlled-use-1", "support@example.net")
    engine = engine_for("api")
    subjects = {}

    def session(*, verified=True, status="active", banned=False, claims=None):
        subject = f"user_{uuid4().hex}"
        sid = f"sess_{uuid4().hex}"
        subjects[sid] = (subject, verified, status, banned)
        now = int(time())
        token = jwt.encode({
            "iss": ISSUER, "azp": WEB, "sub": subject, "sid": sid,
            "iat": now, "nbf": now - 1, "exp": now + 60, **(claims or {}),
        }, key, algorithm="RS256")
        return subject, {"Authorization": f"Bearer {token}"}

    def clerk(request):
        assert request.headers["authorization"] == "Bearer sk_test_synthetic"
        identifier = request.url.path.rsplit("/", 1)[1]
        if request.url.path.startswith("/v1/sessions/"):
            subject, _, status, _ = subjects[identifier]
            return httpx.Response(200, json={"id": identifier, "user_id": subject, "status": status})
        _, verified, _, banned = next(entry for entry in subjects.values() if entry[0] == identifier)
        return httpx.Response(200, json={
            "id": identifier, "primary_email_address_id": "idn_primary", "banned": banned,
            "email_addresses": [
                {"id": "idn_secondary", "email_address": "secondary@example.net",
                 "verification": {"status": "verified"}},
                {"id": "idn_primary", "email_address": "driver@example.net",
                 "verification": {"status": "verified" if verified else "unverified"}},
            ],
        })

    with httpx.Client(transport=httpx.MockTransport(clerk), base_url="https://api.clerk.com/v1/") as provider:
        with TestClient(create_account_app(settings, engine, provider)) as client:
            yield client, session, engine
    engine.dispose()


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
