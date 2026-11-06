# Live-AWS gate: plan-only, creates nothing. Run with a reviewed MFA-backed
# deployment session, for example:
#   TF_VAR_aws_account_id=<ACCOUNT_ID> terraform test \
#     -filter=tests/db_config_secrets_known.tftest.hcl
#
# This file intentionally does not mock the AWS provider: it proves that the
# administrative secrets policy renders a fully known JSON document when
# db_master_secret_arn is supplied explicitly, while the RDS instance is still
# being created or updated.

variable "aws_account_id" {
  type = string
}

run "db_config_secrets_policy_is_known_with_explicit_master_secret" {
  command = plan

  variables {
    aws_account_id                               = var.aws_account_id
    rds_final_snapshot_identifier                = "gootip-dev-final"
    alarm_notification_email                     = "operator@example.com"
    rds_max_connections                          = 81
    monthly_cost_budget_usd                      = 10
    monthly_cost_budget_actual_threshold_percent = 80
    db_config_deployment_enabled                 = true
    db_master_secret_arn                         = "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:rds!db-12345678-1234-1234-1234-123456789012-AbCdE4"
    auth_runtime_secret_arn                      = "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:gootip-dev-auth-runtime-AbCdE1"
    auth_migrator_secret_arn                     = "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:gootip-dev-auth-migrator-AbCdE2"
    core_runtime_secret_arn                      = "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:gootip-dev-core-runtime-AbCdE5"
    core_migrator_secret_arn                     = "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:gootip-dev-core-migrator-AbCdE6"
    db_operator_secret_arn                       = "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:gootip-dev-db-operator-AbCdE3"
    application_runtime_boundary_arn             = "arn:aws:iam::${var.aws_account_id}:policy/gootip/bootstrap/GootipApplicationRuntimeBoundary"
  }

  assert {
    condition = (
      length(jsondecode(aws_iam_policy.db_config_secrets_read[0].policy).Statement) == 1 &&
      jsondecode(aws_iam_policy.db_config_secrets_read[0].policy).Statement[0].Resource[0] == var.db_master_secret_arn
    )
    error_message = "An explicit db_master_secret_arn must render a fully known administrative secrets policy that reads only that ARN."
  }

  assert {
    condition = (
      toset(jsondecode(aws_iam_policy.db_config_secrets_read[0].policy).Statement[0].Resource) == toset([
        var.db_master_secret_arn,
        var.auth_runtime_secret_arn,
        var.auth_migrator_secret_arn,
        var.core_runtime_secret_arn,
        var.core_migrator_secret_arn,
        var.db_operator_secret_arn,
      ])
    )
    error_message = "The administrative secrets policy must keep exactly the four reviewed secret ARNs."
  }
}
