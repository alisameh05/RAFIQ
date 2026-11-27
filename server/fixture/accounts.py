"""Phase 1 account entry. Clerk owns credentials, verification and session state."""

from collections.abc import Mapping
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass, field
import os
import re
from typing import Annotated, Literal
from uuid import UUID, uuid4

import httpx
from fastapi import FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool, ValidationError
from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError

from fixture.database import ACCOUNT_SCHEMA_REVISION, ACCOUNT_SCHEMA_REVISIONS, engine_for, schema_ready, schema_revision
from fixture.identity import https_origin, session_claims, verification_key

SUBJECT = re.compile(r"user_[A-Za-z0-9]{1,128}")
SESSION = re.compile(r"sess_[A-Za-z0-9]{1,128}")
CLERK_API = "https://api.clerk.com/v1/"
PUBLICATION_LOCK = 27001


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


class Conditions(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    version: str = Field(min_length=1, max_length=64)
    stationary: str = Field(min_length=1, max_length=1000)
    supervised: str = Field(min_length=1, max_length=1000)
    camera: str = Field(min_length=1, max_length=1000)
    recording: str = Field(min_length=1, max_length=1000)


class Acceptance(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: str = Field(min_length=1, max_length=64)
    accepted: StrictBool


class DriverEntryContext(BaseModel):
    destination: Literal["dashboard", "readiness"]
    accountId: UUID
    acceptedVersion: str


class AccountProblem(Exception):
    def __init__(self, status: int, code: str, title: str, support_contact: str | None = None,
                 *, field_errors: list[dict[str, str]] | None = None):
        self.status = status
        self.code = code
        self.title = title
        self.support_contact = support_contact
        self.field_errors = field_errors


def sign_in_required() -> AccountProblem:
    return AccountProblem(401, "authentication_required", "Sign in to continue")


def unavailable() -> AccountProblem:
    return AccountProblem(503, "account_unavailable", "Account status is temporarily unavailable")


def restricted(settings: AccountSettings) -> AccountProblem:
    return AccountProblem(403, "account_restricted", "Account access restricted", settings.support_contact)


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


@contextmanager
def account_access(engine: Engine, subject: str, settings: AccountSettings):
    try:
        with engine.begin() as connection:
            revision = schema_revision(connection, "api")
            if revision not in ACCOUNT_SCHEMA_REVISIONS:
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
            publication = None
            if revision == ACCOUNT_SCHEMA_REVISION:
                # Publishers take the exclusive form of this lock before changing the version.
                connection.execute(text("SELECT pg_advisory_xact_lock_shared(:key)"), {"key": PUBLICATION_LOCK})
                publication = connection.execute(text("""
                    SELECT version, conditions FROM rafiq_fixture.controlled_use_publication WHERE singleton
                """)).mappings().one_or_none()
            conditions = Conditions.model_validate({
                **publication["conditions"], "version": publication["version"],
            }) if publication else None
            yield connection, row, conditions
    except (SQLAlchemyError, ValidationError):
        raise unavailable() from None


def account_response(row, email: str, required_version: str, *, published: bool = True) -> Account:
    accepted = row["accepted_version"]
    return Account(
        accountId=row["id"],
        status="active" if published and accepted == required_version else "onboardingRequired",
        displayName=row["display_name"], registeredEmail=email, verified=True,
        acceptedVersion=accepted, requiredVersion=required_version,
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
    app.add_middleware(CORSMiddleware, allow_origins=[settings.web_origin], allow_methods=["GET", "PUT", "POST"],
                       allow_headers=["Authorization", "Content-Type"], expose_headers=["X-Request-Id"])

    @app.middleware("http")
    async def prevent_caching(request: Request, call_next):
        request.state.request_id = str(uuid4())
        response = await call_next(request)
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["X-Request-Id"] = request.state.request_id
        return response

    @app.exception_handler(AccountProblem)
    async def account_problem(request: Request, error: AccountProblem):
        payload = {"type": f"urn:rafiq:problem:{error.code}", "title": error.title, "status": error.status,
                   "code": error.code, "requestId": request.state.request_id}
        if error.field_errors:
            payload["errors"] = error.field_errors
        if error.support_contact:
            payload["supportContact"] = error.support_contact
        return JSONResponse(
            payload,
            status_code=error.status, media_type="application/problem+json",
            headers={"WWW-Authenticate": "Bearer"} if error.status == 401 else None,
        )

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, error: RequestValidationError):
        errors = error.errors()
        if any(entry["type"] == "json_invalid" for entry in errors):
            return await account_problem(request, AccountProblem(400, "malformed_request", "Malformed request"))
        fields = {
            ("/" + entry["loc"][1], "required" if entry["type"] == "missing" else "invalid")
            for entry in errors
            if len(entry["loc"]) > 1 and entry["loc"][0] == "body" and entry["loc"][1] in {"version", "accepted"}
        }
        return await account_problem(request, AccountProblem(
            422, "validation_failed", "Check the acceptance fields",
            field_errors=[{"pointer": pointer, "code": code} for pointer, code in sorted(fields)],
        ))

    @app.get("/internal/livez")
    def live():
        return {"status": "live"}

    @app.get("/internal/readyz")
    def ready():
        try:
            with engine.connect() as connection:
                if schema_ready(connection, "api", account_entry=True):
                    return {"status": "ready"}
        except SQLAlchemyError:
            pass
        raise unavailable()

    @app.get("/api/v1/account", operation_id="getAccount", response_model=Account)
    def get_account(request: Request, authorization: Annotated[str | None, Header()] = None):
        subject, email = verified_identity(authorization, settings, request.app.state.clerk)
        with account_access(engine, subject, settings) as (_, row, conditions):
            required = conditions.version if conditions else settings.required_version
            return account_response(row, email, required, published=conditions is not None)

    @app.get("/api/v1/account/controlled-use", operation_id="getControlledUse", response_model=Conditions)
    def get_conditions(request: Request, authorization: Annotated[str | None, Header()] = None):
        subject, _ = verified_identity(authorization, settings, request.app.state.clerk)
        with account_access(engine, subject, settings) as (_, _, conditions):
            if conditions is None:
                raise unavailable()
            return conditions

    @app.put("/api/v1/account/controlled-use", operation_id="acceptControlledUse", response_model=Account)
    def accept_controlled_use(acceptance: Acceptance, request: Request,
                              authorization: Annotated[str | None, Header()] = None):
        subject, email = verified_identity(authorization, settings, request.app.state.clerk)
        if not acceptance.accepted:
            raise AccountProblem(422, "explicit_acceptance_required", "Explicit acceptance is required",
                                 field_errors=[{"pointer": "/accepted", "code": "required"}])
        with account_access(engine, subject, settings) as (connection, row, conditions):
            if conditions is None:
                raise unavailable()
            if acceptance.version != conditions.version:
                raise AccountProblem(409, "controlled_use_changed", "Controlled-use conditions changed")
            updated = connection.execute(text("""
                UPDATE rafiq_fixture.driver_accounts SET accepted_version = :version
                WHERE clerk_subject = :subject AND NOT restricted AND accepted_version IS DISTINCT FROM :version
            """), {"subject": subject, "version": conditions.version})
            if updated.rowcount == 0:
                current = connection.execute(text("""
                    SELECT restricted, accepted_version FROM rafiq_fixture.driver_accounts WHERE clerk_subject = :subject
                """), {"subject": subject}).mappings().one()
                if current["restricted"]:
                    raise restricted(settings)
                if current["accepted_version"] != conditions.version:
                    raise unavailable()
            return account_response({**row, "accepted_version": conditions.version}, email, conditions.version)

    def private_context(request: Request, authorization: str | None,
                        destination: Literal["dashboard", "readiness"]) -> DriverEntryContext:
        subject, _ = verified_identity(authorization, settings, request.app.state.clerk)
        with account_access(engine, subject, settings) as (_, row, conditions):
            if conditions is None:
                raise unavailable()
            if row["accepted_version"] != conditions.version:
                raise AccountProblem(403, "controlled_use_required", "Accept current controlled-use conditions")
            return DriverEntryContext(
                destination=destination, accountId=row["id"], acceptedVersion=conditions.version,
            )

    @app.get("/api/v1/account/workspace", operation_id="getDriverWorkspace", response_model=DriverEntryContext)
    def workspace(request: Request, authorization: Annotated[str | None, Header()] = None):
        return private_context(request, authorization, "dashboard")

    @app.post("/api/v1/account/readiness", operation_id="prepareReadinessHandoff", response_model=DriverEntryContext)
    def readiness(request: Request, authorization: Annotated[str | None, Header()] = None):
        return private_context(request, authorization, "readiness")

    return app


def from_environment():
    return create_account_app(AccountSettings.from_environment(os.environ), engine_for("api"))
