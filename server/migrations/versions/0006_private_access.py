from alembic import op

revision = "0006_private_access"
down_revision = "0005_controlled_use"


def upgrade():
    op.execute("""
        CREATE TABLE rafiq_fixture.driver_identity_lifecycle (
            clerk_subject text PRIMARY KEY CHECK (length(clerk_subject) BETWEEN 6 AND 133),
            state text NOT NULL CHECK (state IN ('active', 'restricted', 'deleted')),
            provider_revision bigint NOT NULL CHECK (provider_revision >= 0),
            restriction_revision bigint NOT NULL DEFAULT 0 CHECK (restriction_revision >= 0),
            fresh_session_after bigint NOT NULL DEFAULT 0 CHECK (fresh_session_after >= 0)
        )
    """)
    op.execute("ALTER TABLE rafiq_fixture.driver_identity_lifecycle ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE rafiq_fixture.driver_identity_lifecycle FORCE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY own_identity_lifecycle ON rafiq_fixture.driver_identity_lifecycle
        FOR SELECT TO rafiq_api USING (clerk_subject = current_setting('rafiq.driver_subject', true))
    """)
    op.execute("""
        CREATE POLICY callback_identity_lifecycle ON rafiq_fixture.driver_identity_lifecycle
        FOR ALL TO rafiq_callback USING (true) WITH CHECK (true)
    """)
    op.execute("""
        GRANT SELECT ON rafiq_fixture.driver_identity_lifecycle TO rafiq_api;
        GRANT SELECT, INSERT, UPDATE ON rafiq_fixture.driver_identity_lifecycle TO rafiq_callback
    """)
    op.execute("""
        CREATE TABLE rafiq_fixture.clerk_callback_receipts (
            event_id text PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 128),
            body_sha256 text NOT NULL CHECK (length(body_sha256) = 64),
            clerk_subject text NOT NULL CHECK (length(clerk_subject) BETWEEN 6 AND 133),
            snapshot_revision bigint CHECK (snapshot_revision > 0),
            snapshot_restricted boolean,
            received_at timestamptz NOT NULL DEFAULT now()
        )
    """)
    op.execute("""
        CREATE INDEX clerk_callback_active_snapshots
        ON rafiq_fixture.clerk_callback_receipts (clerk_subject, snapshot_revision)
        WHERE snapshot_restricted IS FALSE
    """)
    op.execute("ALTER TABLE rafiq_fixture.clerk_callback_receipts ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE rafiq_fixture.clerk_callback_receipts FORCE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY callback_receipts ON rafiq_fixture.clerk_callback_receipts
        FOR ALL TO rafiq_callback USING (true) WITH CHECK (true)
    """)
    op.execute("""
        GRANT SELECT, INSERT ON rafiq_fixture.clerk_callback_receipts TO rafiq_callback;
        GRANT SELECT ON rafiq_fixture.alembic_version TO rafiq_callback
    """)
    op.execute("""
        CREATE TABLE rafiq_fixture.workspace_links (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            driver_id uuid NOT NULL REFERENCES rafiq_fixture.driver_accounts(id),
            expires_at timestamptz NOT NULL,
            deleted_at timestamptz
        )
    """)
    op.execute("CREATE INDEX workspace_links_driver ON rafiq_fixture.workspace_links (driver_id)")
    op.execute("ALTER TABLE rafiq_fixture.workspace_links ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE rafiq_fixture.workspace_links FORCE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY own_eligible_workspace_links ON rafiq_fixture.workspace_links
        FOR SELECT TO rafiq_api USING (
            deleted_at IS NULL AND expires_at > statement_timestamp() AND
            EXISTS (
                SELECT 1 FROM rafiq_fixture.driver_accounts AS driver
                WHERE driver.id = driver_id AND NOT driver.restricted
            ) AND NOT EXISTS (
                SELECT 1 FROM rafiq_fixture.driver_identity_lifecycle AS identity
                WHERE identity.state IN ('restricted', 'deleted')
            )
        )
    """)
    op.execute("""
        CREATE POLICY maintain_workspace_links ON rafiq_fixture.workspace_links
        FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true)
    """)
    op.execute("GRANT SELECT ON rafiq_fixture.workspace_links TO rafiq_api")


def downgrade():
    op.drop_table("workspace_links", schema="rafiq_fixture")
    op.execute("REVOKE SELECT ON rafiq_fixture.alembic_version FROM rafiq_callback")
    op.drop_table("clerk_callback_receipts", schema="rafiq_fixture")
    op.drop_table("driver_identity_lifecycle", schema="rafiq_fixture")
