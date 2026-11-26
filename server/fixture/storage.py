"""Scoped, bounded retrieval of a private synthetic validation object."""

from urllib.parse import quote, urlsplit

import httpx


class StorageUnavailable(Exception):
    pass


class StorageDenied(Exception):
    pass


def fetch_validation_object(origin: str, publishable_key: str, subject: str, token: str, *, transport=None) -> bytes:
    parsed = urlsplit(origin)
    if (
        parsed.scheme != "https" or not parsed.hostname or not parsed.hostname.endswith(".supabase.co")
        or parsed.netloc != parsed.hostname or parsed.path not in ("", "/") or parsed.query or parsed.fragment
        or not publishable_key.startswith("sb_publishable_") or not subject or not token.startswith("Bearer ")
    ):
        raise StorageUnavailable
    url = (f"{origin.rstrip('/')}/storage/v1/object/authenticated/rafiq-validation-fixtures/"
           f"{quote(subject, safe='')}/private-access-check.txt")
    try:
        with httpx.Client(timeout=5.0, follow_redirects=False, trust_env=False, transport=transport) as client:
            with client.stream("GET", url, headers={"apikey": publishable_key, "Authorization": token}) as response:
                if response.status_code in (400, 401, 403, 404):
                    raise StorageDenied
                if response.status_code != 200:
                    raise StorageUnavailable
                data = bytearray()
                for chunk in response.iter_bytes():
                    if len(data) + len(chunk) > 1024:
                        raise StorageUnavailable
                    data.extend(chunk)
                return bytes(data)
    except httpx.HTTPError as exc:
        raise StorageUnavailable from exc
