-- Run in the isolated validation database before the 0006 migration.
-- Provision the environment-specific login credential separately.
\set ON_ERROR_STOP on
BEGIN;
CREATE ROLE rafiq_callback NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE rafiq_validation_callback NOLOGIN NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT rafiq_callback TO rafiq_validation_callback WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
DO $$ BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO rafiq_validation_callback', current_database());
END $$;
GRANT USAGE ON SCHEMA rafiq_fixture TO rafiq_callback;
COMMIT;
