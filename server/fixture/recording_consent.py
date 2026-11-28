"""M04 owner-scoped recording decision and withdrawal fence."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import text
from sqlalchemy.engine import Connection

# Phase 1 baseline from the API Behavior catalog and PRD §8.3. Reaching requires qualification.
Behavior = Literal["drowsiness", "distraction", "phoneUse", "eating", "drinking"]
Seconds = Annotated[int, Field(ge=0, le=5)]


class RecordingSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    enabled: bool
    behaviors: list[Behavior] = Field(max_length=30)
    preSeconds: Seconds = 3
    postSeconds: Seconds = 3

    @field_validator("behaviors")
    @classmethod
    def unique_behaviors(cls, values: list[Behavior]) -> list[Behavior]:
        if len(set(values)) != len(values):
            raise ValueError("Recording behaviors must be unique")
        return sorted(values)


class RecordingChange(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    expectedRevision: str = Field(min_length=1, max_length=64)
    settings: RecordingSettings


class RecordingConsent(BaseModel):
    revision: str
    settings: RecordingSettings


class RecordingConflict(Exception):
    pass


def revision_token(revision: int) -> str:
    return f"consent-{revision}"


def recording_consent(
    connection: Connection, account_id: UUID, change: RecordingChange | None = None,
) -> RecordingConsent:
    # Serialize edits against each other and against publication admission.
    statement = """
        SELECT recording_revision, recording_settings FROM rafiq_fixture.driver_accounts
        WHERE id = :id AND NOT restricted
    """
    if change is not None:
        statement += " FOR UPDATE"
    row = connection.execute(text(statement), {"id": account_id}).mappings().one()
    revision = row["recording_revision"]
    settings = RecordingSettings.model_validate(row["recording_settings"])
    if change is None:
        return RecordingConsent(revision=revision_token(revision), settings=settings)
    if revision > 0 and change.expectedRevision == revision_token(revision - 1) and change.settings == settings:
        return RecordingConsent(revision=revision_token(revision), settings=settings)
    if change.expectedRevision != revision_token(revision):
        raise RecordingConflict()

    revision += 1
    connection.execute(text("""
        UPDATE rafiq_fixture.driver_accounts SET
            recording_revision = :revision,
            recording_withdrawal_revision = CASE WHEN :enabled THEN recording_withdrawal_revision ELSE :revision END,
            recording_settings = CAST(:settings AS jsonb)
        WHERE id = :id AND NOT restricted
    """), {"id": account_id, "revision": revision, "enabled": change.settings.enabled,
           "settings": change.settings.model_dump_json()})
    return RecordingConsent(revision=revision_token(revision), settings=change.settings)


def admits_recording_revision(connection: Connection, account_id: UUID, capture_revision: str) -> bool:
    """Check an owned, previously authorized capture revision inside the publication transaction.

    The caller owns session snapshot, category matching, expiry, and publication checks.
    Keep this transaction open through the durable publication decision.
    """
    prefix = "consent-"
    digits = capture_revision.removeprefix(prefix)
    if not capture_revision.startswith(prefix) or not digits.isascii() or not digits.isdecimal() or len(digits) > 19:
        return False
    revision = int(digits)
    if capture_revision != revision_token(revision):
        return False
    row = connection.execute(text("""
        SELECT recording_revision, recording_withdrawal_revision, recording_settings
        FROM rafiq_fixture.driver_accounts WHERE id = :id AND NOT restricted FOR SHARE
    """), {"id": account_id}).mappings().one_or_none()
    return bool(row and row["recording_settings"]["enabled"]
                and row["recording_withdrawal_revision"] < revision <= row["recording_revision"])
