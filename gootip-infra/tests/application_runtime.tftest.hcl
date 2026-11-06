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
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

mock_provider "aws" {
  alias = "billing"
}

run "prepare_creates_only_route_less_api" {
  command = plan

  variables {
    aws_account_id                               = "123456789012"
    rds_final_snapshot_identifier                = "gootip-dev-final"
    alarm_notification_email                     = "operator@example.com"
    rds_max_connections                          = 81
    monthly_cost_budget_usd                      = 10
    monthly_cost_budget_actual_threshold_percent = 80
    api_preparation_enabled                      = true
  }

  assert {
    condition = (
      length(aws_apigatewayv2_api.main) == 1 &&
      length(aws_apigatewayv2_stage.default) == 0 &&
      length(aws_apigatewayv2_integration.auth) == 0 &&
      length(aws_apigatewayv2_integration.core) == 0 &&
      length(aws_apigatewayv2_route.auth_root) == 0 &&
      length(aws_apigatewayv2_route.auth_proxy) == 0 &&
      length(aws_apigatewayv2_route.auth_discovery) == 0 &&
      length(aws_apigatewayv2_route.core) == 0 &&
      length(aws_lambda_function.gootip_auth) == 0 &&
      length(aws_lambda_function.gootip_core) == 0
    )
    error_message = "API preparation must create only the shared HTTP API shell and default stage."
  }
}

run "auth_activation_uses_scoped_identity_and_explicit_routes" {
  command = plan

  variables {
    aws_account_id                               = "123456789012"
    rds_final_snapshot_identifier                = "gootip-dev-final"
    alarm_notification_email                     = "operator@example.com"
    rds_max_connections                          = 81
    monthly_cost_budget_usd                      = 10
    monthly_cost_budget_actual_threshold_percent = 80
    application_runtime_deployment_enabled       = true
    app_secret_arn                               = "arn:aws:secretsmanager:us-east-2:123456789012:secret:gootip-auth-dev-AbCd12"
    auth_runtime_secret_arn                      = "arn:aws:secretsmanager:us-east-2:123456789012:secret:gootip-dev-auth-runtime-AbCd12"
    application_runtime_boundary_arn             = "arn:aws:iam::123456789012:policy/gootip/bootstrap/GootipApplicationRuntimeBoundary"
    better_auth_url                              = "https://auth.example.test"
  }

  assert {
    condition = (
      aws_lambda_function.gootip_auth[0].function_name == "gootip-auth-dev" &&
      aws_lambda_function.gootip_auth[0].reserved_concurrent_executions == 5 &&
      length(aws_apigatewayv2_route.auth_root) == 1 &&
      length(aws_apigatewayv2_route.auth_proxy) == 1 &&
      length(aws_apigatewayv2_route.auth_discovery) == 1 &&
      length(aws_apigatewayv2_route.core) == 0 &&
      length(aws_lambda_permission.auth_root) == 1 &&
      length(aws_lambda_permission.auth_proxy) == 1 &&
      length(aws_lambda_permission.auth_discovery) == 1
    )
    error_message = "Auth activation must expose only explicit Auth and discovery routes with the reviewed concurrency."
  }

  assert {
    condition = (
      aws_lambda_function.gootip_auth[0].environment[0].variables.SECRET_ARN == var.app_secret_arn &&
      aws_lambda_function.gootip_auth[0].environment[0].variables.DB_RUNTIME_SECRET_ARN == var.auth_runtime_secret_arn &&
      !contains(keys(aws_lambda_function.gootip_auth[0].environment[0].variables), "DB_MASTER_SECRET_ARN") &&
      !contains(keys(aws_lambda_function.gootip_auth[0].environment[0].variables), "CORE_RUNTIME_SECRET_ARN")
    )
    error_message = "Auth must receive only its signing/runtime secret references and exact secret-read permissions."
  }
}

run "core_activation_uses_jwt_and_independent_private_runtime" {
  command = plan

  variables {
    aws_account_id                               = "123456789012"
    rds_final_snapshot_identifier                = "gootip-dev-final"
    alarm_notification_email                     = "operator@example.com"
    rds_max_connections                          = 81
    monthly_cost_budget_usd                      = 10
    monthly_cost_budget_actual_threshold_percent = 80
    application_runtime_deployment_enabled       = true
    core_runtime_deployment_enabled              = true
    app_secret_arn                               = "arn:aws:secretsmanager:us-east-2:123456789012:secret:gootip-auth-dev-AbCd12"
    auth_runtime_secret_arn                      = "arn:aws:secretsmanager:us-east-2:123456789012:secret:gootip-dev-auth-runtime-AbCd12"
    core_runtime_secret_arn                      = "arn:aws:secretsmanager:us-east-2:123456789012:secret:gootip-dev-core-runtime-AbCd12"
    application_runtime_boundary_arn             = "arn:aws:iam::123456789012:policy/gootip/bootstrap/GootipApplicationRuntimeBoundary"
    better_auth_url                              = "https://auth.example.test"
  }

  assert {
    condition = (
      aws_lambda_function.gootip_core[0].function_name == "gootip-core-dev" &&
      aws_lambda_function.gootip_core[0].runtime == "nodejs24.x" &&
      aws_lambda_function.gootip_core[0].handler == "dist/lambda.handler" &&
      toset(aws_lambda_function.gootip_core[0].architectures) == toset(["arm64"]) &&
      aws_lambda_function.gootip_core[0].reserved_concurrent_executions == 5 &&
      aws_lambda_function.gootip_core[0].environment[0].variables.CORE_RUNTIME_SECRET_ARN == var.core_runtime_secret_arn &&
      aws_lambda_function.gootip_core[0].environment[0].variables.CORE_PG_POOL_MAX == "2" &&
      !contains(keys(aws_lambda_function.gootip_core[0].environment[0].variables), "SECRET_ARN") &&
      !contains(keys(aws_lambda_function.gootip_core[0].environment[0].variables), "DB_MASTER_SECRET_ARN")
    )
    error_message = "Core must use its independent Node.js 24 ARM64 function, private runtime secret, pool, and reserved concurrency."
  }

  assert {
    condition     = length(aws_apigatewayv2_authorizer.jwt) == 1 && aws_apigatewayv2_authorizer.jwt[0].authorizer_type == "JWT"
    error_message = "Core must use a JWT authorizer."
  }

  assert {
    condition = (
      contains(aws_apigatewayv2_authorizer.jwt[0].identity_sources, "$request.header.Authorization") &&
      aws_apigatewayv2_authorizer.jwt[0].jwt_configuration[0].issuer == var.better_auth_url &&
      contains(aws_apigatewayv2_authorizer.jwt[0].jwt_configuration[0].audience, var.jwt_audience)
    )
    error_message = "Core JWT authorizer must use the configured issuer, audience, and Authorization header."
  }

  assert {
    condition = (
      length(aws_apigatewayv2_route.core) == 11 &&
      aws_apigatewayv2_route.core["GET /api/products"].authorization_type == "NONE" &&
      aws_apigatewayv2_route.core["POST /api/categories"].authorization_type == "JWT" &&
      length(aws_lambda_permission.core_route) == 11
    )
    error_message = "Core must expose only the enumerated routes, protect writes, and scope Lambda invocation to each route."
  }

  assert {
    condition = (
      aws_vpc_security_group_egress_rule.lambda_to_rds_postgres["core_api"].from_port == 5432 &&
      aws_vpc_security_group_egress_rule.lambda_to_secretsmanager["core_api"].from_port == 443 &&
      aws_cloudwatch_log_group.core_api[0].retention_in_days == 7 &&
      aws_cloudwatch_metric_alarm.core_api_errors[0].metric_name == "Errors" &&
      aws_cloudwatch_metric_alarm.core_api_throttles[0].metric_name == "Throttles"
    )
    error_message = "Core must have exact secret access, private destination-only egress, native logs, and runtime alarms."
  }
}
