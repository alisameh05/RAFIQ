CREATE ROLE rafiq_callback LOGIN PASSWORD 'local-callback-only';
GRANT CONNECT ON DATABASE rafiq TO rafiq_callback;
GRANT USAGE ON SCHEMA rafiq_fixture TO rafiq_callback;
