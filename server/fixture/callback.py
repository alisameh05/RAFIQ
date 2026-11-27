"""Authenticate the raw Clerk/Svix envelope before inspecting its event."""

import hashlib
import json
import re

from svix.webhooks import Webhook, WebhookVerificationError

IDENTITY_EVENTS = ("user.created", "user.updated", "user.deleted")


class InvalidCallback(ValueError):
    pass


def verify_envelope(body: bytes, headers: dict[str, str], secret: str, instance_id: str) -> tuple[str, dict]:
    event_id = headers.get("svix-id", "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", event_id):
        raise InvalidCallback
    try:
        Webhook(secret).verify(body, headers)
        event = json.loads(body)
    except (WebhookVerificationError, ValueError, TypeError, UnicodeDecodeError) as exc:
        raise InvalidCallback from exc
    if (
        not isinstance(event, dict) or event.get("object") != "event"
        or event.get("instance_id") != instance_id or not isinstance(event.get("type"), str)
        or not 1 <= len(event["type"]) <= 160 or not isinstance(event.get("data"), dict)
    ):
        raise InvalidCallback
    return event_id, event


def verify_callback(body: bytes, headers: dict[str, str], secret: str, instance_id: str) -> tuple[str, str]:
    """Preserve the identity-event-only receipts for the Phase 0 validation surface."""
    event_id, event = verify_envelope(body, headers, secret, instance_id)
    if event["type"] not in IDENTITY_EVENTS:
        raise InvalidCallback
    return event_id, hashlib.sha256(body).hexdigest()
