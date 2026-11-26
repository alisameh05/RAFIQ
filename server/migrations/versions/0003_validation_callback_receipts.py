from alembic import op

revision = "0003_validation_callback"
down_revision = "0002_fixture_claim_index"


def upgrade():
    op.execute("""
        CREATE TABLE rafiq_fixture.validation_callback_receipts (
            event_id text PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 128),
            body_sha256 text NOT NULL CHECK (length(body_sha256) = 64),
            received_at timestamptz NOT NULL DEFAULT now()
        )
    """)
    op.execute("ALTER TABLE rafiq_fixture.validation_callback_receipts ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE rafiq_fixture.validation_callback_receipts FORCE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY validation_callback_read ON rafiq_fixture.validation_callback_receipts
        FOR SELECT TO rafiq_api USING (true)
    """)
    op.execute("""
        CREATE POLICY validation_callback_create ON rafiq_fixture.validation_callback_receipts
        FOR INSERT TO rafiq_api WITH CHECK (true)
    """)
    op.execute("""
        GRANT SELECT (event_id, body_sha256), INSERT (event_id, body_sha256)
        ON rafiq_fixture.validation_callback_receipts TO rafiq_api
    """)


def downgrade():
    op.drop_table("validation_callback_receipts", schema="rafiq_fixture")
