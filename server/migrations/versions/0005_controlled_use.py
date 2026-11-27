from alembic import op

revision = "0005_controlled_use"
down_revision = "0004_driver_accounts"


def upgrade():
    op.execute("""
        CREATE TABLE rafiq_fixture.controlled_use_publication (
            singleton boolean PRIMARY KEY CHECK (singleton),
            version text NOT NULL CHECK (length(version) BETWEEN 1 AND 64),
            conditions jsonb NOT NULL CHECK (jsonb_typeof(conditions) = 'object')
        )
    """)
    op.execute("GRANT SELECT ON rafiq_fixture.controlled_use_publication TO rafiq_api")
    op.execute("""
        CREATE POLICY driver_account_accept ON rafiq_fixture.driver_accounts FOR UPDATE TO rafiq_api
        USING (clerk_subject = current_setting('rafiq.driver_subject', true) AND NOT restricted)
        WITH CHECK (clerk_subject = current_setting('rafiq.driver_subject', true) AND NOT restricted)
    """)
    op.execute("GRANT UPDATE (accepted_version) ON rafiq_fixture.driver_accounts TO rafiq_api")


def downgrade():
    op.execute("REVOKE UPDATE (accepted_version) ON rafiq_fixture.driver_accounts FROM rafiq_api")
    op.execute("DROP POLICY driver_account_accept ON rafiq_fixture.driver_accounts")
    op.drop_table("controlled_use_publication", schema="rafiq_fixture")
