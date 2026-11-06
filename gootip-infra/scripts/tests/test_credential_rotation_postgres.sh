#!/usr/bin/env bash
set -euo pipefail

container="gootip-spec101-credential-test-$$"
admin_password="fictional-local-admin-password"
port=""

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker run --detach --name "$container" --publish 127.0.0.1::5432 \
  --env POSTGRES_USER=spec10_1_local_admin \
  --env "POSTGRES_PASSWORD=$admin_password" \
  --env POSTGRES_DB=postgres postgres:18-alpine >/dev/null

port="$(docker port "$container" 5432/tcp | sed 's/.*://')"
for attempt in {1..60}; do
  if docker exec "$container" pg_isready -U spec10_1_local_admin -d postgres >/dev/null 2>&1; then
    break
  fi
  if (( attempt == 60 )); then
    printf 'Disposable PostgreSQL did not become ready.\n' >&2
    exit 1
  fi
  sleep 1
done

logging_query="$(PYTHONPATH="$(dirname "$0")/.." python3 -c 'import credential_rotation_live as live; print(live.LOGGING_GATE_QUERY)')"
gate_result="$(docker exec "$container" psql -X -qAt -v ON_ERROR_STOP=1 \
  -U spec10_1_local_admin -d postgres -c "$logging_query")"
GATE_RESULT="$gate_result" PYTHONPATH="$(dirname "$0")/.." python3 - <<'PY'
import json
import os

import credential_rotation_live as live

gate = json.loads(os.environ["GATE_RESULT"])
assert {"user", "database", "ssl", "tls_version"} <= gate["session"].keys()
assert gate["session"]["user"] == "spec10_1_local_admin"
assert gate["session"]["database"] == "postgres"
required = {
    "log_statement", "log_min_duration_statement", "log_min_duration_sample",
    "log_statement_sample_rate", "log_transaction_sample_rate",
    "log_parameter_max_length", "log_parameter_max_length_on_error",
    "password_encryption", "shared_preload_libraries",
    "session_preload_libraries", "local_preload_libraries", "track_activity_query_size",
}
assert required <= gate["settings"].keys(), required - gate["settings"].keys()
assert gate["settings"]["password_encryption"] == "scram-sha-256"
live.validate_logging_settings(gate["settings"], set(gate["extensions"]))
PY

docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U spec10_1_local_admin -d postgres <<'SQL'
SET password_encryption = 'scram-sha-256';
CREATE ROLE auth_runtime LOGIN PASSWORD 'fictional-auth-old-password';
CREATE ROLE core_runtime LOGIN PASSWORD 'fictional-core-old-password';
CREATE ROLE unrelated_runtime LOGIN PASSWORD 'fictional-unrelated-password';
CREATE ROLE spec10_1_master LOGIN CREATEROLE PASSWORD 'fictional-master-password';
ALTER DATABASE postgres OWNER TO spec10_1_master;
GRANT auth_runtime, core_runtime TO spec10_1_master
  WITH ADMIN TRUE, SET FALSE, INHERIT FALSE;
SET ROLE spec10_1_master;
CREATE ROLE spec10_1_function_owner NOLOGIN CREATEROLE;
GRANT auth_runtime, core_runtime TO spec10_1_function_owner
  WITH ADMIN TRUE, SET FALSE, INHERIT FALSE;
GRANT CREATE ON DATABASE postgres TO spec10_1_function_owner;
CREATE ROLE spec10_1_credential_operator NOLOGIN NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
GRANT CONNECT ON DATABASE postgres TO spec10_1_credential_operator;
SET ROLE spec10_1_function_owner;
CREATE SCHEMA credential_admin;
CREATE FUNCTION credential_admin.set_runtime_password(target_name text, new_password text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  original_sqlstate text;
BEGIN
  IF target_name NOT IN ('auth_runtime', 'core_runtime') THEN
    RAISE EXCEPTION 'unsupported target';
  END IF;
  IF new_password IS NULL OR new_password = '' THEN
    RAISE EXCEPTION 'empty password is not allowed';
  END IF;
  BEGIN
    EXECUTE format('ALTER ROLE %I PASSWORD %L', target_name, new_password);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS original_sqlstate = RETURNED_SQLSTATE;
    RAISE EXCEPTION USING ERRCODE = original_sqlstate,
      MESSAGE = 'credential update failed';
  END;
END
$function$;
REVOKE ALL ON SCHEMA credential_admin FROM PUBLIC;
REVOKE ALL ON FUNCTION credential_admin.set_runtime_password(text, text) FROM PUBLIC;
RESET ROLE;
REVOKE CREATE ON DATABASE postgres FROM spec10_1_function_owner;
RESET ROLE;
SQL

docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U spec10_1_local_admin -d postgres <<'SQL'
DO $check$
BEGIN
  IF (SELECT rolcanlogin OR NOT rolcreaterole FROM pg_roles
      WHERE rolname = 'spec10_1_function_owner') THEN
    RAISE EXCEPTION 'function owner attributes are incorrect';
  END IF;
  IF (SELECT rolcreaterole OR rolcanlogin FROM pg_roles
      WHERE rolname = 'spec10_1_credential_operator') THEN
    RAISE EXCEPTION 'rotation login attributes are incorrect';
  END IF;
  IF pg_has_role('spec10_1_credential_operator', 'auth_runtime', 'MEMBER')
     OR pg_has_role('spec10_1_credential_operator', 'core_runtime', 'MEMBER')
     OR pg_has_role('spec10_1_credential_operator', 'spec10_1_function_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'rotation login has forbidden role membership';
  END IF;
  IF has_schema_privilege('spec10_1_credential_operator', 'credential_admin', 'USAGE')
     OR has_function_privilege('spec10_1_credential_operator',
       'credential_admin.set_runtime_password(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'disabled operator has active function privileges';
  END IF;
END
$check$;
SQL

docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U spec10_1_local_admin -d postgres <<'SQL'
SET ROLE spec10_1_function_owner;
GRANT USAGE ON SCHEMA credential_admin TO spec10_1_credential_operator;
GRANT EXECUTE ON FUNCTION credential_admin.set_runtime_password(text, text)
  TO spec10_1_credential_operator;
RESET ROLE;
SQL

# Force an ALTER ROLE error inside the function, assert only its SQLSTATE and
# fixed message, then roll back the temporary missing-role condition.
docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U spec10_1_local_admin -d postgres <<'SQL'
BEGIN;
REVOKE auth_runtime FROM spec10_1_master, spec10_1_function_owner CASCADE;
DROP ROLE auth_runtime;
SET ROLE spec10_1_credential_operator;
DO $assert$
DECLARE observed_state text; observed_message text;
BEGIN
  BEGIN
    PERFORM credential_admin.set_runtime_password(
      'auth_runtime', 'fictional-diagnostic-password'
    );
    RAISE EXCEPTION 'diagnostic function unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS
      observed_state = RETURNED_SQLSTATE,
      observed_message = MESSAGE_TEXT;
  END;
  IF observed_state <> '42704' OR observed_message <> 'credential update failed' THEN
    RAISE EXCEPTION 'safe SQLSTATE propagation assertion failed';
  END IF;
END
$assert$;
ROLLBACK;
SQL

docker exec "$container" psql -X -qAt -v ON_ERROR_STOP=1 \
  -U spec10_1_local_admin -d postgres \
  -c "SELECT 1 FROM pg_roles WHERE rolname = 'auth_runtime'" | grep -qx 1

if docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U spec10_1_local_admin -d postgres \
  -c "SET ROLE spec10_1_credential_operator; ALTER ROLE auth_runtime PASSWORD 'fictional-direct-change';" \
  >/dev/null 2>&1; then
  printf 'Rotation login unexpectedly altered a role directly.\n' >&2
  exit 1
fi

if docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U spec10_1_local_admin -d postgres \
  -c "SET ROLE spec10_1_credential_operator; SELECT credential_admin.set_runtime_password('unrelated_runtime', 'fictional-forbidden-password');" \
  >/dev/null 2>&1; then
  printf 'Function unexpectedly accepted an unapproved target.\n' >&2
  exit 1
fi

docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U spec10_1_local_admin -d postgres \
  -c "SET ROLE spec10_1_credential_operator; SELECT credential_admin.set_runtime_password('auth_runtime', 'fictional-auth-new-password'); SELECT credential_admin.set_runtime_password('core_runtime', 'fictional-core-new-password');"

docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U spec10_1_local_admin -d postgres <<'SQL'
SET ROLE spec10_1_function_owner;
REVOKE EXECUTE ON FUNCTION credential_admin.set_runtime_password(text, text)
  FROM spec10_1_credential_operator;
REVOKE USAGE ON SCHEMA credential_admin FROM spec10_1_credential_operator;
RESET ROLE;
ALTER ROLE spec10_1_credential_operator NOLOGIN PASSWORD NULL VALID UNTIL 'epoch';
SQL

# NOINHERIT logins need an explicitly inherited settings grant: MEMBER alone
# does not mean that their session can use the predefined role's privileges.
docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U spec10_1_local_admin -d postgres <<'SQL'
BEGIN;
GRANT pg_read_all_settings TO spec10_1_credential_operator;
DO $assert$
BEGIN
  IF pg_has_role('spec10_1_credential_operator', 'pg_read_all_settings', 'USAGE') THEN
    RAISE EXCEPTION 'NOINHERIT unexpectedly inherited the default grant';
  END IF;
END
$assert$;
GRANT pg_read_all_settings TO spec10_1_credential_operator
  WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
SET ROLE spec10_1_credential_operator;
DO $assert$
BEGIN
  IF NOT pg_has_role(current_user, 'pg_read_all_settings', 'USAGE')
     OR pg_has_role(current_user, 'pg_read_all_settings', 'SET') THEN
    RAISE EXCEPTION 'settings grant does not have the exact intended effective scope';
  END IF;
END
$assert$;
RESET ROLE;
REVOKE pg_read_all_settings FROM spec10_1_credential_operator;
COMMIT;
SQL

for pair in 'auth_runtime:fictional-auth-new-password' 'core_runtime:fictional-core-new-password'; do
  IFS=: read -r username password <<<"$pair"
  result="$(docker exec --env "PGPASSWORD=$password" "$container" \
    psql -X -h 127.0.0.1 -U "$username" -d postgres -qAtc 'SELECT current_user')"
  [[ "$result" == "$username" ]] || {
    printf 'Fresh local login did not verify the expected runtime identity.\n' >&2
    exit 1
  }
done

printf 'Disposable PostgreSQL credential-function checks passed.\n'
