from alembic import op

revision = "0008_monitoring_preferences"
down_revision = "0007_driver_profile"


def upgrade():
    op.execute("""
        ALTER TABLE rafiq_fixture.driver_accounts
        ADD COLUMN camera_device_id text CHECK (length(camera_device_id) BETWEEN 1 AND 128),
        ADD COLUMN warning_audio boolean NOT NULL DEFAULT false,
        ADD COLUMN warning_visibility text NOT NULL DEFAULT 'default'
            CHECK (warning_visibility IN ('default', 'enhanced'))
    """)
    op.execute("""
        GRANT SELECT (camera_device_id, warning_audio, warning_visibility),
              UPDATE (camera_device_id, warning_audio, warning_visibility)
        ON rafiq_fixture.driver_accounts TO rafiq_api
    """)


def downgrade():
    op.execute("""
        ALTER TABLE rafiq_fixture.driver_accounts
        DROP COLUMN camera_device_id,
        DROP COLUMN warning_audio,
        DROP COLUMN warning_visibility
    """)
