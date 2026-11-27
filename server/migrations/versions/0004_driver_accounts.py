from alembic import op

revision = "0004_driver_accounts"
down_revision = "0003_validation_callback"


def upgrade():
    op.execute("""
        CREATE TABLE rafiq_fixture.driver_accounts (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            clerk_subject text NOT NULL UNIQUE CHECK (length(clerk_subject) BETWEEN 6 AND 133),
            display_name text CHECK (length(display_name) BETWEEN 1 AND 100),
            accepted_version text CHECK (length(accepted_version) BETWEEN 1 AND 64),
            restricted boolean NOT NULL DEFAULT false,
            created_at timestamptz NOT NULL DEFAULT now()
        )
    """)
    op.execute("ALTER TABLE rafiq_fixture.driver_accounts ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE rafiq_fixture.driver_accounts FORCE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY driver_account_read ON rafiq_fixture.driver_accounts FOR SELECT TO rafiq_api
        USING (clerk_subject = current_setting('rafiq.driver_subject', true))
    """)
    op.execute("""
        CREATE POLICY driver_account_create ON rafiq_fixture.driver_accounts FOR INSERT TO rafiq_api
        WITH CHECK (clerk_subject = current_setting('rafiq.driver_subject', true))
    """)
    op.execute("""
        GRANT SELECT (id, clerk_subject, display_name, accepted_version, restricted), INSERT (clerk_subject)
        ON rafiq_fixture.driver_accounts TO rafiq_api
    """)


def downgrade():
    op.drop_table("driver_accounts", schema="rafiq_fixture")
