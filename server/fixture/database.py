import os

from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

ACCOUNT_SCHEMA_REVISION = "0006_private_access"
FIXTURE_SCHEMA_REVISIONS = (
    "0003_validation_callback", "0004_driver_accounts", "0005_controlled_use", ACCOUNT_SCHEMA_REVISION,
)


def database_role(mode: str | None, role: str) -> str:
    names = {
        "local-fixture": {"api": "rafiq_api", "worker": "rafiq_worker", "migrate": "rafiq_migrate",
                          "callback": "rafiq_callback"},
        "hosted-validation": {"api": "rafiq_validation_api", "worker": "rafiq_validation_worker",
                              "migrate": "rafiq_validation_migration", "callback": "rafiq_validation_callback"},
    }
    try:
        return names[mode][role]
    except KeyError:
        raise RuntimeError("Invalid fixture mode or database role") from None


def database_url(mode: str | None, raw_url: str):
    if mode not in ("local-fixture", "hosted-validation"):
        raise RuntimeError("The synthetic fixture requires an explicit fixture mode")
    url = make_url(raw_url)
    if mode == "hosted-validation" and (
        url.drivername != "postgresql+psycopg" or not url.host
        or url.query.get("sslmode") != "verify-full" or not url.query.get("sslrootcert")
    ):
        raise RuntimeError("Hosted fixture database connections require verified PostgreSQL TLS")
    return url


def engine_for(role: str):
    return create_engine(
        database_url(os.environ.get("RAFIQ_MODE"), os.environ[f"RAFIQ_{role.upper()}_DATABASE_URL"]),
        connect_args={
            "connect_timeout": 3,
            "options": "-c statement_timeout=5000",
            "keepalives_idle": 2,
            "keepalives_interval": 1,
            "keepalives_count": 3,
            "tcp_user_timeout": 5000,
        },
        hide_parameters=True,
        pool_pre_ping=True,
        pool_timeout=3,
    )


def schema_revision(connection, role: str) -> str | None:
    return connection.execute(
        text("""
            SELECT version_num FROM rafiq_fixture.alembic_version WHERE current_user = :role
        """),
        {"role": database_role(os.environ.get("RAFIQ_MODE"), role)},
    ).scalar_one_or_none()


def schema_ready(connection, role: str, *, account_entry: bool = False) -> bool:
    versions = (ACCOUNT_SCHEMA_REVISION,) if account_entry else FIXTURE_SCHEMA_REVISIONS
    return schema_revision(connection, role) in versions
