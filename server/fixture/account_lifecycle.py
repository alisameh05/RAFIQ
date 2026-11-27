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
        snapshot = event["data"]
        snapshot_revision = snapshot.get("updated_at")
        if not valid_revision(snapshot_revision):
            snapshot_revision = None
        snapshot_restricted = restriction_snapshot(snapshot)
        with self.engine.begin() as connection:
            if schema_revision(connection, "callback") != ACCOUNT_SCHEMA_REVISION:
                raise LifecycleUnavailable
            inserted = connection.execute(text("""
                INSERT INTO rafiq_fixture.clerk_callback_receipts
                    (event_id, body_sha256, clerk_subject, snapshot_revision, snapshot_restricted)
                VALUES (:id, :digest, :subject, :revision, :restricted) ON CONFLICT (event_id) DO NOTHING
            """), {"id": event_id, "digest": digest, "subject": subject,
                   "revision": snapshot_revision, "restricted": snapshot_restricted})
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

            cutoff = current["fresh_session_after"] if current else 0
            last_restriction = current["restriction_revision"] if current else 0
            deletion = event["type"] == "user.deleted"
            new_restriction = (
                not deletion and snapshot_restricted is True
                and snapshot_revision is not None and snapshot_revision > last_restriction
            )
            earlier_restoration = (
                snapshot_restricted is False and snapshot_revision is not None
                and last_restriction < snapshot_revision < cutoff
            )
            # Older signed snapshots can complete a known restriction timeline.
            if current and not (deletion or new_restriction or earlier_restoration) and (
                snapshot_revision is None or snapshot_revision < current["provider_revision"]
            ):
                return

            user = lookup_user(subject)
            if user is None:
                if not deletion:
                    raise LifecycleUnavailable
                deletion_revision = event.get("timestamp")
                revision = max(
                    current["provider_revision"] if current else 0,
                    deletion_revision if valid_revision(deletion_revision) else 0,
                )
                state = "deleted"
            else:
                if user.get("id") != subject or not valid_revision(user.get("updated_at")):
                    raise LifecycleUnavailable
                if deletion:
                    # The signed event and provider read disagree. Leave this delivery retryable.
                    raise LifecycleUnavailable
                revision = user["updated_at"]
                if snapshot_revision is not None and revision < snapshot_revision:
                    raise LifecycleUnavailable
                state = "restricted" if user.get("banned") or user.get("locked") else "active"
            if current and revision < current["provider_revision"]:
                return
            if new_restriction:
                last_restriction = snapshot_revision
            if state == "restricted":
                last_restriction = max(last_restriction, revision)
            if state == "active" and last_restriction:
                restoration = first_active_snapshot(connection, subject, last_restriction, revision)
                was_restricted = current and current["state"] == "restricted"
                if was_restricted and not restoration and (
                    snapshot_revision != revision or revision <= last_restriction
                ):
                    return
                if restoration is not None:
                    cutoff = restoration
                elif new_restriction or was_restricted:
                    # Hold earlier sessions while waiting for a signed restoring snapshot.
                    cutoff = revision
            connection.execute(text("""
                INSERT INTO rafiq_fixture.driver_identity_lifecycle
                    (clerk_subject, state, provider_revision, restriction_revision, fresh_session_after)
                VALUES (:subject, :state, :revision, :restriction, :cutoff)
                ON CONFLICT (clerk_subject) DO UPDATE SET state = excluded.state,
                    provider_revision = excluded.provider_revision, restriction_revision = excluded.restriction_revision,
                    fresh_session_after = excluded.fresh_session_after
            """), {"subject": subject, "state": state, "revision": revision,
                   "restriction": last_restriction, "cutoff": cutoff})


class LifecycleUnavailable(RuntimeError):
    pass


def valid_revision(value: object) -> bool:
    return type(value) is int and 0 < value <= MAX_REVISION


def restriction_snapshot(user: dict) -> bool | None:
    if user.get("banned") is True or user.get("locked") is True:
        return True
    if user.get("banned") is False and user.get("locked") is False:
        return False
    return None


def first_active_snapshot(connection, subject: str, restriction: int, revision: int) -> int | None:
    return connection.execute(text("""
        SELECT min(snapshot_revision) FROM rafiq_fixture.clerk_callback_receipts
        WHERE clerk_subject = :subject AND snapshot_restricted IS FALSE
          AND snapshot_revision > :restriction AND snapshot_revision <= :revision
    """), {"subject": subject, "restriction": restriction, "revision": revision}).scalar_one()


def lock_identity(connection, subject: str, *, shared: bool) -> None:
    statement = (
        "SELECT pg_advisory_xact_lock_shared(hashtextextended(:subject, 6140))" if shared
        else "SELECT pg_advisory_xact_lock(hashtextextended(:subject, 6140))"
    )
    connection.execute(text(statement), {"subject": subject})


def identity_lifecycle(connection, subject: str):
    return connection.execute(text("""
        SELECT state, provider_revision, restriction_revision, fresh_session_after
        FROM rafiq_fixture.driver_identity_lifecycle WHERE clerk_subject = :subject
    """), {"subject": subject}).mappings().one_or_none()
