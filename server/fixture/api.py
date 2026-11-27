import os
from typing import Annotated
from uuid import UUID

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from sqlalchemy import text
from sqlalchemy.exc import OperationalError, SQLAlchemyError, TimeoutError

from fixture.database import engine_for, schema_ready
from fixture.callback import InvalidCallback, verify_callback
from fixture.identity import FixtureIdentity
from fixture.storage import StorageDenied, StorageUnavailable, fetch_validation_object

identity = FixtureIdentity.from_environment(os.environ)
engine = engine_for("api")
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[identity.web_origin],
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization"],
)

@app.middleware("http")
async def prevent_fixture_caching(request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    return response


def fixture_owner(authorization: Annotated[str | None, Header()] = None) -> str:
    owner = identity.owner_for(authorization)
    if owner is None:
        raise HTTPException(401, "Synthetic identity required", {"WWW-Authenticate": "Bearer"})
    return owner


Owner = Annotated[str, Depends(fixture_owner)]


@app.exception_handler(OperationalError)
@app.exception_handler(TimeoutError)
async def database_unavailable(_request, _error):
    return JSONResponse(status_code=503, content={"detail": "Fixture database unavailable"})


def use_owner(connection, owner: str):
    try:
        compatible = schema_ready(connection, "api")
    except SQLAlchemyError:
        compatible = False
    if not compatible:
        raise HTTPException(503, "Fixture database unavailable")
    connection.execute(
        text("SELECT set_config('rafiq.fixture_owner', :owner, true)"), {"owner": owner}
    )


@app.get("/internal/livez")
def live():
    return {"status": "live"}


@app.get("/internal/readyz")
def ready(response: Response):
    try:
        with engine.connect() as connection:
            if schema_ready(connection, "api"):
                return {"status": "ready"}
    except SQLAlchemyError:
        pass
    response.status_code = 503
    return {"status": "unavailable"}


@app.post("/api/v1/local-fixtures")
def submit(owner: Owner):
    with engine.begin() as connection:
        use_owner(connection, owner)
        connection.execute(
            text("""
                INSERT INTO rafiq_fixture.fixtures (owner_id)
                VALUES (:owner) ON CONFLICT (owner_id) DO NOTHING
            """),
            {"owner": owner},
        )
        row = connection.execute(
            text("SELECT id, status, result FROM rafiq_fixture.fixtures WHERE owner_id = :owner"),
            {"owner": owner},
        ).mappings().one()
    return dict(row)


@app.get("/api/v1/local-fixtures/current")
def current(owner: Owner):
    with engine.begin() as connection:
        use_owner(connection, owner)
        row = connection.execute(
            text("SELECT id, status, result FROM rafiq_fixture.fixtures WHERE owner_id = :owner"),
            {"owner": owner},
        ).mappings().one_or_none()
    return dict(row) if row is not None else None


@app.get("/api/v1/local-fixtures/{fixture_id}")
def get_fixture(fixture_id: UUID, owner: Owner):
    with engine.begin() as connection:
        use_owner(connection, owner)
        row = connection.execute(
            text("SELECT id, status, result FROM rafiq_fixture.fixtures WHERE id = :id"),
            {"id": fixture_id},
        ).mappings().one_or_none()
    if row is None:
        raise HTTPException(404, "Fixture not found")
    return dict(row)


@app.get("/validation/private-objects/{requested_owner}")
def validation_private_object(requested_owner: str, owner: Owner,
                              authorization: Annotated[str | None, Header()] = None):
    if identity.mode != "hosted-validation" or requested_owner != owner:
        raise HTTPException(404, "Not found")
    subject = identity.driver_a if owner == "driver-a" else identity.driver_b
    try:
        data = fetch_validation_object(
            os.environ.get("RAFIQ_STORAGE_ORIGIN", ""), os.environ.get("RAFIQ_STORAGE_PUBLISHABLE_KEY", ""),
            subject, authorization or "",
        )
    except StorageDenied:
        raise HTTPException(404, "Not found") from None
    except StorageUnavailable:
        raise HTTPException(503, "Validation object unavailable") from None
    return Response(content=data, media_type="application/octet-stream")


@app.post("/validation/webhooks/clerk", status_code=204)
async def validation_clerk_callback(request: Request):
    if identity.mode != "hosted-validation":
        raise HTTPException(404, "Not found")
    secret = os.environ.get("CLERK_WEBHOOK_SIGNING_SECRET")
    instance = os.environ.get("CLERK_INSTANCE_ID")
    if not secret or not instance:
        raise HTTPException(503, "Validation callback unavailable")
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > 65536:
            raise HTTPException(413, "Callback too large")
        body.extend(chunk)
    headers = {name: request.headers.get(name, "") for name in
               ("svix-id", "svix-timestamp", "svix-signature")}
    try:
        event_id, digest = verify_callback(bytes(body), headers, secret, instance)
    except InvalidCallback:
        raise HTTPException(400, "Invalid callback") from None
    await run_in_threadpool(store_callback_receipt, event_id, digest)
    return Response(status_code=204)


def store_callback_receipt(event_id: str, digest: str):
    with engine.begin() as connection:
        if not schema_ready(connection, "api"):
            raise HTTPException(503, "Fixture database unavailable")
        connection.execute(text("""
            INSERT INTO rafiq_fixture.validation_callback_receipts (event_id, body_sha256)
            VALUES (:event_id, :digest) ON CONFLICT (event_id) DO NOTHING
        """), {"event_id": event_id, "digest": digest})
        stored = connection.execute(text("""
            SELECT body_sha256 FROM rafiq_fixture.validation_callback_receipts WHERE event_id = :event_id
        """), {"event_id": event_id}).scalar_one()
        if stored != digest:
            raise HTTPException(409, "Callback identity conflict")
