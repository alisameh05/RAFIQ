from alembic import op

revision = "0009_recording_consent"
down_revision = "0008_monitoring_preferences"


def upgrade():
    op.execute("""
        ALTER TABLE rafiq_fixture.driver_accounts
        ADD COLUMN recording_revision bigint NOT NULL DEFAULT 0 CHECK (recording_revision >= 0),
        ADD COLUMN recording_withdrawal_revision bigint NOT NULL DEFAULT 0
            CHECK (recording_withdrawal_revision BETWEEN 0 AND recording_revision),
        ADD COLUMN recording_settings jsonb NOT NULL DEFAULT '{"enabled": false, "behaviors": []}'
    """)
    op.execute("""
        GRANT SELECT (recording_revision, recording_withdrawal_revision, recording_settings),
              UPDATE (recording_revision, recording_withdrawal_revision, recording_settings)
        ON rafiq_fixture.driver_accounts TO rafiq_api
    """)


def downgrade():
    op.execute("""
        ALTER TABLE rafiq_fixture.driver_accounts
        DROP COLUMN recording_settings,
        DROP COLUMN recording_withdrawal_revision,
        DROP COLUMN recording_revision
    """)
