\set ON_ERROR_STOP on

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', 'auth_migrator', :'auth_migrator_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'auth_migrator')\gexec
SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L', 'auth_migrator', :'auth_migrator_password')\gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', 'auth_runtime', :'auth_runtime_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'auth_runtime')\gexec
SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L', 'auth_runtime', :'auth_runtime_password')\gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', 'core_migrator', :'core_migrator_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'core_migrator')\gexec
SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L', 'core_migrator', :'core_migrator_password')\gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', 'core_runtime', :'core_runtime_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'core_runtime')\gexec
SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L', 'core_runtime', :'core_runtime_password')\gexec

SELECT 'CREATE DATABASE gootip'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'gootip')\gexec
GRANT CONNECT ON DATABASE gootip TO auth_migrator, auth_runtime, core_migrator, core_runtime;

\connect gootip

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION auth_migrator;
CREATE SCHEMA IF NOT EXISTS core AUTHORIZATION core_migrator;
ALTER SCHEMA auth OWNER TO auth_migrator;
ALTER SCHEMA core OWNER TO core_migrator;

REVOKE ALL ON SCHEMA auth FROM PUBLIC, core_migrator, core_runtime;
REVOKE ALL ON SCHEMA core FROM PUBLIC, auth_migrator, auth_runtime;
GRANT USAGE ON SCHEMA auth TO auth_runtime;
GRANT USAGE ON SCHEMA core TO core_runtime;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO auth_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA auth TO auth_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO core_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA core TO core_runtime;

ALTER DEFAULT PRIVILEGES FOR ROLE auth_migrator IN SCHEMA auth
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO auth_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE auth_migrator IN SCHEMA auth
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO auth_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE core_migrator IN SCHEMA core
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO core_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE core_migrator IN SCHEMA core
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO core_runtime;

DO $$
BEGIN
  IF to_regclass('auth.gootip_schema_migrations') IS NOT NULL THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON TABLE auth.gootip_schema_migrations FROM auth_runtime';
  END IF;
  IF to_regclass('core.typeorm_migrations') IS NOT NULL THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON TABLE core.typeorm_migrations FROM core_runtime';
  END IF;
END
$$;
