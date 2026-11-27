-- One-time bootstrap for the isolated validation database, after review.
-- It does not enable login, set passwords, or apply the application migration.
\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE candidate text;
BEGIN
    IF current_setting('server_version_num')::integer < 160000 THEN
        RAISE EXCEPTION 'PostgreSQL 16 or newer is required for per-membership options';
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname IN ('rafiq_api', 'rafiq_worker')) OR
       EXISTS (SELECT FROM pg_namespace WHERE nspname = 'rafiq_fixture') THEN
        RAISE EXCEPTION 'Fixture roles or schema already exist; inspect before bootstrap';
    END IF;
    FOREACH candidate IN ARRAY ARRAY['rafiq_validation_migration', 'rafiq_validation_api', 'rafiq_validation_worker'] LOOP
        IF NOT EXISTS (
            SELECT FROM pg_roles WHERE rolname = candidate AND NOT rolcanlogin AND NOT rolsuper
              AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
        ) OR EXISTS (
            SELECT FROM pg_auth_members m JOIN pg_roles member ON member.oid = m.member
            WHERE member.rolname = candidate
        ) THEN
            RAISE EXCEPTION 'Validation role is missing, enabled, privileged, or has memberships: %', candidate;
        END IF;
    END LOOP;
END $$;

-- These group roles own no objects; login principals inherit only their grants.
CREATE ROLE rafiq_api NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE rafiq_worker NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT rafiq_api TO rafiq_validation_api WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
GRANT rafiq_worker TO rafiq_validation_worker WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
DO $$ BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO rafiq_validation_migration, rafiq_validation_api, rafiq_validation_worker', current_database());
END $$;
CREATE SCHEMA rafiq_fixture;
REVOKE ALL ON SCHEMA rafiq_fixture FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA rafiq_fixture TO rafiq_validation_migration;
GRANT USAGE ON SCHEMA rafiq_fixture TO rafiq_api, rafiq_worker;
COMMIT;
