"""Verify Clerk delivery for the isolated synthetic validation fixture only."""

import hashlib
import json
import re

from svix.webhooks import Webhook, WebhookVerificationError


class InvalidCallback(ValueError):
    pass


def verify_callback(body: bytes, headers: dict[str, str], secret: str, instance_id: str) -> tuple[str, str]:
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
        or event.get("instance_id") != instance_id
        or event.get("type") not in ("user.created", "user.updated", "user.deleted")
        or not isinstance(event.get("data"), dict)
    ):
        raise InvalidCallback
    return event_id, hashlib.sha256(body).hexdigest()
