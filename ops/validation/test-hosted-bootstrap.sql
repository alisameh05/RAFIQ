\set ON_ERROR_STOP on
-- Run only on a new disposable PostgreSQL instance.
CREATE ROLE validation_admin NOLOGIN CREATEROLE;
ALTER DATABASE rafiq OWNER TO validation_admin;
SET ROLE validation_admin;
CREATE ROLE rafiq_validation_migration NOLOGIN NOINHERIT;
CREATE ROLE rafiq_validation_api NOLOGIN NOINHERIT;
CREATE ROLE rafiq_validation_worker NOLOGIN NOINHERIT;
\i /tmp/rafiq-hosted-bootstrap.sql
RESET ROLE;

DO $$ BEGIN
    IF (SELECT count(*) FROM pg_roles WHERE rolname IN (
        'rafiq_validation_migration', 'rafiq_validation_api', 'rafiq_validation_worker', 'rafiq_api', 'rafiq_worker'
    ) AND rolcanlogin) <> 0 THEN RAISE EXCEPTION 'bootstrap enabled login'; END IF;
    IF (SELECT count(*) FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid
        JOIN pg_roles member ON member.oid=m.member
        WHERE (parent.rolname, member.rolname) IN (('rafiq_api', 'rafiq_validation_api'),
                                                    ('rafiq_worker', 'rafiq_validation_worker'))
          AND m.inherit_option AND NOT m.set_option AND NOT m.admin_option) <> 2 THEN
        RAISE EXCEPTION 'runtime membership options are incorrect';
    END IF;
    IF has_schema_privilege('rafiq_validation_api', 'rafiq_fixture', 'CREATE') OR
       has_schema_privilege('rafiq_validation_worker', 'rafiq_fixture', 'CREATE') OR
       NOT has_schema_privilege('rafiq_validation_migration', 'rafiq_fixture', 'CREATE') THEN
        RAISE EXCEPTION 'schema grants are incorrect';
    END IF;
END $$;

-- Exercise the same inherited role/RLS pattern as the fixture migration.
SET ROLE rafiq_validation_migration;
CREATE TABLE rafiq_fixture.role_probe (owner_id text NOT NULL, sample integer NOT NULL);
ALTER TABLE rafiq_fixture.role_probe ENABLE ROW LEVEL SECURITY;
ALTER TABLE rafiq_fixture.role_probe FORCE ROW LEVEL SECURITY;
CREATE POLICY api_probe ON rafiq_fixture.role_probe FOR SELECT TO rafiq_api
    USING (owner_id = current_setting('rafiq.fixture_owner', true));
CREATE POLICY worker_probe ON rafiq_fixture.role_probe FOR SELECT TO rafiq_worker USING (true);
GRANT SELECT (owner_id, sample) ON rafiq_fixture.role_probe TO rafiq_api;
GRANT SELECT (sample) ON rafiq_fixture.role_probe TO rafiq_worker;
RESET ROLE;
INSERT INTO rafiq_fixture.role_probe VALUES ('driver-a', 2), ('driver-b', 4);

SET SESSION AUTHORIZATION rafiq_validation_api;
DO $$ BEGIN
    IF (SELECT count(*) FROM rafiq_fixture.role_probe) <> 0 THEN RAISE EXCEPTION 'unscoped API read'; END IF;
END $$;
SELECT set_config('rafiq.fixture_owner', 'driver-a', false);
DO $$ BEGIN
    IF (SELECT count(*) FROM rafiq_fixture.role_probe) <> 1 OR
       (SELECT min(owner_id) FROM rafiq_fixture.role_probe) <> 'driver-a' THEN
        RAISE EXCEPTION 'API owner isolation failed';
    END IF;
    BEGIN
        EXECUTE 'SET ROLE rafiq_api';
        RAISE EXCEPTION 'API can assume its group role';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END $$;
RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION rafiq_validation_worker;
DO $$ BEGIN
    IF (SELECT count(sample) FROM rafiq_fixture.role_probe) <> 2 THEN RAISE EXCEPTION 'worker read failed'; END IF;
    BEGIN
        PERFORM owner_id FROM rafiq_fixture.role_probe;
        RAISE EXCEPTION 'worker can read owner identities';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END $$;
RESET SESSION AUTHORIZATION;
