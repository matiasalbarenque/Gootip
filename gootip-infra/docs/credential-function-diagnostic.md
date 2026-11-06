# Credential Function Diagnostic

Use this bounded, read-only query to inspect the fixed password function and
the effective PostgreSQL role capabilities after the temporary provisioner
access is explicitly re-enabled. It does not call the function, alter a role,
read password verifiers, or change any privilege. Run it against database
`gootip` through the private `verify-full` tunnel as the reviewed RDS master
login. The logging/session gate must be the first SQL statement in that fresh
master session; stop if it fails.

```sql
SELECT jsonb_build_object(
  'database', current_database(),
  'session', (
    SELECT jsonb_build_object(
      'user', current_user,
      'ssl', ssl,
      'tls_version', version
    )
    FROM pg_stat_ssl WHERE pid = pg_backend_pid()
  ),
  'operator', (
    SELECT jsonb_build_object(
      'login', rolcanlogin,
      'create_role', rolcreaterole,
      'superuser', rolsuper,
      'create_db', rolcreatedb,
      'replication', rolreplication,
      'bypass_rls', rolbypassrls
    )
    FROM pg_roles WHERE rolname = 'gootip_credential_operator'
  ),
  'function_owner', (
    SELECT jsonb_build_object(
      'create_role', rolcreaterole,
      'superuser', rolsuper
    )
    FROM pg_roles WHERE rolname = 'gootip_credential_function_owner'
  ),
  'rds_password_control', jsonb_build_object(
    'restricted_password_commands', current_setting('rds.restrict_password_commands', true),
    'rds_password_role_exists', EXISTS (
      SELECT 1 FROM pg_roles WHERE rolname = 'rds_password'
    ),
    'owner_rds_password_member', CASE
      WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rds_password')
      THEN pg_has_role('gootip_credential_function_owner', 'rds_password', 'MEMBER')
      ELSE false
    END
  ),
  'function', (
    SELECT jsonb_build_object(
      'owner', owner.rolname,
      'security_definer', p.prosecdef,
      'configuration', p.proconfig,
      'acl', p.proacl::text,
      'definition', pg_get_functiondef(p.oid)
    )
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    JOIN pg_roles AS owner ON owner.oid = p.proowner
    WHERE n.nspname = 'credential_admin'
      AND p.proname = 'set_runtime_password'
      AND pg_get_function_identity_arguments(p.oid) = 'target_name text, new_password text'
  ),
  'effective_privileges', jsonb_build_object(
    'operator_schema_usage', has_schema_privilege(
      'gootip_credential_operator', 'credential_admin', 'USAGE'
    ),
    'operator_function_execute', has_function_privilege(
      'gootip_credential_operator',
      'credential_admin.set_runtime_password(text,text)', 'EXECUTE'
    ),
    'owner_auth_runtime_member', pg_has_role(
      'gootip_credential_function_owner', 'auth_runtime', 'MEMBER'
    ),
    'owner_auth_runtime_set', pg_has_role(
      'gootip_credential_function_owner', 'auth_runtime', 'SET'
    ),
    'owner_core_runtime_member', pg_has_role(
      'gootip_credential_function_owner', 'core_runtime', 'MEMBER'
    ),
    'owner_core_runtime_set', pg_has_role(
      'gootip_credential_function_owner', 'core_runtime', 'SET'
    )
  ),
  'direct_memberships', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'member', member_role.rolname,
      'granted_role', granted_role.rolname,
      'grantor', grantor_role.rolname,
      'admin_option', m.admin_option,
      'inherit_option', m.inherit_option,
      'set_option', m.set_option
    ) ORDER BY member_role.rolname, granted_role.rolname)
    FROM pg_auth_members AS m
    JOIN pg_roles AS member_role ON member_role.oid = m.member
    JOIN pg_roles AS granted_role ON granted_role.oid = m.roleid
    JOIN pg_roles AS grantor_role ON grantor_role.oid = m.grantor
    WHERE member_role.rolname IN (
      'gootip_credential_function_owner', 'gootip_credential_operator'
    )
      AND granted_role.rolname IN (
        'auth_runtime', 'core_runtime', 'pg_read_all_settings', 'rds_password'
      )
  ), '[]'::jsonb)
);
```

Review the single result for the exact function owner, `SECURITY DEFINER`, fixed
`search_path`, operator `EXECUTE`/schema `USAGE`, owner `CREATEROLE`, and the
runtime membership options. Also check `rds.restrict_password_commands` and the
function owner's membership in `rds_password`; AWS requires that role only when
restricted password management is enabled. PostgreSQL 18 documents that
`CREATEROLE` plus `ADMIN OPTION` on a non-superuser target is sufficient to
change most target role properties, including passwords ([role attributes](https://www.postgresql.org/docs/18/role-attributes.html)); see AWS's
[restricted password management](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.PostgreSQL.CommonDBATasks.RestrictPasswordMgmt.html)
for the RDS-specific condition.

## Exact function change for installation/update

After the fresh master session passes the logging/TLS gate, install or update
the function as its fixed owner with this exact body. `CREATE OR REPLACE`
preserves the existing function identity, owner, and grants; the change only
preserves the caught SQLSTATE and keeps the error message fixed.

```sql
BEGIN;
SET ROLE gootip_credential_function_owner;
CREATE OR REPLACE FUNCTION credential_admin.set_runtime_password(
  target_name text,
  new_password text
)
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
RESET ROLE;
COMMIT;
```

## One controlled Auth-only RDS probe for authorization

Run the Python block below from the repository root, with
`PYTHONPATH=gootip-infra/scripts` and
`gootip-db-config/.venv/bin/python`. Endpoint discovery uses the existing
`db_access.sh info` helper and its fixed `gootip-db-operator` profile;
Provisioner reads only the exact master secret and needs no RDS discovery grant.

This is a single call to the corrected function, not a credential rotation.
It uses only `auth_runtime`, generates a fictitious password in memory, and
never writes Secrets Manager. The function call and its `ALTER ROLE` run inside
one explicit transaction that is unconditionally rolled back; PostgreSQL role
catalog updates are transactional. `SET LOCAL` suppresses utility tracking only
inside that transaction. The session's first SQL statement must still be the
logging/TLS gate. The script prints only a safe outcome category and SQLSTATE;
it must not print driver exception text, query details, or the fictitious value.

```python
import json
import secrets
import subprocess
from pathlib import Path

import boto3
import psycopg
from credential_rotation_live import (
    DATABASE, LOGGING_GATE_QUERY, REGION, _db_connect,
    validate_logging_settings,
)

class RollbackProbe(Exception):
    pass

class ProbePrecondition(Exception):
    pass

connection = None
stage = "reading_master_secret"
try:
    master_arn = "arn:aws:secretsmanager:us-east-2:123456789012:secret:rds!db-00000000-0000-4000-8000-000000000000"
    session = boto3.Session(profile_name="gootip-credential-provisioner", region_name=REGION)
    secret = session.client("secretsmanager").get_secret_value(
        SecretId=master_arn, VersionStage="AWSCURRENT"
    )
    if secret.get("ARN") != master_arn or not isinstance(secret.get("SecretString"), str):
        raise ProbePrecondition()
    master = json.loads(secret["SecretString"])
    if master.get("username") != "gootip_auth":
        raise ProbePrecondition()

    stage = "discovering_endpoint"
    # Run from the repository root. The existing helper fixes its own AWS
    # profile to gootip-db-operator and validates the private dev RDS topology.
    info = subprocess.run(
        ["bash", str(Path("gootip-infra/scripts/db_access.sh")), "info"],
        capture_output=True, text=True, check=True, timeout=60,
    )
    hosts = [line.removeprefix("Certificate hostname: ")
             for line in info.stdout.splitlines()
             if line.startswith("Certificate hostname: ")]
    if len(hosts) != 1:
        raise ProbePrecondition()

    stage = "connecting"
    connection = _db_connect(hosts[0], "gootip_auth", master["password"])
    stage = "validating"
    with connection.cursor() as cursor:
        cursor.execute(LOGGING_GATE_QUERY)
        gate = cursor.fetchone()[0]
    identity = gate.get("session") or {}
    if (identity.get("user"), identity.get("database"), identity.get("ssl"),
            identity.get("tls_version")) != ("gootip_auth", DATABASE, True, "TLSv1.3"):
        raise ProbePrecondition()
    validate_logging_settings(gate["settings"], set(gate["extensions"]))
    connection.commit()

    diagnostic_password = secrets.token_urlsafe(32)
    stage = "preparing_transaction"
    try:
        with connection.transaction():
            with connection.cursor() as cursor:
                cursor.execute("SET LOCAL pg_stat_statements.track_utility = off")
                cursor.execute("SET ROLE gootip_credential_function_owner")
                stage = "executing_function"
                cursor.execute(
                    "SELECT credential_admin.set_runtime_password(%s, %s)",
                    ("auth_runtime", diagnostic_password),
                )
            raise RollbackProbe()
    except RollbackProbe:
        result = {"outcome": "function_succeeded_transaction_rolled_back", "stage": stage}
    except psycopg.Error as error:
        result = {
            "outcome": ("function_rejected_transaction_rolled_back"
                        if stage == "executing_function"
                        else "transaction_preparation_failed"),
            "stage": stage,
            "sqlstate": error.sqlstate if isinstance(error.sqlstate, str) else None,
        }
        connection.rollback()
    print(json.dumps(result, separators=(",", ":")))
except psycopg.Error as error:
    print(json.dumps({
        "outcome": "database_precondition_failed",
        "stage": stage,
        "sqlstate": error.sqlstate if isinstance(error.sqlstate, str) else None,
    }, separators=(",", ":")))
except ProbePrecondition:
    print(json.dumps({"outcome": "precondition_failed", "stage": stage}, separators=(",", ":")))
except Exception:
    print(json.dumps({"outcome": "diagnostic_aborted", "stage": stage}, separators=(",", ":")))
finally:
    if connection is not None:
        try:
            connection.rollback()
        except Exception:
            pass
        try:
            connection.close()
        except Exception:
            pass
```

Interpretation: `function_succeeded_transaction_rolled_back` shows the fixed
function can update the Auth role under its owner authority; the test made no
persistent password change. `function_rejected_transaction_rolled_back`
provides the original SQLSTATE from the failed `ALTER ROLE` without its message
or parameters, distinguishing the concrete PostgreSQL denial to correct. Any
`transaction_preparation_failed`, precondition, connection, or gate failure
aborts before `ALTER ROLE`; no result from those failures authorizes a password
retry. This probe and the
function revision must be reviewed and explicitly authorized together before
recreating temporary access. Do not run a runtime rotation as part of this
probe.

## Executed diagnostic and correction — 2026-11-05

The endpoint discovery correction was applied and tested against the exact
Python block above with simulated clients: Provisioner uses Secrets Manager
only; `db_access.sh info` uses its existing database-operator profile.

In RDS, the fresh master session passed the logging/TLS gate. The fixed-owner
function was updated to preserve only the original SQLSTATE with a fixed error
message. One Auth-only call succeeded under the function owner and was rolled
back unconditionally. No Secrets Manager version was published and no runtime
password change was committed. This proves owner-side execution, not the full
operator rotation or application adoption.

A second, settings-only diagnostic reproduced a concrete activation defect.
The operator is `NOINHERIT`: a default `GRANT pg_read_all_settings` produces
membership without effective settings privileges. Under that role, the helper's
settings validation failed. With the exact grant `WITH INHERIT TRUE, SET FALSE,
ADMIN FALSE`, effective settings privileges and settings validation both passed.
Both grant variants ran in transactions that were rolled back. The operator
remained `NOLOGIN` with no settings membership afterward. A `SET ROLE` session
was used only to test effective settings, not to assert a fresh operator-login
TLS identity.

The activation runbook now specifies those exact membership options. The
local PostgreSQL integration test proves the default grant is ineffective for
a `NOINHERIT` login and that the corrected grant is effective without `SET` or
`ADMIN`. The historical attempts have no original SQLSTATE, so this result does
not retroactively identify their exact failure; it resolves a reproduced
pre-write blocker. The next real campaign must still verify its fresh operator
session, Auth/Core adoption and final closeout.

## Live campaign result — 2026-11-05

The authorized campaign used the corrected inherited settings grant and an
in-memory, randomly generated operator password. Activation used a libpq SCRAM
verifier inside the same transaction-local utility tracking exclusion as psql's
password command. A disposable PostgreSQL test verified this activation form.
The fresh operator TLS session passed the full logging gate in RDS.

Auth changed its PostgreSQL password and published a new Secrets Manager
version. The first immediate verification read returned `InvalidRequestException`;
read-only reconciliation then confirmed the exact new `AWSCURRENT` version and a
fresh TLS 1.3 login as `auth_runtime`. This established the database/secret pair,
not adoption by the deployed application. Auth's JWKS request had returned 200
before the change, then returned three consecutive 503 responses afterward.
Core was not started. The existing Auth Lambda logs did not identify the cause
of the application failure during the initial read-only inspection.

Recovery restored the original Auth password in PostgreSQL and published the
matching payload as a new secret version, without moving a staging label
backward. Fresh verified TLS and an HTTP 200 from Auth confirmed recovery.
The operator was disabled and its temporary grants were revoked; the reviewed
Terraform close plan removed seven temporary IAM resources and reverted two
assume-policy updates. The signing secret was not touched. Final SPEC 10.1
acceptance remains pending.

The sanitized local ledger is
`artifacts/validation/credential-campaign-20261105T185020Z.json`. It records five
HTTP requests. Initial connection sampling was visibility-limited; resumed
read-only aggregate sampling used `pg_stat_database.numbackends` and observed a
peak of five connections. Do not infer full campaign monitoring coverage from
that resumed sample. Diagnose the deployed Auth bootstrap/refresh failure before
another runtime credential transition; do not treat the successful role function
or matching TLS pair as proof of application adoption.

### Auth adoption diagnosis

API Gateway logged integration status 503 for all three failed JWKS requests.
CloudWatch places the five campaign requests in the same Lambda log stream.
The deployed Node.js 24 ZIP hash matches the local ZIP. The first Auth runtime
secret read and TLS validation occurred at 18:50:50 UTC. The new version was
published at 18:50:58 UTC. The three requests at 18:53:10, 18:55:22, and 18:55:33
UTC reached the warm environment before its five-minute refresh was due.
CloudTrail recorded no Auth Lambda runtime-secret read during that interval.
The next read and successful TLS validation occurred at 18:55:51 UTC, after
publication of the restored credential at 18:55:47 UTC. API Gateway then
recorded HTTP 200. The signing secret's optional AWSPREVIOUS lookup returned
ResourceNotFoundException in both successful invocations, as handled by the
loader.

The deployed Auth code uses a 300-second refresh interval by default, while
its PostgreSQL pool closes idle connections after 10 seconds. PostgreSQL 18
with the repository's pool, refresh coordinator, and HTTP error handler
reproduced the sequence with fictitious credentials. A fresh connection using
the new password succeeded. After the idle connection closed, the warm pool
opened a connection with the old password and PostgreSQL returned `28P01`.
The request returned 503 with zero secret reads before refresh. At the scheduled
refresh, the replacement pool connected and the request returned 200.

This identifies the warm-pool reconnection window as the reproduced failure
mechanism. RDS file log access returned AccessDenied, so the SQLSTATE is direct
local evidence and the same live error is an inference from the correlated AWS
timeline. The later successful read used the restored credential, leaving live
adoption of the new credential unverified. Record this as an Auth runtime
refresh gap rather than a failure of the PostgreSQL role function or the
Secrets Manager publication. A targeted recovery at the connection acquisition
boundary can refresh the credential on authentication rejection before SQL runs.
Avoid replaying an entire request that may already have executed writes.

Sanitized evidence is in
`artifacts/validation/auth-credential-adoption-diagnostic-20261105.json`.

### Verified reconnect recovery

On 2026-11-05, Auth and Core each added a pool checkout before dispatch on
database-backed API paths. PostgreSQL authentication rejection (`28P01`) can
trigger one credential refresh and checkout against the replacement generation.
The request is dispatched once. Both handlers passed a disposable PostgreSQL 18
TLS test with rotation before the scheduled refresh. Separate saved Terraform
plans updated only the respective dev Lambda code.

The subsequent live rotations published and verified a new credential for each
runtime identity through fresh TLS. JWKS and the catalog each returned HTTP 200
before and after their respective rotations. The two observations for each
service came from the same Lambda environment, 14.8 seconds apart for Auth and
12.3 seconds apart for Core. PostgreSQL showed replacement TLS connections and
retirement of the observed old connections for both services. Peak observed
client connections were six for Auth and eight for Core. The PostgreSQL operator
was disabled, temporary IAM was removed, and the tunnel host was stopped.

Private evidence is in `artifacts/validation/credential-reconnect-auth-20261105T192648Z.json`
and `artifacts/validation/credential-reconnect-core-20261105T192916Z.json`.
### Verified Auth signing transition

On 2026-11-05, Auth adopted signing version 2 and retained version 1 in the
application secret. The campaign verified the signature on the new browser
cookie. The earlier cookie required sign-in again while its session remained
in PostgreSQL. A new sign-in worked and the JWTs issued before and after the
transition verified against the same persisted RSA key. The campaign closed its
test sessions, including one from an earlier preflight stop, and stopped the
tunnel host. Both database runtime secret versions were unchanged.

All 23 application requests in the successful run returned HTTP 200. One prior
attempt stopped before sending requests and a second stopped after a single
sign-in, both before publication. The SQL monitor sampled over verified TLS,
but the `pg_stat_activity.backend_type` filter excluded other roles' sessions
for the operator identity. Its observed count cannot establish the aggregate
peak. The shared runner now uses `pg_stat_database.numbackends` for its total.
CloudWatch reported a maximum of two RDS database connections in each of its
five one-minute samples covering the window. This supports the observation but
cannot establish the required two-second SQL peak.

Private evidence is in `artifacts/validation/credential-signing-auth-20261105T194946Z.json`.
