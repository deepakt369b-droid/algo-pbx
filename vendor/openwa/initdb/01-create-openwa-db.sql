-- Gives OpenWA its own Postgres database rather than a schema inside
-- algopbx_db, matching what upstream expects (DATABASE_NAME is a whole
-- database, not a `?schema=` URL fragment — see docker-compose.yml's
-- `openwa` service and vendor/openwa/README.md).
--
-- Runs automatically only on a FRESH postgres data volume (Postgres's
-- entrypoint executes every file under /docker-entrypoint-initdb.d/ once,
-- the first time the volume is initialized). On an already-initialized
-- volume, run this by hand once:
--   docker compose exec postgres psql -U "$POSTGRES_USER" -d postgres -f /docker-entrypoint-initdb.d/01-create-openwa-db.sql
--
-- ${POSTGRES_USER} is not available inside this file (it is not templated
-- by the postgres image), so it reuses the same superuser the main
-- database was created with — that user already exists by the time this
-- script runs, since POSTGRES_USER/POSTGRES_DB are handled before
-- initdb.d scripts.
SELECT 'CREATE DATABASE openwa'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'openwa')\gexec
