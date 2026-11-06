mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = {
      names = ["us-east-2a", "us-east-2b", "us-east-2c"]
    }
  }

  mock_data "aws_rds_engine_version" {
    defaults = {
      latest                 = false
      parameter_group_family = "postgres18"
      version                = "18.6"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"secretsmanager:GetSecretValue\",\"Resource\":\"arn:aws:secretsmanager:us-east-2:123456789012:secret:gootip-dev-core-migrator-AbCd12\"}]}"
    }
  }
}

mock_provider "aws" {
  alias = "billing"
}

run "core_migrations_are_absent_by_default" {
  command = plan

  variables {
    aws_account_id                               = "123456789012"
    rds_final_snapshot_identifier                = "gootip-dev-final"
    alarm_notification_email                     = "operator@example.com"
    rds_max_connections                          = 81
    monthly_cost_budget_usd                      = 10
    monthly_cost_budget_actual_threshold_percent = 80
  }

  assert {
    condition = (
      var.core_migrations_deployment_enabled == false &&
      length(aws_lambda_function.core_migrations) == 0 &&
      length(aws_lambda_alias.core_migrations_deployment) == 0 &&
      length(aws_iam_role.core_migrations) == 0 &&
      length(aws_security_group.core_migrations) == 0 &&
      length(aws_cloudwatch_log_group.core_migrations) == 0 &&
      output.core_migrations_deployment_alias_arn == null
    )
    error_message = "Core migration resources and handoff outputs must remain absent until deployment is explicitly enabled."
  }
}

run "core_migrations_use_only_reviewed_private_resources" {
  command = plan

  variables {
    aws_account_id                               = "123456789012"
    rds_final_snapshot_identifier                = "gootip-dev-final"
    alarm_notification_email                     = "operator@example.com"
    rds_max_connections                          = 81
    monthly_cost_budget_usd                      = 10
    monthly_cost_budget_actual_threshold_percent = 80
    core_migrations_deployment_enabled           = true
    core_migrator_secret_arn                     = "arn:aws:secretsmanager:us-east-2:123456789012:secret:gootip-dev-core-migrator-AbCd12"
    core_migrations_runtime_boundary_arn         = "arn:aws:iam::123456789012:policy/gootip/bootstrap/GootipApplicationRuntimeBoundary"
  }

  assert {
    condition = (
      aws_lambda_function.core_migrations[0].function_name == "gootip-dev-core-migrations" &&
      aws_lambda_function.core_migrations[0].runtime == "nodejs24.x" &&
      aws_lambda_function.core_migrations[0].handler == "dist/migrations/lambda.handler" &&
      toset(aws_lambda_function.core_migrations[0].architectures) == toset(["arm64"]) &&
      aws_lambda_function.core_migrations[0].memory_size == 512 &&
      aws_lambda_function.core_migrations[0].timeout == 600 &&
      aws_lambda_function.core_migrations[0].reserved_concurrent_executions == 1 &&
      length(aws_lambda_function.core_migrations[0].layers) == 1 &&
      aws_lambda_alias.core_migrations_deployment[0].name == "deployment"
    )
    error_message = "The Core migration Lambda must use the reviewed Node.js 24 ARM64 artifact, shared CA layer, bounded configuration, and deployment alias."
  }

  assert {
    condition = (
      aws_iam_role.core_migrations[0].name == "gootip-dev-core-migrations-lambda" &&
      aws_iam_role.core_migrations[0].path == "/gootip/application/" &&
      aws_iam_role.core_migrations[0].permissions_boundary == "arn:aws:iam::123456789012:policy/gootip/bootstrap/GootipApplicationRuntimeBoundary" &&
      aws_iam_policy.core_migrations_secrets_read[0].name == "gootip-dev-core-migrations-secrets-read"
    )
    error_message = "The Core execution role must use its exact boundary and read only the exact Core migrator secret."
  }

  assert {
    condition = (
      length(aws_security_group.core_migrations[0].egress) == 0 &&
      aws_vpc_security_group_egress_rule.core_migrations_to_rds_postgres[0].ip_protocol == "tcp" &&
      aws_vpc_security_group_egress_rule.core_migrations_to_rds_postgres[0].from_port == 5432
    )
    error_message = "The Core migration security group must allow PostgreSQL on port 5432 with TCP to an explicitly referenced destination security group."
  }

  assert {
    condition = (
      aws_vpc_security_group_egress_rule.core_migrations_to_secretsmanager[0].ip_protocol == "tcp" &&
      aws_vpc_security_group_egress_rule.core_migrations_to_secretsmanager[0].from_port == 443
    )
    error_message = "The Core migration security group must allow HTTPS on port 443 with TCP to an explicitly referenced destination security group."
  }

  assert {
    condition = (
      aws_cloudwatch_log_group.core_migrations[0].name == "/aws/lambda/gootip-dev-core-migrations" &&
      aws_cloudwatch_log_group.core_migrations[0].retention_in_days == 7
    )
    error_message = "The Core migration log group must retain seven days and expose only the exact deployment-alias ARN handoff."
  }
}
