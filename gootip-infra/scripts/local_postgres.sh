#!/usr/bin/env bash
set -euo pipefail

infra_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$infra_dir/local/postgres.env"

if [[ ! -f "$env_file" ]]; then
  printf 'Missing %s. Copy local/postgres.env.example and set local credentials.\n' "$env_file" >&2
  exit 1
fi

set -a
# This is an operator-owned local env file, not tracked or sourced from untrusted input.
source "$env_file"
set +a

required_vars=(
  POSTGRES_ADMIN_USER POSTGRES_ADMIN_PASSWORD
  AUTH_MIGRATOR_PASSWORD AUTH_RUNTIME_PASSWORD
  CORE_MIGRATOR_PASSWORD CORE_RUNTIME_PASSWORD
)
for name in "${required_vars[@]}"; do
  if [[ -z "${!name:-}" || "${!name}" == replace-* ]]; then
    printf '%s must be set to a local value in %s.\n' "$name" "$env_file" >&2
    exit 1
  fi
done

compose=(docker compose --env-file "$env_file" -f "$infra_dir/compose.local.yaml")
LOCAL_POSTGRES_PORT="${LOCAL_POSTGRES_PORT:-5433}"
export LOCAL_POSTGRES_PORT
if [[ ! "$LOCAL_POSTGRES_PORT" =~ ^[0-9]+$ ]] || (( LOCAL_POSTGRES_PORT < 1 || LOCAL_POSTGRES_PORT > 65535 )); then
  printf 'LOCAL_POSTGRES_PORT must be a TCP port from 1 through 65535.\n' >&2
  exit 1
fi

bootstrap() {
  "${compose[@]}" exec -T postgres psql \
    --username "$POSTGRES_ADMIN_USER" \
    --dbname postgres \
    --set ON_ERROR_STOP=1 \
    --set auth_migrator_password="$AUTH_MIGRATOR_PASSWORD" \
    --set auth_runtime_password="$AUTH_RUNTIME_PASSWORD" \
    --set core_migrator_password="$CORE_MIGRATOR_PASSWORD" \
    --set core_runtime_password="$CORE_RUNTIME_PASSWORD" \
    --file - < "$infra_dir/local/postgres_bootstrap.sql"
}

expect_denied() {
  local role="$1" password="$2" sql="$3"
  local output
  if output=$("${compose[@]}" exec -T -e "PGPASSWORD=$password" postgres psql \
    --host 127.0.0.1 --username "$role" --dbname gootip \
    --set ON_ERROR_STOP=1 --command "$sql" 2>&1); then
    printf 'Permission check failed: %s unexpectedly succeeded.\n' "$role" >&2
    exit 1
  fi
  if ! grep -q 'ERROR:  permission denied' <<< "$output"; then
    printf '%s\n' "$output" >&2
    printf 'Permission check for %s failed for a reason other than denied privileges.\n' "$role" >&2
    exit 1
  fi
}

TEST_DATABASES=(
  gootip_test_auth_migrations
  gootip_test_auth_runtime
  gootip_test_core
  gootip_test_db_config
  gootip_test_db_config_operator_window
  gootip_test_db_config_membership
  gootip_test_db_config_admin_membership
  gootip_test_db_config_bookkeeping
  gootip_test_db_config_concurrency
)
TEST_ROLES=(
  test_auth_migrations_migrator
  test_auth_migrations_runtime
  test_auth_runtime_migrator
  test_auth_runtime_runtime
  test_core_migrator
  test_core_runtime
  test_db_config_master
  test_db_config_runtime
  test_db_config_migrator
  test_db_config_operator
  test_db_config_core_runtime
  test_db_config_core_migrator
)
integration_sentinel_table=""
integration_sentinel_value=""

admin_psql() {
  local database="$1"
  shift
  "${compose[@]}" exec -T postgres psql \
    --username "$POSTGRES_ADMIN_USER" --dbname "$database" --set ON_ERROR_STOP=1 "$@"
}

drop_test_resources() {
  local database role
  for database in "${TEST_DATABASES[@]}"; do
    admin_psql postgres --command "DROP DATABASE IF EXISTS \"$database\";"
  done
  for role in "${TEST_ROLES[@]}"; do
    admin_psql postgres --command "DROP ROLE IF EXISTS \"$role\";"
  done
}

create_test_databases() {
  local database
  for database in "${TEST_DATABASES[@]}"; do
    admin_psql postgres --command "CREATE DATABASE \"$database\";"
  done
  admin_psql postgres \
    --command "CREATE ROLE test_core_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '$CORE_TEST_MIGRATOR_PASSWORD'; CREATE ROLE test_core_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '$CORE_TEST_RUNTIME_PASSWORD';"
  admin_psql gootip_test_core \
    --command 'CREATE SCHEMA core AUTHORIZATION test_core_migrator; GRANT CONNECT ON DATABASE gootip_test_core TO test_core_migrator, test_core_runtime; GRANT USAGE ON SCHEMA core TO test_core_runtime; ALTER DEFAULT PRIVILEGES FOR ROLE test_core_migrator IN SCHEMA core GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO test_core_runtime; ALTER DEFAULT PRIVILEGES FOR ROLE test_core_migrator IN SCHEMA core GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO test_core_runtime;'
}

integration() {
  local auth_migration_password auth_migration_runtime_password
  local auth_runtime_migrator_password auth_runtime_password
  local current_status
  auth_migration_password="$(openssl rand -hex 24)"
  auth_migration_runtime_password="$(openssl rand -hex 24)"
  auth_runtime_migrator_password="$(openssl rand -hex 24)"
  auth_runtime_password="$(openssl rand -hex 24)"
  CORE_TEST_MIGRATOR_PASSWORD="$(openssl rand -hex 24)"
  CORE_TEST_RUNTIME_PASSWORD="$(openssl rand -hex 24)"
  TEST_DB_CONFIG_MASTER_PASSWORD="$(openssl rand -hex 24)"
  TEST_DB_CONFIG_RUNTIME_PASSWORD="$(openssl rand -hex 24)"
  TEST_DB_CONFIG_MIGRATOR_PASSWORD="$(openssl rand -hex 24)"
  TEST_DB_CONFIG_OPERATOR_PASSWORD="$(openssl rand -hex 24)"
  LOCAL_POSTGRES_HOST=127.0.0.1
  GOOTIP_DB_CONFIG_TEST_DATABASE=gootip_test_db_config
  export CORE_TEST_MIGRATOR_PASSWORD CORE_TEST_RUNTIME_PASSWORD
  export TEST_DB_CONFIG_MASTER_PASSWORD TEST_DB_CONFIG_RUNTIME_PASSWORD
  export TEST_DB_CONFIG_MIGRATOR_PASSWORD TEST_DB_CONFIG_OPERATOR_PASSWORD
  export LOCAL_POSTGRES_HOST GOOTIP_DB_CONFIG_TEST_DATABASE

  if ! "${compose[@]}" exec -T postgres pg_isready -U "$POSTGRES_ADMIN_USER" -d postgres >/dev/null 2>&1; then
    printf 'Shared PostgreSQL is unavailable. Start it with %s bootstrap, then rerun integration.\n' "${BASH_SOURCE[0]}" >&2
    return 1
  fi

  integration_sentinel_table="local_test_cleanup_sentinel_$(openssl rand -hex 8)"
  integration_sentinel_value="preserve-$(openssl rand -hex 8)"
  admin_psql gootip --command \
    "CREATE TABLE public.\"$integration_sentinel_table\" (marker text PRIMARY KEY); INSERT INTO public.\"$integration_sentinel_table\" VALUES ('$integration_sentinel_value');"
  current_status=0
  cleanup_integration() {
    current_status=$?
    trap - EXIT
    set +e
    drop_test_resources
    local cleanup_status=$?
    if (( cleanup_status != 0 )); then
      printf 'Test cleanup failed; inspect only the listed test databases and roles before rerunning.\n' >&2
      current_status=1
    fi
    exit "$current_status"
  }
  trap cleanup_integration EXIT

  drop_test_resources
  create_test_databases

  AUTH_MIGRATION_TEST_DATABASE_URL="postgres://$POSTGRES_ADMIN_USER:$POSTGRES_ADMIN_PASSWORD@127.0.0.1:$LOCAL_POSTGRES_PORT/gootip_test_auth_migrations" \
  TEST_AUTH_MIGRATIONS_MIGRATOR_PASSWORD="$auth_migration_password" \
  TEST_AUTH_MIGRATIONS_RUNTIME_PASSWORD="$auth_migration_runtime_password" \
    corepack pnpm@12.14.0 --dir "$infra_dir/../gootip-auth" test:integration:migrations

  AUTH_RUNTIME_TEST_DATABASE_URL="postgres://$POSTGRES_ADMIN_USER:$POSTGRES_ADMIN_PASSWORD@127.0.0.1:$LOCAL_POSTGRES_PORT/gootip_test_auth_runtime" \
  TEST_AUTH_RUNTIME_MIGRATOR_PASSWORD="$auth_runtime_migrator_password" \
  TEST_AUTH_RUNTIME_RUNTIME_PASSWORD="$auth_runtime_password" \
    corepack pnpm@12.14.0 --dir "$infra_dir/../gootip-auth" test:integration:runtime

  POSTGRES_DB_HOST=127.0.0.1 \
  POSTGRES_DB_PORT="$LOCAL_POSTGRES_PORT" \
  POSTGRES_DB_NAME=gootip_test_core \
  POSTGRES_DB_USER=test_core_runtime \
  POSTGRES_DB_PASSWORD="$CORE_TEST_RUNTIME_PASSWORD" \
  POSTGRES_SSL_MODE=disable \
    corepack pnpm@12.14.0 --dir "$infra_dir/../gootip-core" test:integration

  (cd "$infra_dir/../gootip-db-config" && uv run pytest -m integration -q)

  drop_test_resources
  local observed
  observed="$(admin_psql gootip --no-align --tuples-only --command "SELECT marker FROM public.\"$integration_sentinel_table\";")"
  if [[ "$observed" != "$integration_sentinel_value" ]]; then
    printf 'Development sentinel changed during test cleanup.\n' >&2
    return 1
  fi
  printf 'Integration suites passed serially; development sentinel survived test cleanup.\n'
  trap - EXIT
  admin_psql gootip --command "DROP TABLE public.\"$integration_sentinel_table\";"
}

command="${1:-bootstrap}"

case "$command" in
  bootstrap)
    "${compose[@]}" up -d --wait --wait-timeout 90 postgres
    bootstrap
    printf 'Shared PostgreSQL is ready; development database and roles are provisioned.\n'
    ;;
  migrate)
    "${compose[@]}" up -d --wait --wait-timeout 90 postgres
    bootstrap
    POSTGRES_DB_HOST=127.0.0.1 \
      POSTGRES_DB_PORT="$LOCAL_POSTGRES_PORT" \
      POSTGRES_DB_NAME=gootip \
      POSTGRES_SSL_MODE=disable \
      MIGRATION_DB_USER=auth_migrator \
      MIGRATION_DB_RUNTIME_USER=auth_runtime \
      MIGRATION_DB_SCHEMA=auth \
      MIGRATION_CREDENTIAL_SECRET_ARN=local:auth_migrator \
      LOCAL_AUTH_MIGRATOR_PASSWORD="$AUTH_MIGRATOR_PASSWORD" \
      corepack pnpm@12.14.0 --dir "$infra_dir/../gootip-auth" local:migrate
    POSTGRES_DB_HOST=127.0.0.1 \
      POSTGRES_DB_PORT="$LOCAL_POSTGRES_PORT" \
      POSTGRES_DB_NAME=gootip \
      POSTGRES_DB_USER=core_migrator \
      POSTGRES_DB_PASSWORD="$CORE_MIGRATOR_PASSWORD" \
      POSTGRES_SSL_MODE=disable \
      corepack pnpm@12.14.0 --dir "$infra_dir/../gootip-core" migration:run
    "${compose[@]}" exec -T postgres psql \
      --username "$POSTGRES_ADMIN_USER" --dbname gootip --set ON_ERROR_STOP=1 \
      --command 'GRANT SELECT ON TABLE auth.gootip_schema_migrations TO auth_runtime; REVOKE INSERT, UPDATE, DELETE ON TABLE core.typeorm_migrations FROM core_runtime;'
    expect_denied auth_runtime "$AUTH_RUNTIME_PASSWORD" \
      'BEGIN; CREATE TABLE auth.local_runtime_ddl_probe (id integer); ROLLBACK;'
    expect_denied auth_runtime "$AUTH_RUNTIME_PASSWORD" \
      'UPDATE auth.gootip_schema_migrations SET run_id = run_id WHERE false;'
    expect_denied auth_runtime "$AUTH_RUNTIME_PASSWORD" 'SET ROLE auth_migrator;'
    expect_denied auth_runtime "$AUTH_RUNTIME_PASSWORD" \
      'SELECT 1 FROM core.categories LIMIT 0;'
    expect_denied core_runtime "$CORE_RUNTIME_PASSWORD" \
      'BEGIN; CREATE TABLE core.local_runtime_ddl_probe (id integer); ROLLBACK;'
    expect_denied core_runtime "$CORE_RUNTIME_PASSWORD" \
      'UPDATE core.typeorm_migrations SET name = name WHERE false;'
    expect_denied core_runtime "$CORE_RUNTIME_PASSWORD" 'SET ROLE core_migrator;'
    expect_denied core_runtime "$CORE_RUNTIME_PASSWORD" \
      'SELECT 1 FROM auth."user" LIMIT 0;'
    printf 'Application migrations are current; runtime DDL and history writes are denied.\n'
    ;;
  integration)
    integration
    ;;
  *)
    printf 'Usage: %s [bootstrap|migrate|integration]\n' "${BASH_SOURCE[0]}" >&2
    exit 2
    ;;
esac
