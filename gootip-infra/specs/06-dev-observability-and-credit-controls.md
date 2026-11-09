# SPEC 06 — Economical Dev Observability and Credit Consumption Controls

> **Status:** Implemented
> **Depends on:** SPEC 02.2, SPEC 03, SPEC 04, SPEC 05
> **Date:** 2026-10-15
> **Objective:** Establish low-cost dev alerts and short-retention log ownership for current services while deferring runtime-only observability to SPEC 10.

## Why this spec exists

The private RDS instance and authentication migration Lambda already need basic
failure and capacity signals. The public authentication Lambda and HTTP API do
not exist yet, so alarms or live validation for them would provide no current
evidence.

This spec creates the stable log-group ARNs required by SPEC 07, adds alerts
only for deployed resources, and establishes a simple cost-notification path.
SPEC 10 attaches and validates the public runtime observability when those
resources are first deployed.

## Scope

**In:**

- Inventory the account plan, existing CloudWatch resources, applicable free
  allowances, and current log-group ownership before changing infrastructure.
- Terraform-managed log groups for authentication, administrative, migration,
  and future API access logs, each with seven-day retention.
- Safe import or adoption of an existing log group without deleting its
  current log events.
- A CloudWatch alarm for authentication migration Lambda errors while that
  function is deployed.
- CloudWatch alarms for RDS CPU utilization and database connections.
- One minimal SNS email destination for operational CloudWatch alarms, with a
  confirmed subscription and delivery test.
- One fixed monthly actual-cost budget with email notification when AWS
  Budgets is available to the account plan.
- Verification and documentation of AWS-provided Free Plan credit-balance and
  expiration alerts separately from the cost budget.
- Explicit variables for the destination, budget amount, and current-resource
  alarm thresholds.
- A short diagnostic and cost-notification runbook.
- Deferred log-group and metric contracts handed to SPECS 07 and 10.

**Out of scope:**

- Enabling PostgreSQL log export or changing PostgreSQL logging parameters.
  SPEC 10 may add error-oriented export when public application traffic exists
  or an earlier dedicated diagnostic need justifies it.
- Attaching HTTP API access logging or validating its fields before the API
  exists. SPEC 10 owns attachment and inspection with real requests.
- Live alarms for the authentication Lambda, HTTP API 5xx responses, or public
  runtime throttling. SPEC 10 owns their creation and validation.
- Throttling alarms for the administrative and migration Lambdas, which are
  invoked only through controlled procedures.
- Forecast-based budget alerts before the account has enough usage history.
- Detailed cost forecasts for low-volume logs, alarms, or SNS traffic.
- VPC Flow Logs, X-Ray, enhanced monitoring, Performance Insights, advanced
  database observability, high-resolution metrics, or dashboards.
- Logging tokens, cookies, request bodies, SQL text or parameters, secret
  values, or raw application errors that may contain sensitive data.
- Budget actions, automatic resource shutdown, a credit-polling Lambda, or a
  Paid Plan upgrade.
- A claim that CloudWatch or AWS Budgets provides a real-time spending cap.

## Data model and contracts

### Log groups

| Terraform resource                         | Physical log group                                      | Current use                                        |
| ------------------------------------------ | ------------------------------------------------------- | -------------------------------------------------- |
| `aws_cloudwatch_log_group.gootip_auth`     | `/aws/lambda/gootip-auth-${var.env}`                    | Reserved for the SPEC 10 authentication deployment |
| `aws_cloudwatch_log_group.db_config`       | `/aws/lambda/lambda_db_config`                          | Administrative function when explicitly enabled    |
| `aws_cloudwatch_log_group.auth_migrations` | `/aws/lambda/${var.project}-${var.env}-auth-migrations` | Existing private migration Lambda                  |
| `aws_cloudwatch_log_group.api_access`      | `/aws/apigateway/${var.project}-${var.env}-auth`        | Reserved for SPEC 10 API access logs               |

Every group has seven-day retention and the required `project`, `env`, and
`managed_by` tags. Creating a group before its function or API does not enable
that runtime or produce log ingestion. If a group already exists, adopt it
without deleting current log events.

SPEC 07 consumes the Lambda log-group ARNs to scope execution-role log writes.
SPEC 10 consumes the API group and attaches a structured JSON format containing
only request ID, time, method, route, status, response size, and reviewed
integration identifiers. Raw error messages and request content remain
excluded.

### Current alarms and notification path

| Target                          | Metric                | Contract                                                                                      |
| ------------------------------- | --------------------- | --------------------------------------------------------------------------------------------- |
| Authentication migration Lambda | `Errors`              | Enabled only while the function is deployed; notify on a configurable nonzero error threshold |
| RDS                             | `CPUUtilization`      | Configurable standard-resolution threshold and evaluation period                              |
| RDS                             | `DatabaseConnections` | Initial threshold derived from inspected connection capacity and refined by SPEC 08           |

All current alarms publish to one Terraform-managed SNS topic. The operator
supplies `alarm_notification_email` and confirms the resulting email
subscription. The implementation must prove message delivery without causing
a prolonged outage, artificial load spike, or database failure.

Authentication Lambda errors and throttles plus HTTP API 5xx alarms are SPEC 10
resources. This spec records their required dimensions and notification topic
handoff but does not create alarms against absent resources.

### Consumption notifications

The operator supplies `monthly_cost_budget_usd` and an actual-cost notification
threshold. If AWS Budgets is available to the current account plan, Terraform
creates one notification-only fixed monthly cost budget. Credits must not be
mistaken for zero underlying service consumption.

Dev uses a USD 10 monthly actual-cost budget and one email notification above
80% (USD 8). Credits and refunds are excluded from the cost calculation. No
forecast notification, budget action, or automated shutdown is configured.

The budget is not a remaining-credit monitor and can report delayed billing
data. AWS-provided Free Plan credit-balance and expiration notifications remain
the source of truth for those values. If the account plan does not allow the
budget, record that result and retain the native alerts instead of adding a
paid workaround or blocking the rest of this spec.

For dev, `monthly_cost_budget_usd = 10` and
`monthly_cost_budget_actual_threshold_percent = 80`. The budget excludes
credits and refunds from its actual-cost calculation. The AWS Budgets API uses
the `us-east-1` control-plane endpoint; application resources remain in
`us-east-2`.

Expected files: `observability.tf`, `lambda.tf`, `providers.tf`, `variables.tf`,
`outputs.tf`, `environments/dev.tfvars` for non-sensitive values, and `README.md`.
The existing bootstrap deployment capability may be extended only for exact
SPEC 06 resources, with a matching bootstrap test and IAM guardrail. No
application runtime, API, PostgreSQL parameter, or secret-value resource is
introduced.

## Implementation plan

1. Inspect the current account plan, active log groups, CloudWatch alarms,
   standard metric usage, and applicable free allowances. Collect the operator
   email, monthly budget amount, actual-cost notification threshold, and
   current-resource alarm thresholds. Record unavailable features instead of
   substituting paid services.
2. Create or safely adopt the four Terraform-managed log groups with seven-day
   retention and required tags. Preserve the existing migration log group and
   any existing events. Wire Lambda dependencies so a future or enabled
   function never races automatic log-group creation.
3. Create the single SNS topic and email subscription. Add only the migration
   Lambda error alarm and the RDS CPU and connection alarms. Confirm email
   subscription and delivery through a scoped notification test without
   inducing an application or database incident.
4. Create the fixed monthly actual-cost budget when the account plan supports
   it. Verify and document the native Free Plan credit-balance and expiration
   notifications separately. Do not add forecast alerts until sufficient
   usage history exists.
5. Complete the short runbook and handoffs. Give Lambda log-group ARNs to
   SPEC 07, the initial RDS connection threshold to SPEC 08, and the SNS topic,
   API log group, access-log field allowlist, and deferred runtime alarms to
   SPEC 10. Run the focused and full required repository verification once.

## Acceptance criteria

- [x] The account plan, applicable allowances, existing log groups, and
      currently supported budget features are recorded without exposing account
      credentials or secret values.
- [x] Authentication, administrative, migration, and API access log groups are
      Terraform-managed with seven-day retention and required tags.
- [x] Existing groups and log events are preserved during Terraform adoption.
- [x] Creating the deferred log groups does not enable the authentication
      Lambda, administrative Lambda, or HTTP API.
- [x] The deployed migration Lambda has an `Errors` alarm with the correct
      function dimension and configurable threshold.
- [x] RDS has `CPUUtilization` and `DatabaseConnections` alarms with the exact
      database identifier and configurable standard-resolution thresholds.
- [x] No throttling alarm exists for the administrative or migration Lambda.
- [x] All current alarms publish to one SNS topic, its email subscription is
      confirmed, and a scoped delivery test succeeds.
- [x] A fixed monthly actual-cost budget and email notification exist when the
      account plan supports AWS Budgets; otherwise the unsupported result is
      documented without a paid substitute.
- [x] Native Free Plan credit-balance and expiration alerts are verified and
      documented separately from the cost budget.
- [x] No forecast alert is claimed before sufficient usage history exists.
- [x] No PostgreSQL log export, logging-parameter change, public-runtime alarm,
      sensitive log field, advanced observability service, or budget action is
      introduced.
- [x] The runbook identifies the SPECS 07, 08, and 10 handoffs and states that
      cost and credit notifications can be delayed.
- [x] Required Terraform formatting, validation, focused tests, and the final
      repository verification pass with a reviewed non-destructive plan.

## Decisions

- **Yes:** seven-day retention and Terraform ownership for stable log-group
  ARNs. This provides cost hygiene and enables SPEC 07 least-privilege log
  policies.
- **Yes:** alert only on deployed migration failures and existing RDS capacity.
  These signals can produce actionable evidence now.
- **Yes:** one SNS topic for operational alarms and one simple actual-cost
  budget when eligible; dev uses USD 10/month with an actual-cost notification
  above 80%, excluding credits and refunds.
- **Yes:** keep the dev operational-alert SNS topic without additional
  customer-managed KMS encryption. These alerts contain no secrets or personal
  data, and the accepted risk is limited to this dev topic. Defer KMS until the
  alert data scope changes; this decision does not apply to other resources.
- **Yes:** use native AWS credit-balance and expiration notifications for Free
  Plan lifecycle information.
- **No:** PostgreSQL log export before public traffic or a concrete diagnostic
  need. It adds ingestion and operational work without current evidence value.
- **No:** alarms against absent public resources. SPEC 10 creates and validates
  them with real traffic.
- **No:** throttling alarms for controlled administrative and migration
  invocations.
- **No:** forecast alerts without enough history or detailed speculative cost
  estimates.
- **No:** advanced observability products, automated shutdown, or a promise of
  zero cost.

## AWS Free Plan and cost constraints

Free allowances are account-wide and depend on the account plan and current
usage. Inspect them once before apply and record the result. Do not hard-code
training-data limits into Terraform or the runbook.

The 2026-10-20 `GetAccountPlanState` read reported `FREE`/`ACTIVE`, USD 136.69
in remaining credits, and expiration on 2027-04-08 at 15:54 UTC (170 days
remaining). `GetFreeTierUsage` returned no current usage entries. AWS documents
that Free account plans use Always Free offers and receive periodic native
Free Plan credit-balance and expiration notices. The operator confirmed the
New Experience Billing UI exposes Cost Explorer, Free Tier, and Budgets but no
Billing preferences page or configurable `Receive AWS Free Tier usage alerts`
toggle. These native plan notices remain separate from the monthly cost budget.
The `billing:GetBillingPreferences` API is denied by an Organizations SCP; no
SCP change or IAM workaround was made because the preference is not available in
this experience.

Retention limits stored history but does not limit ingestion volume. Deferred
groups ingest nothing until attached resources write to them. Standard metrics
and low-volume notifications are preferred; high-resolution metrics, custom
metric filters, and budget actions are excluded.

AWS billing, budget, credit, and expiration information can be delayed. These
notifications do not extend the Free Plan, guarantee uninterrupted service, or
authorize a Paid Plan upgrade.

## Risks

| Risk                                                             | Mitigation                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Existing log group conflicts with Terraform creation             | Inspect first and import/adopt it without deletion.                                              |
| Wrong metric dimensions create silent alarms                     | Use exact function and database identifiers and inspect standard metric data.                    |
| SNS subscription remains unconfirmed                             | Require confirmed subscription and one scoped delivery test.                                     |
| Dev operational alerts lack customer-managed KMS encryption     | Accept for this topic because its alerts contain no secrets or personal data; revisit if scope changes. |
| Credits hide underlying service consumption                     | Keep the actual-cost basis explicit and document credits separately.                             |
| Budget feature is unavailable on the account plan                | Record the limitation and rely on native credit and expiration alerts without a paid workaround. |
| Deferred public controls are mistaken for implemented protection | Name SPEC 10 as the owner and do not create or accept those alarms here.                         |

## What is **not** in this spec

- PostgreSQL log export or logging-parameter changes.
- Live API access logging, authentication Lambda alarms, HTTP API 5xx alarms,
  or public-runtime throttling alarms.
- Administrative or migration throttling alarms.
- Forecast budgets without sufficient history or detailed speculative cost
  forecasts.
- Flow Logs, X-Ray, enhanced monitoring, Performance Insights, dashboards,
  high-resolution metrics, or custom metric filters.
- Sensitive logging, automatic resource shutdown, budget actions, a
  credit-polling service, or Paid Plan conversion.

Each deferred public-runtime control belongs to SPEC 10.
