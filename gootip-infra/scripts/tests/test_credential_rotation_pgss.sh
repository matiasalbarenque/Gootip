#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
container="gootip-spec101-pgss-test-$$"
admin_password="fictional-local-admin-password"

cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

docker run --detach --name "$container" --publish 127.0.0.1::5432 \
  --env POSTGRES_USER=spec10_1_local_admin \
  --env "POSTGRES_PASSWORD=$admin_password" \
  --env POSTGRES_HOST_AUTH_METHOD=scram-sha-256 \
  --env POSTGRES_DB=postgres postgres:18-alpine \
  -c shared_preload_libraries=pg_stat_statements \
  -c pg_stat_statements.track=top \
  -c pg_stat_statements.track_utility=on \
  -c track_activity_query_size=4096 \
  -c password_encryption=scram-sha-256 \
  -c log_statement=none \
  -c log_min_duration_statement=-1 \
  -c log_min_duration_sample=-1 \
  -c log_parameter_max_length=-1 \
  -c log_parameter_max_length_on_error=0 >/dev/null

for attempt in {1..60}; do
  if docker exec "$container" pg_isready -U spec10_1_local_admin -d postgres >/dev/null 2>&1; then break; fi
  if (( attempt == 60 )); then printf 'Disposable PostgreSQL did not become ready.\n' >&2; exit 1; fi
  sleep 1
done

# The official image keeps an earlier loopback trust rule even when
# POSTGRES_HOST_AUTH_METHOD is set. Tighten only this disposable cluster's
# host rules so the positive and negative password assertions are meaningful.
docker exec --user postgres "$container" sh -c \
  "sed -i '/^host[[:space:]].*[[:space:]]trust$/s/[[:space:]]trust$/ scram-sha-256/' \"\$PGDATA/pg_hba.conf\" && pg_ctl reload -D \"\$PGDATA\""
docker exec "$container" psql -X -qAt -v ON_ERROR_STOP=1 \
  -U spec10_1_local_admin -d postgres \
  -c "DO \$\$ BEGIN IF EXISTS (SELECT 1 FROM pg_hba_file_rules WHERE type = 'host' AND auth_method = 'trust') THEN RAISE EXCEPTION 'loopback host trust remains enabled'; END IF; END \$\$;"

docker exec "$container" psql -X -q -v ON_ERROR_STOP=1 \
  -U spec10_1_local_admin -d postgres -c 'CREATE EXTENSION pg_stat_statements;'

logging_query="$(PYTHONPATH="$root" python3 -c 'import credential_rotation_live as live; print(live.LOGGING_GATE_QUERY)')"
gate_result="$(docker exec "$container" psql -X -qAt -v ON_ERROR_STOP=1 \
  -U spec10_1_local_admin -d postgres -c "$logging_query")"
GATE_RESULT="$gate_result" PYTHONPATH="$root" python3 - <<'PY'
import json
import os
import credential_rotation_live as live

gate = json.loads(os.environ["GATE_RESULT"])
settings = gate["settings"]
assert gate["session"]["user"] == "spec10_1_local_admin"
assert gate["session"]["database"] == "postgres"
assert {"password_encryption", "shared_preload_libraries", "pg_stat_statements.track",
        "pg_stat_statements.track_utility", "track_activity_query_size"} <= settings.keys()
assert settings["password_encryption"] == "scram-sha-256"
assert settings["pg_stat_statements.track"] == "top"
assert settings["pg_stat_statements.track_utility"] == "on"
assert settings["track_activity_query_size"] == "4096"
live.validate_logging_settings(settings, set(gate["extensions"]))
PY

docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 \
  -U spec10_1_local_admin -d postgres <<'SQL'
CREATE ROLE auth_runtime LOGIN;
CREATE ROLE core_runtime LOGIN;
CREATE ROLE unrelated_runtime NOLOGIN;
CREATE ROLE spec10_1_master NOLOGIN CREATEROLE;
ALTER DATABASE postgres OWNER TO spec10_1_master;
GRANT auth_runtime, core_runtime TO spec10_1_master
  WITH ADMIN TRUE, SET FALSE, INHERIT FALSE;
GRANT SET ON PARAMETER pg_stat_statements.track_utility TO spec10_1_master;
GRANT CREATE ON DATABASE postgres TO spec10_1_master;

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
    RAISE EXCEPTION 'unsupported target' USING ERRCODE = '22023';
  END IF;
  IF new_password IS NULL OR new_password = '' THEN
    RAISE EXCEPTION 'empty password is not allowed' USING ERRCODE = '22023';
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

CREATE TABLE credential_test_password_literals (secret text NOT NULL);
SQL

# psql's hidden password command sends a verifier in top-level ALTER ROLE utility SQL.
# SET LOCAL suppresses only those statements; COMMIT restores the server setting.
docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 \
  -U spec10_1_local_admin -d postgres <<'SQL'
SET ROLE spec10_1_master;
BEGIN;
SET LOCAL pg_stat_statements.track_utility = off;
\password auth_runtime
fictional-auth-prior-password
fictional-auth-prior-password
\password core_runtime
fictional-core-prior-password
fictional-core-prior-password
COMMIT;
SHOW pg_stat_statements.track_utility;
RESET ROLE;
SQL

setting="$(docker exec "$container" psql -X -qAt -U spec10_1_local_admin -d postgres \
  -c 'SHOW pg_stat_statements.track_utility')"
[[ "$setting" == on ]] || { printf 'SET LOCAL leaked beyond COMMIT.\n' >&2; exit 1; }

docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 \
  -U spec10_1_local_admin -d postgres <<'SQL'
DO $check$
BEGIN
  IF has_parameter_privilege('spec10_1_master',
       'pg_stat_statements.track_utility', 'SET') IS NOT TRUE THEN
    RAISE EXCEPTION 'provisioner test role lacks the exact parameter SET privilege';
  END IF;
  IF (SELECT rolcanlogin OR NOT rolcreaterole FROM pg_roles
      WHERE rolname = 'spec10_1_function_owner') THEN
    RAISE EXCEPTION 'function owner attributes are incorrect';
  END IF;
  IF (SELECT rolcreaterole OR rolcanlogin FROM pg_roles
      WHERE rolname = 'spec10_1_credential_operator') THEN
    RAISE EXCEPTION 'rotation login attributes are incorrect before activation';
  END IF;
END
$check$;
SQL

# Activation grants only the fixed function, then uses a transaction-local setting
# for the single operation whose psql utility text contains a SCRAM verifier.
docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 \
  -U spec10_1_local_admin -d postgres <<'SQL'
SET ROLE spec10_1_function_owner;
GRANT USAGE ON SCHEMA credential_admin TO spec10_1_credential_operator;
GRANT EXECUTE ON FUNCTION credential_admin.set_runtime_password(text, text)
  TO spec10_1_credential_operator;
RESET ROLE;
SET ROLE spec10_1_master;
BEGIN;
SET LOCAL pg_stat_statements.track_utility = off;
\password spec10_1_credential_operator
fictional-temporary-operator-password
fictional-temporary-operator-password
SELECT format('ALTER ROLE spec10_1_credential_operator LOGIN VALID UNTIL %L',
              clock_timestamp() + interval '30 minutes') \gexec
COMMIT;
SHOW pg_stat_statements.track_utility;
RESET ROLE;
SQL

setting="$(docker exec "$container" psql -X -qAt -U spec10_1_local_admin -d postgres \
  -c 'SHOW pg_stat_statements.track_utility')"
[[ "$setting" == on ]] || { printf 'Activation SET LOCAL leaked beyond COMMIT.\n' >&2; exit 1; }

# Keep every test password in a local table and pass it through psql's extended-query
# protocol, so the assertion below does not itself place credentials in query text.
docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 \
  -U spec10_1_local_admin -d postgres <<'SQL'
INSERT INTO credential_test_password_literals VALUES ($1), ($2), ($3), ($4), ($5), ($6)
\bind 'fictional-auth-prior-password' 'fictional-core-prior-password' 'fictional-temporary-operator-password' 'fictional-auth-rotated-password' 'fictional-core-rotated-password' 'fictional-recovered-auth-password' \g

SET ROLE spec10_1_credential_operator;
SELECT credential_admin.set_runtime_password($1, $2)
\bind 'auth_runtime' 'fictional-auth-rotated-password' \g
SELECT credential_admin.set_runtime_password($1, $2)
\bind 'core_runtime' 'fictional-core-rotated-password' \g
RESET ROLE;
SQL

for pair in 'auth_runtime:fictional-auth-rotated-password' 'core_runtime:fictional-core-rotated-password'; do
  IFS=: read -r username password <<<"$pair"
  result="$(docker exec --env "PGPASSWORD=$password" "$container" \
    psql -X -h 127.0.0.1 -U "$username" -d postgres -qAtc 'SELECT current_user')"
  [[ "$result" == "$username" ]] || { printf 'Rotated runtime login failed.\n' >&2; exit 1; }
done

# Recovery restores the published/prior pair through the same bound function path.
docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 \
  -U spec10_1_local_admin -d postgres <<'SQL'
SET ROLE spec10_1_credential_operator;
SELECT credential_admin.set_runtime_password($1, $2)
\bind 'auth_runtime' 'fictional-recovered-auth-password' \g
RESET ROLE;
SQL

result="$(docker exec --env PGPASSWORD=fictional-recovered-auth-password "$container" \
  psql -X -h 127.0.0.1 -U auth_runtime -d postgres -qAtc 'SELECT current_user')"
[[ "$result" == auth_runtime ]] || { printf 'Recovery login failed.\n' >&2; exit 1; }
if docker exec --env PGPASSWORD=fictional-auth-rotated-password "$container" \
  psql -X -h 127.0.0.1 -U auth_runtime -d postgres -qAtc 'SELECT current_user' >/dev/null 2>&1; then
  printf 'Superseded auth password still authenticates after recovery.\n' >&2
  exit 1
fi

# Close: disable the operator, revoke its function access and the one-parameter SET grant.
docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 \
  -U spec10_1_local_admin -d postgres <<'SQL'
SET ROLE spec10_1_function_owner;
REVOKE EXECUTE ON FUNCTION credential_admin.set_runtime_password(text, text)
  FROM spec10_1_credential_operator;
REVOKE USAGE ON SCHEMA credential_admin FROM spec10_1_credential_operator;
RESET ROLE;
SET ROLE spec10_1_master;
ALTER ROLE spec10_1_credential_operator NOLOGIN PASSWORD NULL VALID UNTIL 'epoch';
RESET ROLE;
REVOKE SET ON PARAMETER pg_stat_statements.track_utility FROM spec10_1_master;
SQL

docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 \
  -U spec10_1_local_admin -d postgres <<'SQL'
DO $check$
DECLARE tracked text; verifier text;
BEGIN
  IF has_parameter_privilege('spec10_1_master',
       'pg_stat_statements.track_utility', 'SET') THEN
    RAISE EXCEPTION 'temporary parameter SET grant remains';
  END IF;
  IF (SELECT rolcanlogin OR rolvaliduntil > now() FROM pg_roles
      WHERE rolname = 'spec10_1_credential_operator') THEN
    RAISE EXCEPTION 'operator login was not disabled and expired';
  END IF;
  IF pg_has_role('spec10_1_credential_operator', 'auth_runtime', 'MEMBER')
     OR pg_has_role('spec10_1_credential_operator', 'core_runtime', 'MEMBER')
     OR pg_has_role('spec10_1_credential_operator', 'spec10_1_function_owner', 'MEMBER')
     OR has_schema_privilege('spec10_1_credential_operator', 'credential_admin', 'USAGE')
     OR has_function_privilege('spec10_1_credential_operator',
       'credential_admin.set_runtime_password(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'operator closeout left privileges or memberships';
  END IF;
  SELECT string_agg(query, E'\n') INTO tracked FROM pg_stat_statements;
  IF EXISTS (SELECT 1 FROM credential_test_password_literals p
             WHERE position(p.secret in tracked) > 0) THEN
    RAISE EXCEPTION 'a fictitious plaintext password remains in pg_stat_statements';
  END IF;
  FOR verifier IN
    SELECT rolpassword FROM pg_authid
    WHERE rolname IN ('auth_runtime', 'core_runtime', 'spec10_1_credential_operator')
      AND rolpassword IS NOT NULL
  LOOP
    IF position(verifier in tracked) > 0 THEN
      RAISE EXCEPTION 'a password verifier remains in pg_stat_statements';
    END IF;
  END LOOP;
  IF current_setting('pg_stat_statements.track_utility') <> 'on'
     OR (SELECT reset_val <> 'on' OR pending_restart
         FROM pg_settings WHERE name = 'pg_stat_statements.track_utility') THEN
    RAISE EXCEPTION 'session override changed the effective server default';
  END IF;
END
$check$;
DROP TABLE credential_test_password_literals;
SQL

printf 'Disposable PostgreSQL 18 pg_stat_statements lifecycle and privacy checks passed.\n'
