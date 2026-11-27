\set ON_ERROR_STOP on
-- Run only on an isolated, disposable PostgreSQL instance. These stubs model
-- the claims and operation interface; hosted Supabase still needs its own test.
BEGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
    SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
CREATE SCHEMA storage;
CREATE FUNCTION storage.allow_any_operation(expected_operations text[]) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT current_setting('storage.operation', true) = ANY(expected_operations)
$$;
CREATE TABLE storage.objects (bucket_id text NOT NULL, name text NOT NULL);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects FORCE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA auth, storage TO authenticated, anon;
GRANT SELECT ON storage.objects TO authenticated, anon;
INSERT INTO storage.objects VALUES
    ('rafiq-validation-fixtures', 'user_a/private-access-check.txt'),
    ('rafiq-validation-fixtures', 'user_b/private-access-check.txt'),
    ('rafiq-validation-fixtures', 'user_a/other.txt'),
    ('other-bucket', 'user_a/private-access-check.txt');

\i /tmp/rafiq-validation-policy.sql

INSERT INTO rafiq_validation.object_subjects VALUES
    ('https://issuer.example', 'user_a'), ('https://issuer.example', 'user_b');
SET LOCAL ROLE authenticated;
SELECT set_config('storage.operation', 'object.get_authenticated', true);
SELECT set_config('request.jwt.claims', '{"iss":"https://issuer.example","sub":"user_a"}', true);
DO $$ BEGIN
    IF (SELECT count(*) FROM storage.objects) <> 1 OR
       (SELECT min(name) FROM storage.objects) <> 'user_a/private-access-check.txt' THEN
        RAISE EXCEPTION 'owner access escaped its allowed synthetic object';
    END IF;
    BEGIN
        INSERT INTO rafiq_validation.object_subjects VALUES ('https://issuer.example', 'user_other');
        RAISE EXCEPTION 'authenticated user can add an allowed subject';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END $$;

SELECT set_config('request.jwt.claims', '{"iss":"https://other.example","sub":"user_a"}', true);
DO $$ BEGIN
    IF (SELECT count(*) FROM storage.objects) <> 0 THEN RAISE EXCEPTION 'wrong issuer allowed'; END IF;
END $$;
SELECT set_config('request.jwt.claims', '{"iss":"https://issuer.example","sub":"user_other"}', true);
DO $$ BEGIN
    IF (SELECT count(*) FROM storage.objects) <> 0 THEN RAISE EXCEPTION 'unapproved subject allowed'; END IF;
END $$;
SELECT set_config('request.jwt.claims', '{"iss":"https://issuer.example","sub":"user_a"}', true);
SELECT set_config('storage.operation', 'object.list', true);
DO $$ BEGIN
    IF (SELECT count(*) FROM storage.objects) <> 0 THEN RAISE EXCEPTION 'object listing allowed'; END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE anon;
SELECT set_config('storage.operation', 'object.get_authenticated', true);
DO $$ BEGIN
    IF (SELECT count(*) FROM storage.objects) <> 0 THEN RAISE EXCEPTION 'anonymous access allowed'; END IF;
END $$;
ROLLBACK;
