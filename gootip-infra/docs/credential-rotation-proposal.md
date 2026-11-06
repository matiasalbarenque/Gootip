# SPEC 10.1 credential-rotation proposal — for review only

**Status:** Proposed; not approved for provisioning or live execution. No AWS or PostgreSQL permissions or credentials were changed while preparing this document.

**Requested human provisioner:** The user has identified themselves as the human provisioner. This identifies the operator but does not grant PostgreSQL or AWS permissions; the proposed RDS-master installation exception and temporary grants below still require explicit approval.

## Existing bindings and boundaries

The current `environments/dev.tfvars` identifies the existing Secrets Manager containers:

| Service | PostgreSQL login | Existing secret ARN |
| --- | --- | --- |
| Auth | `auth_runtime` | `arn:aws:secretsmanager:us-east-2:123456789012:secret:gootip-dev-auth-runtime-Ab1Cd2` |
| Core | `core_runtime` | `arn:aws:secretsmanager:us-east-2:123456789012:secret:gootip-dev-core-runtime-Ab1Cd2` |

These are references, not secret values. Reconfirm the exact ARNs with read-only `DescribeSecret` immediately before a future approval; do not infer or wildcard secret suffixes.

### Read-only AWS review (2026-11-04)

Using existing `GootipTerraformDeploy` and `GootipDatabaseOperator` sessions only, the read-only review confirmed RDS `gootip-dev` is PostgreSQL 18.6, `available`, attached to `gootip-dev-postgres18` (`in-sync`), with `rds.force_ssl=1` and no CloudWatch log exports. The custom parameter-group query returned `null`/`engine-default` for the selected logging parameters; that is not proof of their effective server values. `rds:DescribeEngineDefaultParameters` was denied to the deployment role; the effective values were then obtained through the separately approved read-only TLS database session below.

The authorized read-only session used the existing `db_access.sh` tunnel and verified `current_user=gootip_dev_operator`, `current_database=gootip`, and TLS 1.3. The prior query had **not queried** `log_parameter_max_length_on_error`; the new query returned `0 B` (`default`). `log_parameter_max_length=-1 B` was also confirmed. These settings govern different paths: `log_parameter_max_length_on_error` controls bind values attached to error reports, while `log_parameter_max_length` controls bind values in statement log messages. `log_min_error_statement=error` is active, but the error path has bind-parameter logging disabled. Statement logging is inactive: `log_statement=none`, `log_min_duration_statement=-1`, `log_min_duration_sample=-1`; `log_statement_sample_rate=1` is inert while its duration threshold is disabled, and `log_transaction_sample_rate=0`. Thus the unlimited statement parameter limit is not used by those observed built-in statement logging paths; it need not be changed to `0` to pass this specific condition. Other server logs are active (`log_checkpoints=on`, `log_autovacuum_min_duration=10000ms`, destination `stderr`); they are not statement/bind logging. `pg_extension` returned only `plpgsql`, so pgAudit is not installed in this database; no `pgaudit.*` rows were returned. However, the query specifically included the built-in `shared_preload_libraries` and `session_preload_libraries` settings and got no rows for either. Those are **queried but hidden from this role**, not merely omitted from the query; `local_preload_libraries` was visible and empty. The gate therefore remains **unverified** for preloaded logging extensions, despite the confirmed built-in bind-parameter protections. The host was started for this read and confirmed `stopped`; no parameters or database grants changed.

### Existing-session permission check (2026-11-04)

STS checks with explicit configured profiles found active sessions for `gootip-db-operator` (`GootipDatabaseOperator`), `gootip-bootstrap-admin`, `gootip-terraform-deploy`, `gootip-dev`, and `gootip-mfa`. The configured `gootip-credential-operator` and `gootip-credential-provisioner` profiles do not exist; `gootip-spec08-readonly` is expired. AWS role sessions do not confer PostgreSQL settings privileges. Through the active `gootip-db-operator` tunnel, PostgreSQL confirmed `current_user=gootip_dev_operator` and `pg_has_role(current_user, 'pg_read_all_settings', 'MEMBER') = false`. An exact second read confirmed `log_parameter_max_length_on_error` is visible, while `shared_preload_libraries` and `session_preload_libraries` return no rows to this role. The tunnel host was stopped after the check.

No existing profile/DB login can perform the remaining settings read. In the proposed combined campaign, the provisioner/master runs the exact read-only logging query first; during activation, `pg_read_all_settings` is granted temporarily to the existing `gootip_credential_operator` so the helper can repeat the gate in its write session. This is a PostgreSQL role grant, not IAM/MFA, and has not been made. It is revoked at closeout. No auxiliary PostgreSQL reader role is proposed, and no query is being assigned to the human merely because they are human.

`secretsmanager:DescribeSecret` for the RDS master secret and both runtime containers was denied to the deployment role by an explicit deny in `GootipTerraformDeployPermissions`; removing or changing that deny would be required before an identity-policy allow could work. `GootipDatabaseOperator` has no identity-policy allow for those exact ARNs. `rds:DescribeDBParameters` was denied to `GootipDatabaseOperator` for `gootip-dev-postgres18` (the deployment role could read the custom group). No secret values were requested or read. If another metadata review is required, the minimum additional read actions are `secretsmanager:DescribeSecret` on the three exact secret ARNs, `rds:DescribeDBParameters` on the exact parameter group, and `rds:DescribeEngineDefaultParameters` for `postgres18` in `us-east-2`; do not grant these as part of this proposal without a separate authorization. For effective SQL values, use an already-authorized database session; no AWS permission alone substitutes for `SHOW`.

Keep `gootip_dev_operator`, its PostgreSQL grants, the `gootip-db-operator` profile, and the existing `GootipDatabaseOperator` AWS policy unchanged. That identity has data access only and is not an authorized runtime-role password changer. Do not use `db_config`, migration identities, or application identities as a workaround.

## Proposed PostgreSQL authority

PostgreSQL 18 does not provide a built-in grant that means “may change only these passwords.” Its `CREATEROLE` capability allows more than password changes; role administration also depends on `ADMIN` membership options. Therefore, do not grant `CREATEROLE`, `ADMIN`, or runtime-role membership directly to the interactive login.

Review a narrowly exposed, fixed-purpose PostgreSQL function as the candidate mechanism:

1. A reviewed database provisioning authority creates a `NOLOGIN` function-owner role and one `SECURITY DEFINER` function in a locked-down schema. Its implementation accepts a target key from a hard-coded allowlist (`auth_runtime`, `core_runtime`) and a new password; it accepts no arbitrary SQL, role name, schema, or command.
2. For PostgreSQL 18, the function owner would need `CREATEROLE` plus `ADMIN OPTION` on only the two target roles to alter their passwords. That is **not** a password-only grant: it also enables role administration (including changing other role attributes and dropping those targets). Keep this capability on the `NOLOGIN` function owner, never grant it or target-role membership to the interactive login, and accept this residual privilege only if security review approves the function boundary. During an approved window, the operator receives `CONNECT`, schema `USAGE`, function `EXECUTE`, and temporary `pg_read_all_settings`; it receives no runtime-role/function-owner membership, `CREATEROLE`, schema create, table access, or ownership. The settings-read membership is revoked at closeout.
3. Revoke function execution from `PUBLIC`; set a safe fixed `search_path`; fully qualify referenced objects; use identifier/literal-safe quoting; review function ownership and effective privileges. Test attempts to change any other role, modify role attributes/membership, execute arbitrary SQL, and call the function from another schema.
4. The user has identified themselves as the human provisioner. The proposed one-time `gootip_auth` RDS-master exception and all exact grants remain unapproved; no DDL or grant may be run until they are explicitly approved.
5. Before accepting this design, verify RDS PostgreSQL 18 behavior for the exact function owner and target-role grants in an isolated disposable database, and verify database/audit logging does not record plaintext passwords or reusable password verifiers. Stop if that logging guarantee cannot be established.

This is a candidate, not a claim that PostgreSQL has a password-only role grant. If the function owner still has unacceptably broad role-admin power or the audit/logging controls cannot be made safe, do not provision it; obtain a separately reviewed alternative.

### One-time RDS-master installation exception — proposed, not authorized

An elevated database principal is required to create the function owner and grant its exact role-admin membership. The existing `gootip_dev_operator` cannot do that (`NOCREATEROLE`, no runtime-role administration membership); no other approved PostgreSQL provisioner is recorded. For this **one-time installation only**, the proposal is to use the RDS master login `gootip_auth` over the existing private `verify-full` tunnel. The RDS master is an RDS `rds_superuser` member with role-creation and grant capability, not a PostgreSQL superuser. This is a narrow proposed exception to SPEC 10.1's “do not use the RDS master” stop condition; it needs explicit approval before use.

The exception would permit only creation/verification of the fixed function, its non-login owner, and its fixed execute-only caller. It would **not** permit changing either runtime password as the master, using the master for normal rotation, reading application data, granting `rds_superuser`, or using `db_config`. After installation, the master session is closed; future password changes would execute only through the SECURITY DEFINER function. If this exception is declined, installation must stop until a different provisioner is explicitly authorized.

The master credential is in the exact RDS-managed secret reference from `environments/dev.tfvars`:

`arn:aws:secretsmanager:us-east-2:123456789012:secret:rds!db-00000000-0000-4000-8000-000000000000`

AWS documents that the RDS PostgreSQL master is not a full PostgreSQL superuser but can create roles and grant privileges. See the AWS reference below.

### Proposed private-terminal installation procedure

This procedure is a proposal only. Approval must cover (a) the one-time RDS-master exception, (b) the temporary AWS policy below, and (c) the function owner's residual role-admin capability. Do not run it while the rotation remains unapproved.

1. From the repository root, verify the `gootip-db-operator` AWS identity and obtain the endpoint/CA with `gootip-infra/scripts/db_access.sh info`. Start/reuse its foreground tunnel with `gootip-infra/scripts/db_access.sh tunnel`. Do not stop an already shared tunnel/host.
2. Assume the proposed one-hour `gootip-credential-provisioner` MFA role; verify `aws sts get-caller-identity` shows that exact role and account. Fetch only the exact master SecretString into a shell variable (no terminal output), validate `username == gootip_auth`, and pass the password only in the child `psql` process environment. Example from the repository root after the temporary role is provisioned:

   ```bash
   set +x
   set -euo pipefail
   trap 'unset MASTER_SECRET_JSON PGPASSWORD' EXIT INT TERM
   aws --profile gootip-credential-provisioner sts get-caller-identity
   MASTER_SECRET_JSON="$(aws --profile gootip-credential-provisioner --region us-east-2 \
     secretsmanager get-secret-value \
     --secret-id 'arn:aws:secretsmanager:us-east-2:123456789012:secret:rds!db-00000000-0000-4000-8000-000000000000' \
     --query SecretString --output text)"
   test "$(jq -er .username <<<"$MASTER_SECRET_JSON")" = 'gootip_auth'
   export PGPASSWORD="$(jq -er .password <<<"$MASTER_SECRET_JSON")"
   unset MASTER_SECRET_JSON
   RDS_HOST='<exact Certificate hostname printed by db_access.sh info>'
   psql "host=$RDS_HOST hostaddr=127.0.0.1 port=15432 dbname=gootip user=gootip_auth sslmode=verify-full sslrootcert=gootip-infra/.db-access/rds-ca-bundle.pem connect_timeout=5" -X
   unset PGPASSWORD
   trap - EXIT INT TERM
   ```

   Never enable shell tracing in this subshell. The password is not printed or stored in a file/argument/history; it exists in the local shell/psql process memory only. The endpoint hostname—not `localhost`—must be the `host` for TLS verification.
3. Connect as `gootip_auth` to database `gootip` through `127.0.0.1:15432`, with the discovered endpoint as `host`, `sslmode=verify-full`, and `.db-access/rds-ca-bundle.pem`. The combined logging/session query in the next section is the first SQL command in this session. It must establish `current_user=gootip_auth`, `current_database=gootip`, verified TLS, and return every setting needed by the gate. If the query is incomplete, any requirement fails, or a logging path is unknown, stop the session; perform no role/function DDL and do not change parameters.
4. Only after the logging gate passes, check that none of the proposed role names, schema, or function already exists. If there is any collision or unexpected privilege, stop; do not use `IF NOT EXISTS` to hide drift.
5. In the master `psql` session, create the non-login function owner, temporarily grant it database `CREATE`, and create the `NOLOGIN` caller. The RDS master created the owner role and retains the creator's automatic membership, so use `SET ROLE` directly as the master to create and own the function. The operator is never enabled or granted role membership during installation. Use this SQL only after verifying the exact login and empty-name preconditions:

   ```sql
   BEGIN;
   CREATE ROLE gootip_credential_function_owner NOLOGIN CREATEROLE;
   GRANT auth_runtime, core_runtime TO gootip_credential_function_owner
     WITH ADMIN TRUE, SET FALSE, INHERIT FALSE;
   GRANT CREATE ON DATABASE gootip TO gootip_credential_function_owner;

   CREATE ROLE gootip_credential_operator
     NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
   GRANT CONNECT ON DATABASE gootip TO gootip_credential_operator;
   COMMIT;
   ```

6. Still in the master `psql` session, create the function under the owner identity, then grant the caller schema usage and function execution. Do not call the function:

   ```sql
   SET ROLE gootip_credential_function_owner;
   CREATE SCHEMA credential_admin;
   CREATE OR REPLACE FUNCTION credential_admin.set_runtime_password(target_name text, new_password text)
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
   REVOKE CREATE ON DATABASE gootip FROM gootip_credential_function_owner;
   ```

   No temporary login, password, membership, schema `USAGE`, or function `EXECUTE` is granted to the caller. No live runtime password is changed by this runbook.
7. Verify the function and grants below. Since the operator has remained `NOLOGIN` and has no role membership, it cannot invoke the function. The function owner retains `CREATEROLE` and ADMIN only on the two runtime roles; the temporary database `CREATE` grant has already been removed.
8. Close the master session after installation verification. For the combined campaign below, retain the provisioner AWS role only until the operator has been disabled and final AWS cleanup is applied; do not use it for runtime-password changes.

   The RDS master keeps its pre-existing RDS administration capability and the automatic creator membership on the owner role; that is part of the explicit installation exception and must not be confused with a grant to `gootip_dev_operator`.

### Approved-window activation, private credential handoff, and disablement

This is the proposed complete activation protocol, not an authorization to execute it. The window approver must approve a target service, expected prior secret VersionId, operator identities, maintenance lock, maximum 60-minute cutoff, and recovery coverage. If any prerequisite is missing, leave the database role `NOLOGIN` and do not start.

| Operation | Actor | Required authority |
| --- | --- | --- |
| Approve window and rollback coverage | Project owner/change approver, distinct review required | No runtime credential access; approves exact service/window/VersionId and recovery operator |
| Create/assume short-lived AWS sessions | Reviewed Terraform plans; human operator assumes through MFA profiles | Provisioner: only Get/Describe exact RDS master secret for install/enable/disable; rotation operator: Get/Describe/Put exact Auth/Core secrets. Neither role has IAM, RDS, KMS decrypt, or wildcard secrets access |
| Enable/disable DB login | Human provisioner using RDS master `gootip_auth` over private `verify-full` tunnel | Existing RDS master authority. This is a proposed extension of the one-time master exception, explicitly requiring approval for every window; only `ALTER ROLE gootip_credential_operator` login/password/expiry and session termination, never runtime password changes |
| Change runtime password and verify DB identity | Human rotation operator using `gootip_credential_operator` | `CONNECT`, schema `USAGE`, function `EXECUTE`, and temporary `pg_read_all_settings`; no runtime-role membership, `CREATEROLE`, or direct role alteration |
| Publish/reconcile secret and validate service | Human rotation operator | Exact runtime-secret Get/Describe/Put policy; application health access already authorized by SPEC 10.1 |
| Emergency recovery if operator is unusable | Named recovery operator approved before window; normally the provisioner | Exact secret Get/Describe/Put plus DB master only under a separately approved emergency grant/session. Directly changing a runtime password as master is outside the normal design and requires an explicit, incident-specific exception; never infer that authority |

The human operator can be the same person for all these duties, but role separation remains enforced at the AWS/PostgreSQL permission boundary. This campaign uses the provisioner and rotation AWS roles only for the bounded campaign, then removes both. No auxiliary PostgreSQL reader role is created. Since the implemented helper reads server settings itself, activation temporarily grants `pg_read_all_settings` to the existing `gootip_credential_operator`; this exposes server configuration during the approved window and must be included in approval, then revoked during closeout.

For an approved window, the provisioner opens a fresh master session as in steps 1–4 above. The combined logging/session query is its first SQL command; if the gate fails, close the session and perform no DDL/grants. After a pass, grant temporary function access and settings-read membership as master. A `NOTICE` that `pg_read_all_settings` is already granted, including one naming `rdsadmin` as grantor, is not by itself a failed precondition: do not infer ownership from the grantor or abort on historical attribution. Check the effective membership, keep the operator `NOLOGIN` until activation, and remove the membership with the normal closeout `REVOKE` below. Before introducing the operator password, test `SET LOCAL pg_stat_statements.track_utility=off` as PostgreSQL login `gootip_auth` inside a transaction, then roll back and verify restoration to `on`. This PostgreSQL role is distinct from the IAM provisioner role. Use psql's hidden `\\password gootip_credential_operator` prompt to set a randomly generated temporary password only inside the transaction-local exclusion below. Retain the password only in the operator's private password manager (not chat, shell, command args, file, or SQL):

```sql
SET ROLE gootip_credential_function_owner;
GRANT USAGE ON SCHEMA credential_admin TO gootip_credential_operator;
GRANT EXECUTE ON FUNCTION credential_admin.set_runtime_password(text, text)
  TO gootip_credential_operator;
RESET ROLE;
GRANT pg_read_all_settings TO gootip_credential_operator
  WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
```

The function-owner membership used by the master here is its automatic creator membership; the interactive operator receives no membership in the function owner or runtime roles. Its only temporary predefined-role membership is `pg_read_all_settings`. Because the login is `NOINHERIT`, this grant explicitly uses `INHERIT TRUE`; verify effective `USAGE` with `pg_has_role`, not only `MEMBER`. It grants neither role administration nor `SET ROLE` for the settings role. Then, in one psql session, the provisioner activates the login. The `\\password` command prompts without echoing the password; `SET LOCAL` and that command must remain inside this explicit transaction. After commit, verify the effective setting is `on` and `pg_settings.reset_val` remains `on`:

```sql
BEGIN;
SET LOCAL pg_stat_statements.track_utility = off;
\\password gootip_credential_operator
ALTER ROLE gootip_credential_operator LOGIN VALID UNTIL '<UTC_CUTOFF_WITHIN_60_MINUTES>';
SHOW pg_stat_statements.track_utility; -- must be off before COMMIT
COMMIT;
SHOW pg_stat_statements.track_utility; -- must be on after COMMIT
```

The placeholder must be replaced by the exact approved UTC cutoff; never use `VALID UNTIL 'infinity'`. Close the master session and unset its secret from local process memory. Convey the operator password only through the private password manager. The operator uses the `gootip-credential-operator` MFA profile and private tunnel. The helper's first SQL check in each write session is the logging gate, followed by database/TLS identity assertion and a bound function call; it never interpolates password SQL.

After a healthy matching DB/secret pair and service adoption are verified, the provisioner reconnects as master and runs:

```sql
ALTER ROLE gootip_credential_operator NOLOGIN PASSWORD NULL VALID UNTIL 'epoch';
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
WHERE usename = 'gootip_credential_operator' AND pid <> pg_backend_pid();
```

Then, as master, terminate sessions and remove the window-specific schema/function privileges. Revoke `pg_read_all_settings` with the ordinary `REVOKE` below even if its recorded grantor is `rdsadmin`; do not assume `rdsadmin`, use `CASCADE`, edit catalog tables, or modify AWS-managed roles. If PostgreSQL rejects the normal `REVOKE`, preserve the exact SQL command, SQLSTATE, and server error and stop; do not reinterpret a database denial as missing human approval. No parameter grant is needed or added when the direct preflight succeeds:

```sql
SET ROLE gootip_credential_function_owner;
REVOKE EXECUTE ON FUNCTION credential_admin.set_runtime_password(text, text)
  FROM gootip_credential_operator;
REVOKE USAGE ON SCHEMA credential_admin FROM gootip_credential_operator;
RESET ROLE;
REVOKE pg_read_all_settings FROM gootip_credential_operator;
```

Verify `rolcanlogin=false`, `rolvaliduntil` is expired, no operator sessions remain, `pg_has_role(..., 'pg_read_all_settings', 'MEMBER')=false`, and the role has no runtime/owner membership or role-creation attributes, schema `USAGE`, or function `EXECUTE`. Do not require the historical grantor to match the current provisioner; the effective membership must be absent after the normal `REVOKE`. Remove the temporary password from the private password manager. Apply the final reviewed Terraform plan to remove both temporary AWS roles/policies, source-user assume grants, and the bootstrap lifecycle grant. If state is uncertain, preserve only the approved recovery path until reconciliation finishes; never extend this login without fresh approval. If compromise is suspected, revoke it immediately and use the separately authorized recovery path.

The helper implementation exists, including exact AWS clients, secret version checks, bound PostgreSQL calls, recovery, redaction, and first-query logging validation. `LIVE_EXECUTION_ENABLED` remains hard-coded false; the procedure below requires an explicit campaign-specific code approval to enable it, plus resetting it to false after closeout. Do not substitute ad hoc rotation SQL or CLI commands for the helper.

### Password/audit logging gate

AWS warns that `log_statement=ddl` or `all` can log role passwords in clear text; psql `\\password` can still emit the reusable verifier if statement logging captures it. The installation and any future function call must not proceed unless the current configuration is understood and verified safe. Read, without changing parameters:

```sql
SHOW log_statement;
SHOW log_min_duration_statement;
SHOW log_min_error_statement;
SHOW log_parameter_max_length;
SHOW log_parameter_max_length_on_error;
SHOW log_destination;
SHOW logging_collector;
SHOW log_line_prefix;
SHOW shared_preload_libraries;
SHOW password_encryption;
SHOW pgaudit.log;
SHOW pgaudit.log_parameter;
```

The campaign's first provisioner SQL command and each helper write session use the shared `LOGGING_GATE_QUERY` in `scripts/credential_rotation_live.py`. It returns the effective `password_encryption`, logging settings, the three preload settings, `pg_stat_statements.*`, `pgtle.*`, the RDS force-logging settings exposed by the engine, and installed extension names. The disposable PostgreSQL integration test executes this exact query and asserts all mandatory fields, including `password_encryption`, are returned. The provisioner/master must be able to read all mandatory settings; if it cannot, or if the gate fails, no DDL/grant follows. The query returns setting metadata only, not secret values. For the later helper session, the exact direct-read capability is temporarily granted to the existing operator as `pg_read_all_settings`; no auxiliary reader role is created. This membership is revoked at closeout.

The query intentionally returns the actual `password_encryption` setting (not just the SQL command used to inspect it). The independent session/TLS identity check remains required before any write.

Gate logic is combination-based: error bind parameters must always be disabled (`log_parameter_max_length_on_error=0`). `log_parameter_max_length=0` is required only if statement text can be emitted (`log_statement` other than `none`, a nonnegative duration threshold, an enabled sample threshold/rate combination, or nonzero transaction sampling); otherwise values such as `-1` are inert for statement bind logging. A sample rate of `1` does not activate sampling when `log_min_duration_sample=-1`. Require `password_encryption=scram-sha-256`. If pgAudit is installed/active, require `pgaudit.log_parameter=off` and review `pgaudit.log`. Check RDS exports/CloudWatch destinations and external audit paths separately; SQL settings cannot prove those destinations are absent.

#### Observed preload review (2026-11-04)

The live value was `rdsutils, pg_tle, pg_stat_statements, rds_casts`; the only installed extension was `plpgsql`. A preload is not accepted merely because it is AWS-supplied or absent from `pg_extension`.

| Preload | Relevant behavior/configuration | Acceptance for this operation |
| --- | --- | --- |
| `pg_stat_statements` | PostgreSQL stores representative query text and statistics. The gate reads `pg_stat_statements.track`, `pg_stat_statements.track_utility`, and `track_activity_query_size` (plus every exposed `pg_stat_statements.*` setting). | Accept `track=top`, either visible `track_utility=on` or `off`, and visible positive query-text size, with no extra logger that captures bind values. Runtime changes use a parameterized top-level function call; with `track=top`, the nested `ALTER ROLE` is not tracked even when utility tracking is on. For any direct utility password operation such as `psql \\password`, run only that operation inside a transaction after `SET LOCAL pg_stat_statements.track_utility=off`; commit restores `on`. Missing settings or another tracking mode blocks. The extension was not installed in `gootip`; that alone does not prove the preload harmless. |
| `pg_tle` | TLE can register hooks whose functions run during PostgreSQL operations. The gate reads all exposed `pgtle.*`, including `pgtle.enable_password_check`, `pgtle.enable_clientauth`, `pgtle.passcheck_db_name`, and client-auth database selection. If `pg_tle` is installed in the current database, it checks `pgtle.feature_info`. | Accept only if every exposed `pgtle.enable_*` setting is `off`, both known enable settings are visible, and any installed feature registry is readable and empty. Any registered hook, enabled/required hook, missing setting, or unknown feature blocks. Hook inventory must cover the configured database targets; no assumption is made from the extension list in `gootip` alone. |
| `rdsutils` | AWS documentation shows it as an RDS preload; behavior relevant to credential exposure was not established. | **Accepted for this dev campaign only as an explicitly unverified residual-risk exception**, at the user's direction. This is not evidence that it cannot expose credentials. Other environments remain blocked pending authoritative review. |
| `rds_casts` | AWS documents `rds_casts` as an extension that adds supported casts between built-in PostgreSQL types and exposes cast creation/list/drop functions. This documents its stated purpose, not its logging or credential-exposure behavior. | **Accepted for this dev campaign only as an explicitly unverified residual-risk exception**, at the user's direction. This does not establish absence of credential exposure. Other environments remain blocked pending authoritative review. |

The code gate accepts only these four exact preloads; any additional preload remains blocked. The `rdsutils`/`rds_casts` exception is campaign-specific and does not assert that exposure was tested or disproved. The other preloads must satisfy the table's checks; any hidden setting, unknown hook, or logging path blocks. Do not disable a preload/extension or change parameters to pass.

#### Local PostgreSQL 18 lifecycle result (2026-11-04)

`bash scripts/tests/test_credential_rotation_pgss.sh` passed against a disposable PostgreSQL 18 container with `pg_stat_statements` preloaded, `track=top`, `track_utility=on`, `track_activity_query_size=4096`, SCRAM password encryption, and statement logging disabled as in the RDS gate. The script explicitly changes the disposable container's loopback `pg_hba.conf` from `trust` to SCRAM and verifies no host `trust` rule remains, so valid and invalid password probes are meaningful.

The end-to-end fake-credential flow covered installation, provisional runtime passwords, transaction-local `\\password` activation, activation/login, two parameter-bound runtime rotations, recovery to the prior/published password, rejection of the superseded password, and closeout. At test end it scanned every `pg_stat_statements.query` against all six fictional plaintext passwords and current `pg_authid.rolpassword` verifiers and found no match. It also confirmed `track_utility` is `on` after each transaction and its `pg_settings.reset_val` remains `on`; the transaction-local override did not persist. The test revoked and verified removal of the exact parameter privilege, function execution/schema access, and operator login.

The only additional grant needed for the direct utility activation path is `GRANT SET ON PARAMETER pg_stat_statements.track_utility TO <temporary-provisioner>` (the temporary administrator that runs `\\password` and enables the operator login). Revoke it at closeout using the grantor/administrator that issued it. Keep `SET LOCAL pg_stat_statements.track_utility=off` and `\\password` in the same explicit transaction; do not issue the password operation outside it. The runtime rotation/recovery helper itself does not require this extra grant because its top-level calls are parameterized function invocations and the internal utility command is nested under `track=top`.

#### Retry outcome (2026-11-04)

The corrected shared query returned master identity `gootip_auth`, database `gootip`, TLS 1.3, all required logging fields including `password_encryption`, and the four expected preloads. `pg_stat_statements.track=top` and `track_activity_query_size=4096` were visible, while `track_utility=on`; the complete local test above now demonstrates that this setting is safe for the parameterized helper and that utility tracking can be disabled transaction-locally for the `\\password` activation statement. No AWS retry or RDS write was performed as part of resolving this local issue. TLE settings showed `pgtle.enable_password_check=off`, `pgtle.enable_clientauth=off`, empty `pgtle.passcheck_db_name`, and `pgtle.clientauth_db_name=postgres`; `pg_tle` was absent from `pg_extension` in both `gootip` and `postgres`, the configured client-auth database, and neither database had a feature registry to inspect. These observed disabled settings satisfy the TLE gate for the reviewed databases; they do not prove anything about internal `rdsadmin` state. The earlier live gate failure was limited to the implementation's unnecessarily strict `track_utility=off` requirement; no database parameter was changed.

Implementation note: `validate_logging_settings` implements the exact allowlist and rejects extra modules, unsafe/missing `pg_stat_statements` settings, and enabled/missing TLE password-check configuration. When `pg_tle` is installed, the helper also requires a readable empty `pgtle.feature_info`; registered hooks require separate code review and remain blocked by this gate.

References: [AWS TLE hooks](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL_trusted_language_extension.overview.tles-and-hooks.html), [AWS TLE hooks reference](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL_trusted_language_extension-hooks-reference.html), [AWS TLE function/feature registry](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL_trusted_language_extension-functions-reference.html), [AWS TLE setup](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL_trusted_language_extension-setting-up.html), [AWS PostgreSQL extensions](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.PostgreSQL.CommonDBATasks.Extensions.html), [AWS `rds_casts` for RDS PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.CustomCasts.html), and [PostgreSQL 18 `pg_stat_statements`](https://www.postgresql.org/docs/18/pgstatstatements.html). AWS's `rds_casts` documentation establishes its cast-management purpose, not absence of credential exposure; the campaign-specific residual risk for both `rdsutils` and `rds_casts` is explicitly accepted, unverified.

### Installation verification and eventual cleanup

As `gootip_auth`, verify:

```sql
SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
FROM pg_roles
WHERE rolname IN ('gootip_credential_function_owner', 'gootip_credential_operator');

SELECT pg_has_role('gootip_credential_operator', 'auth_runtime', 'MEMBER') AS auth_member,
       pg_has_role('gootip_credential_operator', 'core_runtime', 'MEMBER') AS core_member,
       pg_has_role('gootip_credential_operator', 'gootip_credential_function_owner', 'MEMBER') AS owner_member,
       has_function_privilege('gootip_credential_operator',
         'credential_admin.set_runtime_password(text,text)', 'EXECUTE') AS can_execute;

SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS function_owner
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'credential_admin' AND p.proname = 'set_runtime_password';
```

Expected after inert installation or final disablement: owner is `NOLOGIN` with `CREATEROLE` and ADMIN only on the two runtime roles; caller is `NOLOGIN`, passwordless, `NOCREATEROLE`, has no membership, and has no schema `USAGE` or function `EXECUTE`. It retains only `CONNECT`. During an approved active window it temporarily receives schema `USAGE` and function `EXECUTE`, which are revoked at disablement. The function is `SECURITY DEFINER`, owned by the non-login owner, has fixed `search_path=pg_catalog`, and `PUBLIC` has no schema/function privilege. Do not test it against live runtime roles; the disposable PostgreSQL 18 test covers function behavior.

After both DB transitions have been completed, application adoption and retired-generation cleanup are verified, and all recovery is closed, disable the temporary caller and remove the temporary AWS access. The dedicated function owner and function may be retained only if the project explicitly accepts the residual non-login role-admin capability for later approved rotations. Otherwise, a separately authorized cleanup must also remove the function/schema and owner role; do not improvise cleanup while the function owner is `NOLOGIN`.

```sql
ALTER ROLE gootip_credential_operator NOLOGIN PASSWORD NULL VALID UNTIL 'epoch';
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
WHERE usename = 'gootip_credential_operator' AND pid <> pg_backend_pid();
```

The `gootip_credential_function_owner` is not temporary while its function remains operational: it retains CREATEROLE plus ADMIN on two roles and is a material residual risk. If reviewers require complete removal after this campaign, first use a short separately authorized installer session to grant the disabled operator `SET TRUE` membership, connect as that operator, `SET ROLE gootip_credential_function_owner`, drop the function/schema, reset role and disconnect; then, as master, revoke the operator's membership, revoke the owner's runtime-role memberships, set `NOCREATEROLE`, revoke database CONNECT, and drop both roles. This teardown has not been locally validated on RDS and must be reviewed before use. Never drop/disable recovery authority before the pair is healthy.

## Proposed AWS authority

Keep the existing `gootip-db-operator` profile only for `db_access.sh` tunnel discovery/start/stop. Do not change `GootipDatabaseOperator`. The proposal uses two distinct temporary MFA-backed AWS roles:

1. `GootipCredentialProvisioner` / `gootip-credential-provisioner`, for the first-session logging read and bounded RDS-master installation/activation/disablement exception.
2. `GootipCredentialOperator` / `gootip-credential-operator`, for the later authorized runtime-secret transition only.

Both roles trust only the established source-user MFA trust contract and have a one-hour maximum session. The source user's assume-only policy and permissions boundary would receive only the exact role ARN while each temporary role exists.

Provisioner policy (read only on the exact RDS-managed master secret):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "ReadOnlyExactRdsMasterForOneTimeProvisioning",
    "Effect": "Allow",
    "Action": ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"],
    "Resource": "arn:aws:secretsmanager:us-east-2:123456789012:secret:rds!db-00000000-0000-4000-8000-000000000000"
  }]
}
```

Later rotation policy (only the two existing runtime secret ARNs):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "OperateOnlyExactRuntimeSecrets",
    "Effect": "Allow",
    "Action": ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"],
    "Resource": [
      "arn:aws:secretsmanager:us-east-2:123456789012:secret:gootip-dev-auth-runtime-Ab1Cd2",
      "arn:aws:secretsmanager:us-east-2:123456789012:secret:gootip-dev-core-runtime-Ab1Cd2"
    ]
  }]
}
```

Neither policy grants `ListSecrets`, `CreateSecret`, `DeleteSecret`, `UpdateSecret`, `UpdateSecretVersionStage`, `RotateSecret`, KMS decrypt, IAM, RDS, Lambda, Terraform-state, or broad Secrets Manager access. With the existing AWS-managed Secrets Manager key, do not add a KMS grant; re-check encryption metadata during approval. Secrets Manager API calls use the local workstation's HTTPS endpoint and do not require the PostgreSQL tunnel or a new VPC endpoint.

Both temporary roles are created for this single approved campaign, with the provisioner retained only to install, activate, disable, and recover the database operator. Exact source-user assume grants are limited to these role ARNs and removed with them. The feature flags remain default-false outside this reviewed campaign.

### Terraform review phases — commands intentionally not run

The existing backend evidence was reused: expected S3 backend/config, active `GootipBootstrapAdmin`, and remote state serial `134`/77 resources. No initialization or migration was run. The retained focused plan `bootstrap/artifacts/plans/credential-rotation-permission-first-focused.tfplan` contains exactly one create (`aws_iam_role_policy.credential_role_lifecycle[0]`); it only grants bootstrap temporary lifecycle management on the exact future role/policy ARNs. It does **not** create either role or authorize any PostgreSQL/secret operation. The unrelated deployment-policy updates from the non-targeted plan are excluded from all plans below and remain a separate review item.

The `GootipBootstrapAdmin` has no existing inline policies; the temporary inline document is 1,642 characters against the 10,240-character aggregate limit. No permission or credential changes were made. Generate each subsequent plan only after the prior reviewed plan is applied, then review/apply that exact saved filename. These focused targets intentionally exclude unrelated deployment-policy drift:

| Plan artifact | Lifecycle / provisioner / operator flags | Exact intended changes |
| --- | --- | --- |
| `credential-rotation-permission-first-focused.tfplan` (already saved) | `true / false / false` | One create: bootstrap inline lifecycle policy. |
| `credential-rotation-provisioner-create.tfplan` | `true / true / false` | Create provisioner role, exact master-secret policy and attachment; update the source-user assume policy and boundary to allow only the provisioner role. |
| `credential-rotation-operator-create.tfplan` | `true / true / true` | Create operator role, exact Auth/Core secret policy and attachment; update source-user assume policy and boundary to allow the operator role too. |
| `credential-rotation-campaign-close.tfplan` | `false / false / false` | Delete both temporary roles, their managed policies/attachments, and lifecycle inline policy; remove both source-user assume entries. Expected: seven deletes and two in-place source-policy updates, no replacements. |

Generate `credential-rotation-provisioner-create.tfplan` from `bootstrap/` after the permission-first plan has been separately reviewed/applied:

```bash
AWS_PROFILE=gootip-bootstrap-admin AWS_REGION=us-east-2 terraform plan -no-color -detailed-exitcode \\
  -out=artifacts/plans/credential-rotation-provisioner-create.tfplan \\
  -var-file=current-bootstrap.local.tfvars \\
  -var=eligibility_gate_passed=true -var=account_resource_phase_enabled=true \\
  -var=credential_role_lifecycle_enabled=true \\
  -var=credential_provisioner_role_enabled=true -var=credential_operator_role_enabled=false \\
  '-target=aws_iam_policy.source_user_assume_only_boundary' \\
  '-target=aws_iam_policy.source_user_assume_only' \\
  '-target=aws_iam_role.credential_provisioner[0]' \\
  '-target=aws_iam_policy.credential_provisioner_permissions[0]' \\
  '-target=aws_iam_role_policy_attachment.credential_provisioner_permissions[0]'
```

After installation succeeds and the logging gate passes again in the activation session, generate `credential-rotation-operator-create.tfplan`:

```bash
AWS_PROFILE=gootip-bootstrap-admin AWS_REGION=us-east-2 terraform plan -no-color -detailed-exitcode \\
  -out=artifacts/plans/credential-rotation-operator-create.tfplan \\
  -var-file=current-bootstrap.local.tfvars \\
  -var=eligibility_gate_passed=true -var=account_resource_phase_enabled=true \\
  -var=credential_role_lifecycle_enabled=true \\
  -var=credential_provisioner_role_enabled=true -var=credential_operator_role_enabled=true \\
  '-target=aws_iam_policy.source_user_assume_only_boundary' \\
  '-target=aws_iam_policy.source_user_assume_only' \\
  '-target=aws_iam_role.credential_operator[0]' \\
  '-target=aws_iam_policy.credential_operator_permissions[0]' \\
  '-target=aws_iam_role_policy_attachment.credential_operator_permissions[0]'
```

After both services are healthy and the DB operator login/privileges are closed, generate the final plan. Its deletes are intentional and require approval as the closeout actions:

```bash
AWS_PROFILE=gootip-bootstrap-admin AWS_REGION=us-east-2 terraform plan -no-color -detailed-exitcode \\
  -out=artifacts/plans/credential-rotation-campaign-close.tfplan \\
  -var-file=current-bootstrap.local.tfvars \\
  -var=eligibility_gate_passed=true -var=account_resource_phase_enabled=true \\
  -var=credential_role_lifecycle_enabled=false \\
  -var=credential_provisioner_role_enabled=false -var=credential_operator_role_enabled=false \\
  '-target=aws_iam_policy.source_user_assume_only_boundary' \\
  '-target=aws_iam_policy.source_user_assume_only' \\
  '-target=aws_iam_role_policy.credential_role_lifecycle' \\
  '-target=aws_iam_role.credential_provisioner' \\
  '-target=aws_iam_policy.credential_provisioner_permissions' \\
  '-target=aws_iam_role_policy_attachment.credential_provisioner_permissions' \\
  '-target=aws_iam_role.credential_operator' \\
  '-target=aws_iam_policy.credential_operator_permissions' \\
  '-target=aws_iam_role_policy_attachment.credential_operator_permissions'
```

Each plan must contain only the actions in its table row; stop for any replacement, unexpected delete, or unrelated deployment change. The close target uses unindexed resource addresses so it also handles an abort where the operator role was never created; deletes then cover only resources present in state. `-target` warnings remain applicable. Review and apply only the exact saved filename for that phase; never reuse a plan generated before the preceding phase's state change. The campaign-close plan removes AWS access only; database closure is performed and verified first as specified above.

### Joint execution proposal and approvals required

This is the single proposed campaign sequence; Terraform must first create the narrowly scoped temporary AWS access needed to open the master session. No PostgreSQL DDL, role grant, login enablement, or credential write occurs until that session's first SQL logging check passes. If it fails, stop DB writes and remove the temporary AWS access with a fresh close plan:

1. **Approve and apply permission-first** — review/apply the already saved `credential-rotation-permission-first-focused.tfplan`. Then generate, review, and apply `credential-rotation-provisioner-create.tfplan`. Configure the local MFA role profile `gootip-credential-provisioner` for ARN `arn:aws:iam::123456789012:role/gootip/operations/GootipCredentialProvisioner`; max session is one hour. Its only Secrets Manager grant is `DescribeSecret`/`GetSecretValue` on the exact RDS master secret ARN above.
2. **Logging first, then install** — assume the provisioner profile and open the private `verify-full` tunnel. Fetch the exact master secret in memory, validate `username=gootip_auth`, and open one master session. Run the combined logging/session query as that session's first SQL command. Require the current-user/database/TLS assertions and a complete logging result passing the combination-based gate. If any setting is missing/hidden, any logger is unknown, or any required condition fails, close the session without DDL, grants, or password changes; then generate a fresh campaign-close plan from current state and remove the temporary IAM access. If it passes, check for name collisions and perform only the documented creation of `gootip_credential_function_owner`, `gootip_credential_operator NOLOGIN`, and the fixed SECURITY DEFINER function. Never call the function in installation.
3. **Create rotation AWS role** — generate, review, and apply `credential-rotation-operator-create.tfplan`. Configure the local MFA profile `gootip-credential-operator` for ARN `arn:aws:iam::123456789012:role/gootip/operations/GootipCredentialOperator`. It may `DescribeSecret`/`GetSecretValue`/`PutSecretValue` only on the exact Auth/Core runtime secret ARNs. The provisioner role stays available only for PostgreSQL activation/disablement.
4. **Enable DB operator** — assume the provisioner profile and open a fresh master session; run the same logging/session query first again and stop without writes if it fails. Then grant schema `USAGE` and fixed-function `EXECUTE` under the function owner, grant `pg_read_all_settings` directly to the existing operator role (not a new reader), set its temporary password with hidden psql input, and set `LOGIN VALID UNTIL` to the approved UTC cutoff no more than 60 minutes away. If the grant returns a `NOTICE` that the membership already exists, including a grantor of `rdsadmin`, continue based on the effective membership rather than aborting on grantor attribution. Verify the exact grants and role attributes; close master and unset its password from memory.
5. **Run each approved rotation** — explicit code approval is required to change `LIVE_EXECUTION_ENABLED` from `False` to `True` for this campaign; the existing default remains false otherwise. From the MFA operator profile and private tunnel, run the helper once for Auth and once for Core with each service's exact expected `AWSCURRENT` VersionId. The helper's first SQL check in its write session is logging, followed by TLS/identity validation; it then changes the DB password through the fixed function and publishes one Secrets Manager version. After each service, verify the returned VersionId, fresh TLS runtime login, and service health before proceeding. Any failed gate, version race, TLS/network error, ambiguous write, or unhealthy service stops the next rotation and uses only the helper's pinned recovery path; never retry an ambiguous write blindly.
6. **Close** — as provisioner/master, set the operator `NOLOGIN`, clear its password/expiry, terminate sessions, revoke function EXECUTE/schema USAGE and `pg_read_all_settings` with the ordinary `REVOKE` (no `CASCADE`, no `SET ROLE rdsadmin`); verify all are absent. The membership grantor is informational and must not block this exact revocation. If PostgreSQL denies it, record the exact command and server error, stop, and do not use an elevated AWS-managed role or catalog edits. Remove the local operator password/profile credentials, then review/apply a newly generated `credential-rotation-campaign-close.tfplan` to delete the two IAM roles/policies/attachments, source-user assume entries, and bootstrap lifecycle policy. Set the helper flag back to `False`. Close the tunnel and verify the host is stopped. The fixed non-login function owner/function remain for future separately approved campaigns; approval must explicitly accept their residual `CREATEROLE` plus `ADMIN` authority on only `auth_runtime` and `core_runtime`. No DB master session may directly change a runtime password.

Approval for this complete procedure must expressly cover: (a) the exact four saved-plan phases and their expected actions, including final IAM deletes; (b) the one-time and activation/deactivation use of the exact RDS master secret through `GootipCredentialProvisioner`; (c) the residual function-owner privilege; (d) temporary `pg_read_all_settings` membership for `gootip_credential_operator`; (e) the one-hour operator login and per-service current VersionIds/maintenance window; and (f) enabling the helper's hard execution flag only for the approved campaign. No approval is implied by this proposal. The current hidden preload settings must be visible and pass the first-session check before any PostgreSQL writes; no parameter changes are part of the plan.

## Proposed offline tool and write protocol

`scripts/credential_rotation.py` remains offline validation. `scripts/credential_rotation_live.py` contains fixed AWS/secret/database bindings, STS role/account checks, Secrets Manager version reconciliation/publication, RDS endpoint discovery, verify-full PostgreSQL connection setup, session identity/TLS checks, parameter-bound function invocation, pinned-current-secret recovery, and a private sanitized ledger writer. All clients are injectable and tests use simulated clients with fictional values. `LIVE_EXECUTION_ENABLED` remains hard-coded false; the CLI refuses before constructing clients or prompting, so no live operation is currently executable. Enabling it requires separate approval after the logging gate and saved-plan review.

There is no terminal rehearsal UI. The operational CLI shapes are `python3 gootip-infra/scripts/credential_rotation_live.py auth rotate <EXPECTED_VERSION_ID>` and `... auth recover <EXPECTED_VERSION_ID>`; both currently return status 2 before any AWS/DB client initialization because live execution is blocked.

If later approved for live implementation, retain this order for one service at a time:

1. Confirm the separate PostgreSQL procedure, exact IAM grant, recovery operator/path, maintenance lock, 60-minute window, and request budget are reviewed. Confirm no load, migration, or Admin bootstrap is running.
2. Start/reuse the existing private tunnel without stopping a tunnel or host used by another session. Establish `verify-full` TLS to the discovered RDS hostname and verify the expected operator identities before any write.
3. Read `DescribeSecret` and the exact `AWSCURRENT` value. Capture its `VersionId`, verify the payload username, and prepare a serialized replacement in process memory that changes only `password`. Do not accept Terraform state or arbitrary ARNs as inputs.
4. Require an exclusive maintenance window: Secrets Manager `PutSecretValue` has no compare-and-swap condition on the expected `AWSCURRENT` version. The helper must recheck `AWSCURRENT` immediately before changing PostgreSQL and before publishing the replacement; if it changed, stop. This narrows but cannot eliminate an external-writer race. If stronger concurrency exclusion is required, review a separate shared-lock mechanism before implementation.
5. Obtain the new password from a private password manager using a no-echo prompt into process memory; never put it in arguments, environment variables, shell/SQL history, files, logs, or chat. The operator calls only the fixed function with bound parameters to change the selected runtime role, then immediately calls `PutSecretValue` on its exact secret ARN. Preserve unrelated fields. Use one client request token; do not blindly retry a timed-out or ambiguous write. Reconcile `DescribeSecret` and exact `VersionId`/staging labels first.
6. Verify a fresh `verify-full` TLS connection as the exact runtime identity, a successful service operation through the new application generation, and retired-pool cleanup (`app.close()` for Core) before moving to the next identity. Do not treat a warm connection as credential adoption.
7. For Auth signing-key changes, keep this separate and later in the sequence: increase `BETTER_AUTH_SECRET_VERSION`, carry forward all required `BETTER_AUTH_PREVIOUS_SECRETS`, and do not rely on `AWSPREVIOUS` as full key history.

## Recovery and interruption protocol

Secrets Manager and PostgreSQL do not share a transaction; temporary mismatch and connection failures are possible. Before a real change, record only the target, expected prior secret `VersionId`, sanitized state, and operator/window identifiers. The prior payload remains in Secrets Manager and is retrievable by its exact version ID under the narrowly scoped `GetSecretValue` grant; never copy its value into a recovery file.

- If PostgreSQL is unchanged and the secret write is not committed, stop; do not write either system.
- If the `PutSecretValue` outcome is uncertain, **do not choose restoration yet**. First call `DescribeSecret`, reconcile the exact `AWSCURRENT`/prior `VersionId` values and staging labels, then attempt a fresh `verify-full` connection using the current secret as the exact runtime identity. A successful identity check establishes a matching pair; proceed only to the service-health and retired-generation checks. A TLS/network failure is not evidence of a password mismatch and must not trigger a password write.
- Only after version reconciliation and the fresh connection result, decide recovery. If `AWSCURRENT` is the prior version and authentication fails, restore the database from that exact prior secret version. If `AWSCURRENT` is the new version and authentication fails, apply the credential from the current secret to the database. Verify a new TLS connection and expected runtime identity after either repair. If a different version, concurrent edit, or ambiguous database result is observed, stop for the authorized DBA; do not blindly replay either write.
- If the process is interrupted, a new invocation must begin in recovery-only mode using the same order: inspect metadata and exact version IDs, fetch only versions registered by the latest sanitized attempt (prior VersionId plus its recorded new VersionId/request token), then probe a fresh TLS connection as the expected runtime identity, and only then select the matching-pair recovery. If the prior VersionId authenticates, report `credencial anterior reconciliada; rotación no completada`; do not imply a new version or completed rotation. Keep a private, mode-0600 sanitized ledger with target, prior/new VersionIds, timestamps, safe failure stage and SQLSTATE only—never SQL messages, parameters, passwords, verifiers, or payload. The actual payload remains in Secrets Manager and is fetched by exact VersionId. Do not move `AWSCURRENT` backward; if restoring the old payload, publish a new version containing that complete prior payload so the database and `AWSCURRENT` agree.
- If the database connection cannot establish which credential is active, stop and require the separately authorized recovery operator. Never use the RDS master or another service identity as an implicit fallback.
- If a signing-secret transition later fails, publish a complete key set with a strictly higher version; code rollback or moving a staging label backward is insufficient.

If the human is interrupted after setting the DB password but before publishing the secret, the approved recovery operator resumes in recovery-only mode: read exact current/prior versions and labels; probe a fresh verified-TLS login using the current secret; classify only after both results are known; then use the still-active operator function to restore the DB to the current/published password or complete the pending publication as the approved decision requires. If the operator login expired, do not guess or use the master silently: the provisioner may reactivate it only with separate recovery approval and a new short cutoff. If the function/login is unavailable, the named incident approver must explicitly authorize the RDS-master emergency exception and exact action, or stop/escalate to the DBA. Never make direct runtime password edits under the installation exception.

No live AWS or RDS change, permission grant, credential write, or recovery exercise was performed for this proposal. Read-only AWS metadata queries were performed as recorded above. The database function was exercised only in the disposable local PostgreSQL test described below. Approval of this document alone must not be treated as execution authorization.

## Local verification and reused campaign evidence

- `scripts/tests/test_credential_rotation_postgres.sh` passed against a disposable local PostgreSQL 18 container. It verified the RDS-master-like creator can `SET ROLE` to the function owner for installation; the inert operator has no function/schema access, is `NOLOGIN`, and has no `CREATEROLE` or target-role membership; an activation grants only schema usage/function execution; disablement revokes those grants and expires the login; the function accepts only the two fixed runtime targets; and both test identities can make fresh local password-authenticated connections after function calls. This does not validate RDS behavior, TLS, production logging, or any AWS permission.
- The already completed `artifacts/validation/spec10.1-20261101T174133Z.json` remains reusable: normal use and the shared limiter are recorded passed; the 20 req/s burst remains deferred. Its Auth/Core artifact hashes still match the local artifacts, and the relevant application and Terraform inputs are unchanged. No campaign traffic was repeated.
- The separate `artifacts/validation/spec10.1-rotation-attempt-20261101T190327Z.json` records credential transitions as not executed/deferred. This local mechanism test does not change that status.

## References

- [SPEC 10.1](../specs/10.1-dev-api-operational-validation.md)
- [SPEC 05.1 operator identity](../specs/05.1-dev-database-operator-identity.md)
- [SPEC 09 refresh and recovery](../specs/09-authentication-credential-refresh.md)
- [Terraform secrets policy](../bootstrap/secrets.tf)
- [PostgreSQL 18 role attributes](https://www.postgresql.org/docs/18/role-attributes.html)
