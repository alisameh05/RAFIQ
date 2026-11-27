"""Identity boundary for the local and isolated hosted synthetic fixture."""

from dataclasses import dataclass
import re
from types import SimpleNamespace
from urllib.parse import urlsplit

from clerk_backend_api import AuthenticateRequestOptions, authenticate_request
from cryptography.hazmat.primitives.serialization import load_pem_public_key
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey


def https_origin(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
        or parsed.path not in ("", "/") or parsed.query or parsed.fragment
        or value.rstrip("/") != f"https://{parsed.netloc}"
    ):
        raise ValueError("Hosted fixture requires an explicit HTTPS origin")
    try:
        parsed.port
    except ValueError as exc:
        raise ValueError("Invalid HTTPS origin port") from exc
    return value.rstrip("/")


def verification_key(value: str) -> str:
    jwt_key = value.replace("\\n", "\n")
    try:
        key = load_pem_public_key(jwt_key.encode("ascii"))
    except (ValueError, TypeError, UnicodeEncodeError) as exc:
        raise ValueError("A valid RSA verification key is required") from exc
    if not isinstance(key, RSAPublicKey) or key.key_size < 2048:
        raise ValueError("A valid RSA verification key is required")
    return jwt_key


def session_claims(authorization: str | None, web_origin: str, issuer: str, jwt_key: str) -> dict | None:
    if not authorization or not authorization.startswith("Bearer ") or len(authorization) > 8192:
        return None
    request = SimpleNamespace(headers={"Authorization": authorization})
    try:
        state = authenticate_request(request, AuthenticateRequestOptions(
            jwt_key=jwt_key,
            authorized_parties=[web_origin],
            accepts_token=["session_token"],
            clock_skew_in_ms=0,
        ))
    except (ValueError, TypeError):
        return None
    claims = state.payload if state.is_signed_in else None
    if not isinstance(claims, dict) or claims.get("iss") != issuer:
        return None
    if not all(type(claims.get(name)) is int for name in ("exp", "iat", "nbf")):
        return None
    if not isinstance(claims.get("sid"), str) or not claims["sid"]:
        return None
    return claims


@dataclass(frozen=True)
class FixtureIdentity:
    mode: str
    web_origin: str
    issuer: str = ""
    jwt_key: str = ""
    driver_a: str = ""
    driver_b: str = ""

    @classmethod
    def from_environment(cls, env):
        mode = env.get("RAFIQ_MODE")
        if mode == "local-fixture":
            return cls(mode=mode, web_origin="http://127.0.0.1:3000")
        if mode != "hosted-validation":
            raise ValueError("Explicit fixture mode is required")
        web_origin = https_origin(env.get("RAFIQ_WEB_ORIGIN", ""))
        issuer = https_origin(env.get("CLERK_ISSUER", ""))
        jwt_key = env.get("CLERK_JWT_KEY", "").replace("\\n", "\n")
        driver_a = env.get("RAFIQ_VALIDATION_DRIVER_A", "")
        driver_b = env.get("RAFIQ_VALIDATION_DRIVER_B", "")
        if (not jwt_key or not all(re.fullmatch(r"user_[A-Za-z0-9_]{1,128}", subject)
                                   for subject in (driver_a, driver_b)) or driver_a == driver_b):
            raise ValueError("Hosted fixture requires a public verification key and two distinct test subjects")
        jwt_key = verification_key(jwt_key)
        return cls(mode, web_origin, issuer, jwt_key, driver_a, driver_b)

    def owner_for(self, authorization: str | None) -> str | None:
        if self.mode == "local-fixture":
            return {"Bearer local-driver-a": "driver-a", "Bearer local-driver-b": "driver-b"}.get(authorization)
        claims = session_claims(authorization, self.web_origin, self.issuer, self.jwt_key)
        if claims is None:
            return None
        subject = claims.get("sub")
        if subject == self.driver_a:
            return "driver-a"
        if subject == self.driver_b:
            return "driver-b"
        return None
