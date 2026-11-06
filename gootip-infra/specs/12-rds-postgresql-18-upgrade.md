# SPEC 12 — RDS PostgreSQL 18 Upgrade and Automatic Minor Maintenance

> **Status:** Implemented
> **Depends on:** SPEC 02.2, SPEC 03, SPEC 04, SPEC 05.2, SPEC 06
> **Date:** 2026-10-21
> **Objective:** Upgrade the existing private `gootip-dev` RDS instance from PostgreSQL 17.6 to the latest approved PostgreSQL 18 release and keep future PostgreSQL 18 minor releases current automatically.

## Why this spec exists

AWS will end standard support for RDS PostgreSQL 17.6 on October 31, 2026.
After that date, AWS can apply a mandatory minor upgrade during maintenance and
cause downtime at a time the project did not deliberately choose.

PostgreSQL 18 is already the local integration-test baseline for `gootip-auth`.
RDS PostgreSQL 18 remains under standard major-version support through February
28, 2031. Moving to PostgreSQL 18 now removes the immediate deprecation and
avoids keeping the application and cloud database on different major versions.

PostgreSQL minor versions have shorter support periods than their major version.
For this dev instance, the user chose to retain the exact deployed version pin
`18.6`; any later minor-version change requires a reviewed Terraform update.
AWS-approved automatic minor upgrades remain enabled, with a predictable weekly
maintenance window. Major upgrades remain manual and reviewed.

## Scope

**In:**

- Upgrade the existing `gootip-dev` standalone RDS PostgreSQL DB instance in
  place from `17.6` to the current approved PostgreSQL 18 target.
- Resolve the exact target through live RDS metadata before planning. The
  expected target on this spec date is `18.6` in `us-east-2`.
- Keep the durable Terraform engine contract pinned to the approved deployed
  version `18.6`; review and update the pin before adopting another minor.
- Enable automatic AWS-approved PostgreSQL 18 minor upgrades.
- Set the preferred maintenance window to Sunday `03:00-04:00` UTC, equivalent
  to Sunday `00:00-01:00` in Argentina.
- Replace the PostgreSQL 17 parameter group with a PostgreSQL 18 parameter
  group that preserves `rds.force_ssl = 1`.
- Add only the scoped bootstrap IAM capabilities needed to inspect, snapshot,
  modify, and verify this exact database and its two known parameter groups.
- Run PostgreSQL-specific live prechecks through the existing SPEC 05.2 private
  workstation tunnel and `gootip_dev_operator` identity.
- Create and verify a manual pre-upgrade snapshot in addition to RDS's automatic
  pre-upgrade snapshot from the existing nonzero backup retention.
- Apply only reviewed saved Terraform plans and collect sanitized upgrade
  evidence.
- Verify database connectivity, authorization, migration history, and relevant
  CloudWatch metrics after the upgrade.
- Keep `cloudwatch:GetMetricData` permanently available to the deployment role
  in `us-east-2`, as explicitly approved on October 28 for observation.

**Out of scope (for future specs):**

- A second restored test instance or a snapshot-restore rehearsal before the
  real upgrade.
- Blue/Green deployment, RDS Proxy, Multi-AZ, or a second permanent database.
- PostgreSQL 19 or any later major-version upgrade.
- Schema changes, new migrations, role or grant changes, or application code
  changes.
- Public database access, NAT, new VPC endpoints, or changes to the existing
  private tunnel topology.
- Reading, copying, rotating, or changing database secret values.
- Changing the current RDS Extended Support enrollment setting.
- Production or staging environments.
- Blanket `ANALYZE` or `REINDEX` operations without a concrete post-upgrade
  finding.

## Infrastructure and lifecycle contract

This feature introduces no application data structures and no schema changes.
It changes the following infrastructure contract:

| Item                       | Before                                       | Durable result                                 |
| -------------------------- | -------------------------------------------- | ---------------------------------------------- |
| DB instance                | `gootip-dev`                                 | Same instance identity                         |
| Engine                     | PostgreSQL `17.6`                            | Exact PostgreSQL version `18.6`                 |
| Expected first target      | `17.6`                                       | `18.6`, verified live before apply             |
| Parameter group            | `gootip-dev-postgres`, family `postgres17`   | `gootip-dev-postgres18`, family `postgres18`   |
| TLS enforcement            | `rds.force_ssl = 1`                          | Unchanged                                      |
| Minor updates              | Provider/AWS default not stated in Terraform | `auto_minor_version_upgrade = true`            |
| Major update authorization | Disabled by provider default                 | Explicitly enabled for reviewed engine changes |
| Apply timing               | Provider default                             | `apply_immediately = false`                    |
| Maintenance window         | AWS-assigned                                 | `sun:03:00-sun:04:00` UTC                      |
| Backup retention           | One day                                      | Unchanged and nonzero                          |
| Availability               | Single-AZ                                    | Unchanged                                      |
| Master credential          | RDS-managed Secrets Manager secret           | Unchanged                                      |

`rds_engine_version` remains an exact version and is set to `"18.6"`. The
`aws_rds_engine_version` data source resolves that exact version with
`parameter_group_family = "postgres18"`. A future AWS minor update may create
drift against this pin and requires a reviewed configuration change; do not
silently adopt or downgrade from a changed live version.

`allow_major_version_upgrade = true` does not permit an automatic PostgreSQL 19
upgrade. A future major upgrade still requires changing the tracked major prefix
and reviewing an in-place RDS modification in a saved plan.

The PostgreSQL 18 parameter group uses the physical name
`gootip-dev-postgres18`. Terraform must create it before the obsolete
`gootip-dev-postgres` parameter group is destroyed. The old parameter-group
deletion is the only planned replacement/delete operation in this specification.
Deletion or replacement of `aws_db_instance.main` is forbidden.

## Evidence and stop conditions

Complete engine inventories, plan files, plan JSON, state snapshots, account
identifiers, resource ARNs, SQL precheck output, snapshot metadata, and live
metrics remain ignored local evidence. Tracked files may contain only portable
contracts and sanitized summaries.

Stop before any database mutation when any of the following is true:

- `gootip-dev` is missing, is not standalone RDS PostgreSQL, is not `available`,
  or is not running the expected source version.
- The instance is a replica, has a cross-Region replica, or has an unexpected
  in-Region replica topology.
- PostgreSQL `18.6` is no longer available or is not a valid major target from
  the live source version.
- The `db.t3.micro` class or `postgres18` family is not valid for the target in
  `us-east-2`.
- A pending maintenance action, state lock, unknown drift, or unsupported
  extension makes the result uncertain.
- A live precheck reports an active logical replication slot, prepared
  transaction, unknown type, or another critical upgrade blocker.
- The manual snapshot is not `available`.
- Either saved plan contains an unexpected resource, delete, replacement,
  wildcard administration, PassRole change, public-network change, secret-value
  access, or broader resource scope.
- The application plan proposes replacing or deleting `aws_db_instance.main`,
  disabling backups or deletion protection, or reducing encryption or TLS.
- The planned October 25, 2026 maintenance window is missed. A later execution
  needs a new dated snapshot identifier, fresh plans, and explicit schedule
  approval before continuing.

## Implementation plan

1. Add focused application-root Terraform tests for the PostgreSQL 18 lifecycle
   contract. Assert the exact `18.6` pin, resolved `postgres18` family, automatic
   minor upgrades, non-immediate application, maintenance window, TLS parameter,
   protected backups, and unchanged private Single-AZ instance identity.
2. Add focused bootstrap policy tests for the exact RDS upgrade capability.
   Permit `rds:ModifyDBInstance` only on `gootip-dev`; permit snapshot creation
   only for `gootip-dev` and the exact dated pre-upgrade snapshot; permit target
   parameter-group configuration and obsolete parameter-group deletion only on
   their exact ARNs. Keep read-only discovery actions Region-bound where the
   RDS API does not support resource-level scoping. Do not add PassRole, restore,
   replica, secret-value, or general RDS administration capabilities.
3. Update the application Terraform contract in `rds.tf`, `variables.tf`, and
   `environments/dev.tfvars`. Keep the exact engine version at `18.6`, resolve
   that version in the data source for plan-time engine metadata, change the
   family to `postgres18`, create
   `gootip-dev-postgres18` before destroying the old parameter group, enable
   automatic minor upgrades, allow the reviewed major change, preserve
   `apply_immediately = false`, and set `sun:03:00-sun:04:00` UTC.
4. Update the bootstrap database policy and its tests for the exact database,
   snapshot, old parameter group, and new parameter group resources. Preserve
   all existing account, Region, tag, role, secret, and state boundaries.
5. Add a non-secret PostgreSQL precheck SQL file under `scripts/` covering
   installed and critical extension versions, hash indexes, unknown types,
   logical replication slots, prepared transactions, objects owned by RDS
   system roles, database encoding and locale, custom types, table/index bloat,
   `reg*` columns, and stale statistics. Document execution through
   `scripts/db_access.sh tunnel` with certificate and hostname verification.
6. Update the infrastructure README with the major/minor lifecycle contract,
   the Sunday maintenance window, the no-downgrade rollback model, and the next
   required major-version review before February 28, 2031.
7. Run the focused offline checks. Use `scripts/verify_fast.sh` after the related
   edits, the focused Terraform tests for both roots, IAM guardrails, the
   existing `gootip-auth` PostgreSQL 18 integration tests, TFLint, and Trivy.
   Run `scripts/verify_full.sh` once before the live deployment handoff.
8. Obtain fresh MFA-backed bootstrap, deployment, and database-operator
   sessions. Use `describe-db-instances`, not cluster APIs, to record engine,
   actual version, status, class, parameter group, Multi-AZ state, encryption,
   backup retention, deletion protection, maintenance window, pending changes,
   replica source, and replica identifiers.
9. Query `describe-db-engine-versions` for the source version and verify that
   `18.6` is still the latest stable valid major target. Confirm the target
   family and orderable `db.t3.micro` combination. Review the PostgreSQL 18
   release notes and current RDS release calendar before authorization.
10. Start the existing private tunnel and run the PostgreSQL precheck file as
    `gootip_dev_operator` with verified TLS. Classify every result as critical,
    warning, or clean. Stop on critical findings. Record any warning that needs
    a targeted post-upgrade `REINDEX` or `ANALYZE`; do not run either operation
    preemptively across all tables.
11. Produce a normal bootstrap-root plan for the exact IAM capability change.
    Review its policy JSON and simulator/Access Analyzer evidence. Apply only
    the saved bootstrap plan by filename, then mint a new deployment session
    and prove the intended RDS actions are allowed while restore, replica,
    delete-instance, PassRole, and secret-value actions remain denied.
12. Create the manual snapshot named
    `gootip-dev-pre-pg18-20261025`, wait for status `available`, and verify its
    source identifier and engine version without restoring it. Automated backup
    retention remains one day, so RDS will also take its standard pre-upgrade
    snapshot during the major upgrade.
13. Generate refresh-free and normal application plans with the same reviewed
    inputs. The normal saved plan may create `gootip-dev-postgres18`, modify
    `gootip-dev` in place, and delete `gootip-dev-postgres` only after the new
    association is safe. Reject any RDS instance replacement or unrelated
    infrastructure change.
14. Apply the reviewed application plan by filename before the October 25,
    2026 maintenance window. Do not replace it with a newly generated
    `terraform apply`. Confirm that the change is scheduled for the intended
    window and keep application/database administrative activity quiescent
    while RDS performs its automatic major-upgrade validation, snapshot, engine
    upgrade, and reboot.
15. Wait until `gootip-dev` returns to `available`. Verify actual engine version
    `18.6`, parameter group `gootip-dev-postgres18` with status `in-sync`, no
    pending reboot, preserved endpoint and resource identity, enabled automatic
    minor upgrades, Sunday maintenance window, backup retention, encryption,
    deletion protection, private networking, and RDS-managed master secret.
16. Reopen the private tunnel and verify `SELECT version()`, expected databases,
    encoding/locale, installed extensions, role memberships, schema ownership,
    grants, migration history, and representative `auth` DML inside an explicit
    rolled-back transaction. Run the existing database configuration and
    migration validation paths without introducing new SQL.
17. Monitor `CPUUtilization`, `DatabaseConnections`, `ReadIOPS`, `WriteIOPS`,
    `FreeableMemory`, and `FreeStorageSpace`, plus relevant Lambda and migration
    errors, for 24-48 hours. Run targeted `ANALYZE` or `REINDEX` only when a
    recorded warning or observed regression justifies it during a low-traffic
    period.
18. Run final refresh-free and normal plans for both roots. Confirm no downgrade
    to `17.6`, no version drift, no obsolete parameter group, and no
    unexplained state change. Retain the manual snapshot until the user confirms
    the upgrade is successful with no regression; snapshot deletion is a
    separate reviewed cleanup action.

## Acceptance criteria

- [x] Live RDS metadata identifies `gootip-dev` as standalone PostgreSQL in
      `us-east-2` and records both replica fields before planning.
- [x] PostgreSQL `18.6` is confirmed as an available and valid major upgrade
      target from the live source version.
- [x] `db.t3.micro` and parameter-group family `postgres18` are valid for the
      target in `us-east-2`.
- [x] The live PostgreSQL prechecks contain no unresolved critical finding.
- [x] The manual snapshot `gootip-dev-pre-pg18-20261025` is `available` before
      the application plan is applied.
- [x] The bootstrap policy adds only the exact reviewed RDS modification,
      snapshot, parameter-group, and required read-only discovery permissions.
- [x] The bootstrap policy adds no wildcard administration, PassRole, restore,
      replica, delete-instance, or secret-value permission.
- [x] The application saved plan contains no replacement or deletion of
      `aws_db_instance.main`.
- [x] No parameter group is replaced or deleted: `gootip-dev-postgres18` is
      created alongside the retained `gootip-dev-postgres`, and the PostgreSQL
      17 group is deferred to a separate cleanup plan after observation.
- [x] Every live apply uses the correct account, `us-east-2`, canonical backend,
      fresh role session, and exact reviewed saved plan filename.
- [x] `gootip-dev` returns to `available` on PostgreSQL `18.6` with its original
      identifier, endpoint contract, encryption, deletion protection, backup
      retention, private networking, and RDS-managed master credential intact.
- [x] `gootip-dev-postgres18` is `in-sync` and enforces `rds.force_ssl = 1`.
- [x] Terraform tracks the exact approved engine version `18.6`; any future
      minor-version change requires an explicit reviewed pin update.
- [x] `auto_minor_version_upgrade` is enabled and the maintenance window is
      Sunday `03:00-04:00` UTC.
- [x] TLS verification, roles, ownership, grants, migration history, and
      representative rolled-back DML pass after the upgrade.
- [x] Focused checks, `scripts/verify_full.sh`, IAM guardrails, TFLint, Trivy,
      and the PostgreSQL 18 application integration tests pass.
- [x] The first 24-48 hours show no unexplained regression in the selected
      CloudWatch metrics or database-related Lambda errors.
- [x] Final refresh-free and normal plans for both roots contain no unexplained
      change.
- [x] The pre-upgrade snapshot remains retained until explicit post-observation
      cleanup approval.
- [x] The user-approved permanent metric-read capability allows only
      `cloudwatch:GetMetricData` in `us-east-2`; no new mutation, PassRole,
      secret-value, or cross-Region capability is introduced.

## Closure — October 28, 2026

All acceptance criteria are complete. This closure supersedes the pending
items recorded in the earlier checkpoints below.

- The approved permanent metric-read statement was added to the existing
  deployment foundation-read policy. Standard metric queries use `Resource:
  "*"` with an exact `aws:RequestedRegion = us-east-2` condition. A normal saved
  bootstrap plan contained only that in-place policy update and was applied
  by filename. No other IAM statement, role attachment, or resource changed.
- The focused Terraform test and full offline verification passed, including
  122 pure tests, 26 subtests, the materialization test, policy-size guardrails,
  and exact policy-union comparison. Access Analyzer returned no findings.
  IAM simulation allowed metric reads in `us-east-2`, denied them in
  `us-east-1`, and confirmed that the changed policy does not grant metric
  writes, alarm deletion, PassRole, or secret-value reads. TFLint passed.
  Trivy found only the existing AES256 state-bucket encryption observation
  (`AWS-0132`); the scan passed with that documented baseline exception.
- CloudWatch returned all 576 five-minute samples per RDS series for October
  25 03:00 UTC through October 27 03:00 UTC, with a preceding 24-hour baseline
  and additional observations through October 28. Results show no unexplained
  sustained regression:

  | Metric | First 48-hour evidence |
  | ------ | ---------------------- |
  | CPU utilization | Mean 4.28%, maximum 38.30%, below the 80% alarm threshold |
  | Database connections | Maximum 3, below the 56-connection alarm threshold |
  | Read IOPS | Maximum 119.76 at the maintenance-window start; subsequent mean returns near baseline |
  | Write IOPS | Maximum 126.85 at the maintenance-window start; subsequent mean returns near baseline |
  | Freeable memory | Minimum 114.5 MiB; mean lower than baseline, then partially recovers without sustained depletion |
  | Free storage | Minimum above 17 GiB; stable after the maintenance-window change |

- The RDS CPU and I/O peaks occurred at October 25 00:00 Argentina time,
  matching the approved maintenance window, and subsided afterward. The
  environment was mostly idle: there were no migration-runner or database
  configuration Lambda invocations in the first 48-hour interval. The later
  migration validation invocation succeeded with zero Lambda errors. This is
  development stability evidence, not a load or throughput benchmark. The
  existing SQL postchecks and migration validation establish functional
  connectivity and authorization independently of idle metrics.
- Reviewed refresh-only saved plans synchronized the completed PostgreSQL 18
  upgrade and operational tunnel state without changing infrastructure. With
  no local listener on port 15432, the existing tunnel helper restored the
  tunnel host to its declared stopped state.
- All four final saved plans returned exit code `0` and `No changes`: normal
  and refresh-free plans for both application and bootstrap roots. The exact
  approved pin remains `18.6`. Evidence is retained locally under ignored
  `audit/pg18-close-*-20261028.*` files, alongside the metric, validation,
  simulation, and saved-apply evidence.
- The manual snapshot and PostgreSQL 17 parameter group remain retained.
  No snapshot, database, secret, parameter group, or networking cleanup was
  performed. No blanket `ANALYZE` or `REINDEX` was needed or executed.

## Post-upgrade checkpoint — October 28, 2026

- Live RDS metadata still reports PostgreSQL `18.6`, status `available`,
  `gootip-dev-postgres18` `in-sync`, and no pending modifications. Private
  access, encryption, deletion protection, one-day backup retention, and
  automatic minor upgrades remain enabled. The configured version pin is
  unchanged at `18.6`.
- The encrypted pre-upgrade snapshot remains `available`, with source
  `gootip-dev` and PostgreSQL `17.6`. Neither it nor either parameter group
  was deleted.
- The deployed migration runner's code hash matches the existing local ZIP.
  Its `deployment` alias, version `3`, passed `validate`: no Lambda
  `FunctionError`, status `succeeded`, matching manifest and commit identities,
  applied migrations `000001` and `000002`, no pending migrations, and no
  error code. No migration apply or administrative reconciliation was invoked.
- Both bootstrap final plans, normal and refresh-free, report no changes.
  Saved plans and logs remain in ignored `audit/pg18-final-bootstrap-*-20261028`
  evidence files.
- The application refresh-free plan still records the old PostgreSQL 17
  parameter-group association in persisted state. The normal plan confirms
  the live PostgreSQL 18 association and proposes only stopping the running
  tunnel host. Neither application plan was applied: the tunnel may be in use.
  Final application state reconciliation and clean plans remain pending.
- The RDS CPU, RDS connections, and migration-error alarms currently report
  `OK`. A filtered migration-log query for October 26 03:00 UTC through
  October 28 03:00 UTC returned no matching error events. Alarm state and an
  empty error query do not establish the full observation criterion, especially
  because the migration alarm treats missing data as nonbreaching.
- Historical metric retrieval remains blocked: the deployment role denies
  `cloudwatch:GetMetricStatistics`; `cloudwatch:GetMetricData` was already
  denied at the previous checkpoint. The six-metric observation criterion
  remains unchecked. No IAM permissions or infrastructure were changed.

## Post-upgrade checkpoint — October 26, 2026

- Live RDS metadata reports PostgreSQL `18.6`, status `available`, parameter
  group `gootip-dev-postgres18` `in-sync`, and no pending modifications.
  The instance remains private, encrypted, Single-AZ, `db.t3.micro`, protected
  against deletion, with one-day backup retention and an active RDS-managed
  master secret. There is no replica source and no in-Region replica.
- `rds.force_ssl = 1`, automatic minor upgrades, and the Sunday
  `03:00-04:00` UTC maintenance window are confirmed live.
- The pre-upgrade saved plan `audit/pg18-app-step2-18.6-2026-10-21.tfplan`
  records identifier `gootip-dev`, ARN
  `arn:aws:rds:us-east-2:123456789012:db:gootip-dev`, and endpoint
  `gootip-dev.example.us-east-2.rds.amazonaws.com:5432`. A live
  `describe-db-instances` comparison on October 26 confirms the same identifier,
  ARN, endpoint, and port, now available on PostgreSQL `18.6`.
- The encrypted manual snapshot `gootip-dev-pre-pg18-20261025` remains
  `available` and records source version `17.6`. No cleanup was performed.
- User decision on October 26: retain the exact deployed version pin `18.6`.
  This supersedes the earlier version-tracking approach. `18.6` is the sole
  approved engine-version value for this instance. The saved plan generated on
  October 26 reflects a superseded configuration and is not a final plan; do
  not apply it. Generate final plans only after confirming that both Terraform
  roots' effective configuration uses `18.6`. Automatic minor upgrade settings
  remain unchanged; a future AWS minor update requires reviewing the tracked
  pin.
  Existing local secret ARN references are required while the database
  configuration Lambda remains enabled; no secret values were read.
- The offline policy comparator now records the existing upgrade statement's
  exact database and PostgreSQL 18 parameter-group ARNs. This changes no live
  IAM policy and includes a regression test rejecting an additional database.
- Post-upgrade SQL checks completed through `scripts/db_access.sh tunnel` on
  October 26 with `sslmode=verify-full`, the RDS CA bundle, and
  `gootip_dev_operator`. PostgreSQL reports `18.6` and TLS 1.3; the `auth`
  schema and its seven application relations are owned by `auth_migrator`;
  `gootip_auth` inherits `auth_migrator`; effective CRUD privileges are present
  for the application and migration roles; migration IDs `000001` and `000002`
  are recorded as applied; a representative `auth."user"` UPDATE was
  authorized inside a transaction and rolled back. No critical catalog
  findings were returned. Review-only output includes RDS-owned `pg_toast`
  relations, system-catalog `reg*` columns, and indexes with zero scans since
  statistics reset; no broad maintenance was run. Sanitized command output is
  retained in ignored `audit/pg18-postchecks-*.txt` files.
- Lambda validation, both roots' final plans, and 24-48h observation remain
  pending. The deployment role
  denies `rds:DescribeEvents` and `cloudwatch:GetMetricData`; upgrade completion
  time and the observation interval have therefore not been established. No
  permissions were expanded.

## Decisions

- **Yes:** upgrade directly to PostgreSQL 18. It matches the existing local
  integration baseline and extends RDS standard major-version support through
  February 28, 2031.
- **Yes:** expect PostgreSQL 18.6 for this execution. Live RDS metadata remains
  authoritative and a changed latest target stops the plan for review.
- **Yes:** use an in-place scheduled upgrade. This is the smallest suitable
  path for the private Single-AZ development instance.
- **Yes:** accept planned database downtime in the Sunday maintenance window.
- **Yes:** retain the exact deployed version pin `18.6` and enable automatic
  minor upgrades. Review any later AWS minor update before changing the pin.
- **Yes:** set Sunday `00:00-01:00` Argentina time as the permanent predictable
  maintenance window for occasional minor upgrades.
- **Yes:** reuse the SPEC 05.2 private tunnel and restricted operator identity
  for live SQL prechecks and postchecks.
- **Yes:** take a manual snapshot even though automated backups are enabled.
  The manual snapshot is the explicit rollback anchor.
- **No:** create a restored rehearsal instance. The user accepted the higher
  first-run risk to avoid temporary instance cost and cleanup.
- **No:** use Blue/Green. The development workload accepts downtime, and the
  existing RDS-managed master-password contract must remain unchanged.
- **Yes:** pin the durable Terraform configuration to `18.6` for this dev
  instance; a future minor adoption is an explicit reviewed change.
- **No:** run broad post-upgrade maintenance SQL. Only measured regressions or
  explicit precheck warnings justify targeted `ANALYZE` or `REINDEX`.
- **No:** change Extended Support enrollment in this upgrade. PostgreSQL 19 or
  the pre-2031 lifecycle decision belongs to a future reviewed spec.

## Risks

| Risk                                                                   | Mitigation                                                                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| The major upgrade causes full Single-AZ downtime                       | Use the explicit Sunday window, quiesce administrative activity, and verify reconnection before declaring success        |
| PostgreSQL 18 changes planner behavior                                 | Record precheck warnings and monitor metrics; use targeted low-traffic `ANALYZE` only after an observed regression       |
| An incompatible extension or live database object blocks `pg_upgrade`  | Run the complete PostgreSQL precheck set and let RDS's automatic major-upgrade validation abort before mutation          |
| Terraform replaces the database instead of updating it                 | Assert and manually inspect the saved plan; any instance delete or replacement is a hard stop                            |
| Parameter-group family replacement is ordered unsafely                 | Give the PostgreSQL 18 group a distinct physical name and create it before destroying the PostgreSQL 17 group            |
| Automatic minor upgrades create Terraform version drift                 | Keep the reviewed exact version pin and explicitly update it after reviewing a live AWS minor upgrade                   |
| The upgrade succeeds but application authorization regresses           | Re-run TLS, role, grant, migration-history, and rolled-back DML checks through the existing private path                 |
| Rollback requires a new endpoint because RDS cannot downgrade in place | Preserve the manual snapshot and treat restore/cutover as a separately reviewed emergency operation                      |
| The October 25 window is missed                                        | Stop, select a new window and snapshot identifier, and regenerate both reviewed plans                                    |
| IAM capability remains broader than required after the upgrade         | Scope mutation permissions to exact database, parameter-group, and snapshot resources and preserve negative policy tests |

## References

- [RDS PostgreSQL release calendar](https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-release-calendar.html).
- [RDS PostgreSQL major-version upgrades](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_UpgradeDBInstance.PostgreSQL.MajorVersion.html).
- [RDS PostgreSQL automatic minor upgrades](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_UpgradeDBInstance.PostgreSQL.Minor.html).
- [PostgreSQL 18 release notes](https://www.postgresql.org/docs/18/release-18.html).
- [Terraform `aws_db_instance`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/db_instance).
- [Terraform `aws_rds_engine_version`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/rds_engine_version).

## What is **not** in this spec

- A second RDS instance, pre-upgrade restore rehearsal, Blue/Green, RDS Proxy,
  Multi-AZ, staging, production, or a Paid plan upgrade.
- Application features, schema migrations, PostgreSQL role changes, or secret
  value handling.
- Public networking, NAT, new VPC endpoints, or a different database-access
  mechanism.
- PostgreSQL 19, automatic major upgrades, or an RDS Extended Support policy
  change.
- Snapshot deletion before explicit confirmation that the upgrade is successful
  and stable.
