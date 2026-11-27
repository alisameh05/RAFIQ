"""Reconcile Clerk lifecycle using the separate callback database principal."""

from collections.abc import Callable
from dataclasses import dataclass, field
import hashlib
import re

from sqlalchemy import text
from sqlalchemy.engine import Engine
from svix.webhooks import Webhook

from fixture.callback import IDENTITY_EVENTS, InvalidCallback, verify_envelope
from fixture.database import ACCOUNT_SCHEMA_REVISION, schema_revision

SUBJECT = re.compile(r"user_[A-Za-z0-9]{1,128}")
MAX_REVISION = 2**63 - 1


@dataclass(frozen=True)
class ClerkCallback:
    engine: Engine
    instance_id: str
    secret: str = field(repr=False)

    def __post_init__(self):
        if not re.fullmatch(r"ins_[A-Za-z0-9_]{1,128}", self.instance_id) or not self.secret.startswith("whsec_"):
            raise ValueError("Clerk callback requires an instance ID and signing secret")
        Webhook(self.secret)

    def receive(self, body: bytes, headers: dict[str, str], lookup_user: Callable[[str], dict | None]) -> None:
        event_id, event = verify_envelope(body, headers, self.secret, self.instance_id)
        if event["type"] not in IDENTITY_EVENTS:
            return
        subject = event["data"].get("id")
        if not isinstance(subject, str) or not SUBJECT.fullmatch(subject):
            raise InvalidCallback
        digest = hashlib.sha256(body).hexdigest()
        with self.engine.begin() as connection:
            if schema_revision(connection, "callback") != ACCOUNT_SCHEMA_REVISION:
                raise LifecycleUnavailable
            inserted = connection.execute(text("""
                INSERT INTO rafiq_fixture.clerk_callback_receipts (event_id, body_sha256)
                VALUES (:id, :digest) ON CONFLICT (event_id) DO NOTHING
            """), {"id": event_id, "digest": digest})
            if inserted.rowcount == 0:
                existing = connection.execute(text("""
                    SELECT body_sha256 FROM rafiq_fixture.clerk_callback_receipts WHERE event_id = :id
                """), {"id": event_id}).scalar_one()
                if existing != digest:
                    raise InvalidCallback
                return

            lock_identity(connection, subject, shared=False)
            current = identity_lifecycle(connection, subject)
            if current and current["state"] == "deleted":
                return

            # Ignore older deliveries. Only a current update can release a known ban.
            event_revision = event["data"].get("updated_at")
            if current and event["type"] != "user.deleted" and (
                not valid_revision(event_revision) or event_revision < current["provider_revision"]
            ):
                return

            user = lookup_user(subject)
            if user is None:
                if event["type"] != "user.deleted":
                    raise LifecycleUnavailable
                state, revision = "deleted", current["provider_revision"] if current else 0
            else:
                if user.get("id") != subject or not valid_revision(user.get("updated_at")):
                    raise LifecycleUnavailable
                if event["type"] == "user.deleted":
                    return
                revision = user["updated_at"]
                if valid_revision(event_revision) and revision < event_revision:
                    raise LifecycleUnavailable
                state = "restricted" if user.get("banned") or user.get("locked") else "active"
            cutoff = current["fresh_session_after"] if current else 0
            if current:
                if revision < current["provider_revision"]:
                    return
                if current["state"] == "restricted" and state == "active":
                    if revision == current["provider_revision"] or event_revision != revision:
                        return
                    cutoff = max(cutoff, revision)
            connection.execute(text("""
                INSERT INTO rafiq_fixture.driver_identity_lifecycle
                    (clerk_subject, state, provider_revision, fresh_session_after)
                VALUES (:subject, :state, :revision, :cutoff)
                ON CONFLICT (clerk_subject) DO UPDATE SET state = excluded.state,
                    provider_revision = excluded.provider_revision, fresh_session_after = excluded.fresh_session_after
            """), {"subject": subject, "state": state, "revision": revision, "cutoff": cutoff})


class LifecycleUnavailable(RuntimeError):
    pass


def valid_revision(value: object) -> bool:
    return type(value) is int and 0 < value <= MAX_REVISION


def lock_identity(connection, subject: str, *, shared: bool) -> None:
    statement = (
        "SELECT pg_advisory_xact_lock_shared(hashtextextended(:subject, 6140))" if shared
        else "SELECT pg_advisory_xact_lock(hashtextextended(:subject, 6140))"
    )
    connection.execute(text(statement), {"subject": subject})


def identity_lifecycle(connection, subject: str):
    return connection.execute(text("""
        SELECT state, provider_revision, fresh_session_after
        FROM rafiq_fixture.driver_identity_lifecycle WHERE clerk_subject = :subject
    """), {"subject": subject}).mappings().one_or_none()
