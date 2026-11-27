"""Phase 1 account entry. Clerk owns credentials, verification and session state."""

from collections.abc import Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
import os
import re
from typing import Annotated
from uuid import UUID, uuid4

import httpx
from fastapi import FastAPI, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError

from fixture.database import engine_for, schema_ready
from fixture.identity import https_origin, session_claims, verification_key

SUBJECT = re.compile(r"user_[A-Za-z0-9]{1,128}")
SESSION = re.compile(r"sess_[A-Za-z0-9]{1,128}")
CLERK_API = "https://api.clerk.com/v1/"


@dataclass(frozen=True)
class AccountSettings:
    web_origin: str
    issuer: str
    jwt_key: str
    secret_key: str = field(repr=False)
    required_version: str
    support_contact: str | None = None

    @classmethod
    def from_environment(cls, env: Mapping[str, str]):
        web_origin = env.get("RAFIQ_WEB_ORIGIN", "")
        if web_origin != "http://127.0.0.1:3000" or env.get("RAFIQ_MODE") != "local-fixture":
            web_origin = https_origin(web_origin)
        issuer = https_origin(env.get("CLERK_ISSUER", ""))
        secret = env.get("CLERK_SECRET_KEY", "")
        required_version = env.get("RAFIQ_CONTROLLED_USE_VERSION", "")
        if not secret.startswith(("sk_test_", "sk_live_")) or not 1 <= len(required_version) <= 64:
            raise ValueError("Account entry requires Clerk credentials and the controlled-use version")
        if env.get("RAFIQ_MODE") == "local-fixture" and not secret.startswith("sk_test_"):
            raise ValueError("Local account entry requires a Clerk development instance")
        support_contact = env.get("RAFIQ_SUPPORT_CONTACT") or None
        if support_contact and not re.fullmatch(r"[^\s@]{1,64}@[^\s@]{1,189}", support_contact):
            raise ValueError("The support contact must be an email address")
        return cls(web_origin, issuer, verification_key(env.get("CLERK_JWT_KEY", "")), secret,
                   required_version, support_contact)


class Account(BaseModel):
    accountId: UUID
    status: str
    displayName: str | None
    registeredEmail: str
    verified: bool
    acceptedVersion: str | None
    requiredVersion: str
    supportContact: str | None = None


class AccountProblem(Exception):
    def __init__(self, status: int, code: str, title: str, detail: str | None = None):
        self.status, self.code, self.title, self.detail = status, code, title, detail


def sign_in_required() -> AccountProblem:
    return AccountProblem(401, "authentication_required", "Sign in to continue")


def unavailable() -> AccountProblem:
    return AccountProblem(503, "account_unavailable", "Account status is temporarily unavailable")


def restricted(settings: AccountSettings) -> AccountProblem:
    detail = f"Contact RAFIQ support at {settings.support_contact}." if settings.support_contact else None
    return AccountProblem(403, "account_restricted", "Account restricted", detail)


def clerk_record(provider: httpx.Client, settings: AccountSettings, path: str) -> dict:
    try:
        response = provider.get(path, headers={"Authorization": f"Bearer {settings.secret_key}"})
        if response.status_code == 404:
            raise sign_in_required()
        response.raise_for_status()
        record = response.json()
    except (httpx.HTTPError, ValueError):
        raise unavailable() from None
    if not isinstance(record, dict):
        raise unavailable()
    return record


def verified_identity(authorization: str | None, settings: AccountSettings,
                      provider: httpx.Client) -> tuple[str, str]:
    claims = session_claims(authorization, settings.web_origin, settings.issuer, settings.jwt_key)
    if claims is None or claims.get("azp") != settings.web_origin or claims.get("sts") not in (None, "active"):
        raise sign_in_required()
    subject, sid = claims.get("sub"), claims["sid"]
    if not isinstance(subject, str) or not SUBJECT.fullmatch(subject) or not SESSION.fullmatch(sid):
        raise sign_in_required()

    session = clerk_record(provider, settings, f"sessions/{sid}")
    if session.get("id") != sid or session.get("user_id") != subject or session.get("status") != "active":
        raise sign_in_required()
    user = clerk_record(provider, settings, f"users/{subject}")
    if user.get("id") != subject:
        raise sign_in_required()
    if user.get("banned") or user.get("locked"):
        raise restricted(settings)
    primary_id, addresses = user.get("primary_email_address_id"), user.get("email_addresses")
    if isinstance(primary_id, str) and isinstance(addresses, list):
        for address in addresses:
            if not isinstance(address, dict) or address.get("id") != primary_id:
                continue
            email, verification = address.get("email_address"), address.get("verification")
            if (isinstance(email, str) and "@" in email and isinstance(verification, dict)
                    and verification.get("status") == "verified"):
                return subject, email
    raise AccountProblem(403, "verification_required", "Verify your email to continue")


def resolve_account(engine: Engine, subject: str, email: str, settings: AccountSettings) -> Account:
    try:
        with engine.begin() as connection:
            if not schema_ready(connection, "api"):
                raise unavailable()
            connection.execute(
                text("SELECT set_config('rafiq.driver_subject', :subject, true)"), {"subject": subject}
            )
            connection.execute(text("""
                INSERT INTO rafiq_fixture.driver_accounts (clerk_subject) VALUES (:subject)
                ON CONFLICT (clerk_subject) DO NOTHING
            """), {"subject": subject})
            row = connection.execute(text("""
                SELECT id, restricted, display_name, accepted_version FROM rafiq_fixture.driver_accounts
                WHERE clerk_subject = :subject
            """), {"subject": subject}).mappings().one()
            if row["restricted"]:
                raise restricted(settings)
    except SQLAlchemyError:
        raise unavailable() from None
    return Account(
        accountId=row["id"],
        status="active" if row["accepted_version"] == settings.required_version else "onboardingRequired",
        displayName=row["display_name"], registeredEmail=email, verified=True,
        acceptedVersion=row["accepted_version"], requiredVersion=settings.required_version,
    )


def create_account_app(settings: AccountSettings, engine: Engine, provider: httpx.Client | None = None):
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if provider is not None:
            app.state.clerk = provider
            yield
        else:
            with httpx.Client(base_url=CLERK_API, timeout=4, trust_env=False) as clerk:
                app.state.clerk = clerk
                yield

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(CORSMiddleware, allow_origins=[settings.web_origin], allow_methods=["GET"],
                       allow_headers=["Authorization"], expose_headers=["X-Request-Id"])

    @app.middleware("http")
    async def prevent_caching(request: Request, call_next):
        request.state.request_id = str(uuid4())
        response = await call_next(request)
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["X-Request-Id"] = request.state.request_id
        return response

    @app.exception_handler(AccountProblem)
    async def account_problem(request: Request, error: AccountProblem):
        payload = {"type": "about:blank", "title": error.title, "status": error.status,
                   "code": error.code, "requestId": request.state.request_id}
        if error.detail:
            payload["detail"] = error.detail
        return JSONResponse(
            payload,
            status_code=error.status, media_type="application/problem+json",
            headers={"WWW-Authenticate": "Bearer"} if error.status == 401 else None,
        )

    @app.get("/internal/livez")
    def live():
        return {"status": "live"}

    @app.get("/internal/readyz")
    def ready():
        try:
            with engine.connect() as connection:
                if schema_ready(connection, "api"):
                    return {"status": "ready"}
        except SQLAlchemyError:
            pass
        raise unavailable()

    @app.get("/api/v1/account", operation_id="getAccount", response_model=Account)
    def get_account(request: Request, authorization: Annotated[str | None, Header()] = None):
        subject, email = verified_identity(authorization, settings, request.app.state.clerk)
        return resolve_account(engine, subject, email, settings)

    return app


def from_environment():
    return create_account_app(AccountSettings.from_environment(os.environ), engine_for("api"))
