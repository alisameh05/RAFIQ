from alembic import op

revision = "0007_driver_profile"
down_revision = "0006_private_access"


def upgrade():
    # The existing driver-account UPDATE policy requires the current owner and an unrestricted row.
    op.execute("GRANT UPDATE (display_name) ON rafiq_fixture.driver_accounts TO rafiq_api")


def downgrade():
    op.execute("REVOKE UPDATE (display_name) ON rafiq_fixture.driver_accounts FROM rafiq_api")
