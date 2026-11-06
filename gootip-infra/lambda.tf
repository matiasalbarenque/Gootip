# Deferred app Lambda. SPEC 02.2 keeps this resource absent, so foundation
# plans never require the sibling application ZIP or a public application URL.
resource "aws_lambda_function" "gootip_auth" {
  count = var.application_runtime_deployment_enabled ? 1 : 0

  function_name                  = "gootip-auth-${var.env}"
  role                           = aws_iam_role.lambda[0].arn
  runtime                        = var.lambda_runtime
  handler                        = "dist/lambda.handler"
  architectures                  = ["arm64"]
  layers                         = [aws_lambda_layer_version.rds_ca.arn]
  memory_size                    = var.lambda_memory
  timeout                        = var.lambda_timeout
  reserved_concurrent_executions = var.lambda_reserved_concurrent_executions

  filename         = "${path.module}/../gootip-auth/lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/../gootip-auth/lambda.zip")

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.application_client.id]
  }

  environment {
    variables = {
      POSTGRES_DB_HOST        = aws_db_instance.main.address
      POSTGRES_DB_PORT        = "5432"
      POSTGRES_DB_NAME        = var.rds_db_name
      POSTGRES_SSL_MODE       = "verify-full"
      POSTGRES_CA_PATH        = "/opt/certs/rds-ca-bundle.pem"
      BETTER_AUTH_URL         = var.better_auth_url
      JWT_AUDIENCE            = var.jwt_audience
      FRONTEND_URL            = var.frontend_url
      SECRET_ARN              = var.app_secret_arn
      DB_RUNTIME_SECRET_ARN   = var.auth_runtime_secret_arn
      AUTH_PG_POOL_MAX        = tostring(var.auth_pg_pool_max)
      AUTH_RATE_LIMIT_ENABLED = tostring(var.auth_rate_limit_enabled)
      AUTH_RATE_LIMIT_RULES   = var.auth_rate_limit_rules
    }
  }

  tags = {
    Name       = "gootip-auth-${var.env}"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }

  depends_on = [
    aws_cloudwatch_log_group.gootip_auth,
    aws_iam_role_policy_attachment.secrets_read[0],
    aws_iam_role_policy_attachment.lambda_logs["auth"],
    aws_iam_role_policy_attachment.lambda_vpc_scoped["auth"],
  ]

  lifecycle {
    precondition {
      condition = (
        var.app_secret_arn != null &&
        var.application_runtime_boundary_arn != null &&
        var.auth_runtime_secret_arn != null &&
        can(regex("^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$", var.better_auth_url))
      )
      error_message = "Auth activation requires exact signing/runtime secret references, the runtime boundary, and the HTTPS API origin without a path or trailing slash."
    }
  }
}

resource "aws_lambda_function" "gootip_core" {
  count = var.core_runtime_deployment_enabled ? 1 : 0

  function_name                  = "gootip-core-${var.env}"
  role                           = aws_iam_role.core_api[0].arn
  runtime                        = "nodejs24.x"
  handler                        = "dist/lambda.handler"
  architectures                  = ["arm64"]
  layers                         = [aws_lambda_layer_version.rds_ca.arn]
  memory_size                    = var.lambda_memory
  timeout                        = var.lambda_timeout
  reserved_concurrent_executions = var.core_lambda_reserved_concurrent_executions

  filename         = "${path.module}/../gootip-core/lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/../gootip-core/lambda.zip")

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.core_api[0].id]
  }

  environment {
    variables = {
      POSTGRES_DB_HOST        = aws_db_instance.main.address
      POSTGRES_DB_PORT        = "5432"
      POSTGRES_DB_NAME        = var.rds_db_name
      POSTGRES_DB_USER        = "core_runtime"
      POSTGRES_SSL_MODE       = "verify-full"
      POSTGRES_CA_PATH        = "/opt/certs/rds-ca-bundle.pem"
      CORE_PG_POOL_MAX        = tostring(var.core_pg_pool_max)
      CORE_RUNTIME_SECRET_ARN = var.core_runtime_secret_arn
    }
  }

  tags = {
    Name       = "gootip-core-${var.env}"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }

  depends_on = [
    aws_cloudwatch_log_group.core_api,
    aws_iam_role_policy_attachment.core_api_secrets_read[0],
    aws_iam_role_policy_attachment.lambda_logs["core_api"],
    aws_iam_role_policy_attachment.lambda_vpc_scoped["core_api"],
  ]

  lifecycle {
    precondition {
      condition = (
        var.core_runtime_secret_arn != null &&
        var.application_runtime_boundary_arn != null &&
        var.application_runtime_deployment_enabled &&
        can(regex("^https://[^/]+$", var.better_auth_url))
      )
      error_message = "Core activation requires the exact Core runtime secret, shared runtime boundary, an active Auth issuer, and an HTTPS origin without a path or trailing slash."
    }
  }
}

# Administrative database bootstrap function. It has no public or scheduled
# trigger and runs only through the separately authorized operator procedure.
# Secret ARNs travel as non-sensitive environment references; values are read at
# runtime from Secrets Manager through the private interface endpoint.
resource "aws_lambda_function" "gootip_db_config" {
  count = var.db_config_deployment_enabled ? 1 : 0

  function_name = "lambda_db_config"
  role          = aws_iam_role.db_config[0].arn
  runtime       = var.db_config_lambda_runtime
  handler       = "gootip_db_config.handler.lambda_handler"
  architectures = ["arm64"]
  layers        = [aws_lambda_layer_version.rds_ca.arn]
  memory_size   = var.db_config_lambda_memory
  timeout       = var.db_config_lambda_timeout

  filename         = "${path.module}/../gootip-db-config/lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/../gootip-db-config/lambda.zip")

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.db_config[0].id]
  }

  environment {
    variables = {
      POSTGRES_DB_HOST           = aws_db_instance.main.address
      POSTGRES_DB_PORT           = "5432"
      POSTGRES_DB_NAME           = var.rds_db_name
      POSTGRES_SSL_MODE          = "verify-full"
      POSTGRES_CA_PATH           = "/opt/certs/rds-ca-bundle.pem"
      DB_MASTER_SECRET_ARN       = coalesce(var.db_master_secret_arn, aws_db_instance.main.master_user_secret[0].secret_arn)
      AUTH_RUNTIME_SECRET_ARN    = var.auth_runtime_secret_arn
      AUTH_MIGRATOR_SECRET_ARN   = var.auth_migrator_secret_arn
      CORE_RUNTIME_SECRET_ARN    = var.core_runtime_secret_arn
      CORE_MIGRATOR_SECRET_ARN   = var.core_migrator_secret_arn
      DB_OPERATOR_SECRET_ARN     = var.db_operator_secret_arn
      DB_CONNECT_TIMEOUT         = "10"
      DB_STATEMENT_TIMEOUT_MS    = "30000"
      DB_LOCK_ACQUIRE_TIMEOUT_MS = "5000"
    }
  }

  tags = {
    Name       = "lambda_db_config"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }

  depends_on = [
    aws_cloudwatch_log_group.db_config,
    aws_iam_role_policy_attachment.db_config_secrets_read[0],
    aws_iam_role_policy_attachment.lambda_logs["db_config"],
    aws_iam_role_policy_attachment.lambda_vpc_scoped["db_config"],
  ]

  lifecycle {
    precondition {
      condition = (
        var.db_master_secret_arn != null &&
        var.auth_runtime_secret_arn != null &&
        var.auth_migrator_secret_arn != null &&
        var.core_runtime_secret_arn != null &&
        var.core_migrator_secret_arn != null &&
        var.db_operator_secret_arn != null &&
        var.application_runtime_boundary_arn != null
      )
      error_message = "The administrative function requires the reviewed runtime boundary and exact RDS, Auth, Core, and operator secret ARN handoffs."
    }
  }
}

resource "aws_lambda_function" "auth_migrations" {
  count = var.auth_migrations_deployment_enabled ? 1 : 0

  function_name = "${var.project}-${var.env}-auth-migrations"
  role          = aws_iam_role.auth_migrations[0].arn
  runtime       = "nodejs24.x"
  handler       = "dist/migrations/lambda.handler"
  architectures = ["arm64"]
  layers        = [aws_lambda_layer_version.rds_ca.arn]
  memory_size   = var.auth_migrations_lambda_memory
  timeout       = var.auth_migrations_lambda_timeout
  publish       = true

  filename         = "${path.module}/../gootip-auth/migration-lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/../gootip-auth/migration-lambda.zip")

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.auth_migrations[0].id]
  }

  environment {
    variables = {
      POSTGRES_DB_HOST                    = aws_db_instance.main.address
      POSTGRES_DB_PORT                    = "5432"
      POSTGRES_DB_NAME                    = var.rds_db_name
      POSTGRES_SSL_MODE                   = "verify-full"
      POSTGRES_CA_PATH                    = "/opt/certs/rds-ca-bundle.pem"
      MIGRATION_DB_USER                   = "auth_migrator"
      MIGRATION_DB_RUNTIME_USER           = "auth_runtime"
      MIGRATION_DB_SCHEMA                 = "auth"
      MIGRATION_CREDENTIAL_SECRET_ARN     = var.auth_migrator_secret_arn
      MIGRATION_CONNECT_TIMEOUT_SECONDS   = "10"
      MIGRATION_LOCK_TIMEOUT_SECONDS      = "30"
      MIGRATION_STATEMENT_TIMEOUT_SECONDS = "120"
      MIGRATION_OPERATION_TIMEOUT_SECONDS = "300"
      MIGRATION_LAMBDA_TIMEOUT_SECONDS    = tostring(var.auth_migrations_lambda_timeout)
    }
  }

  tags = {
    Name       = "${var.project}-${var.env}-auth-migrations"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }

  depends_on = [
    aws_cloudwatch_log_group.auth_migrations,
    aws_iam_role_policy_attachment.auth_migrations_secrets_read[0],
    aws_iam_role_policy_attachment.lambda_logs["auth_migrations"],
    aws_iam_role_policy_attachment.lambda_vpc_scoped["auth_migrations"],
  ]

  lifecycle {
    precondition {
      condition = (
        var.application_runtime_boundary_arn != null &&
        var.auth_migrator_secret_arn != null
      )
      error_message = "The auth migration runner requires the reviewed runtime boundary and auth-migrator secret ARN handoffs."
    }
  }
}

resource "aws_lambda_alias" "auth_migrations_deployment" {
  count = var.auth_migrations_deployment_enabled ? 1 : 0

  name             = "deployment"
  description      = "Authorized only for auth migration validate and apply operations."
  function_name    = aws_lambda_function.auth_migrations[0].function_name
  function_version = aws_lambda_function.auth_migrations[0].version
}

resource "aws_lambda_alias" "auth_migrations_baseline" {
  count = var.auth_migrations_deployment_enabled ? 1 : 0

  name             = "baseline"
  description      = "Authorized only for explicit auth migration baseline operations."
  function_name    = aws_lambda_function.auth_migrations[0].function_name
  function_version = var.auth_migrations_baseline_version
}

resource "aws_lambda_function" "core_migrations" {
  count = var.core_migrations_deployment_enabled ? 1 : 0

  function_name                  = "${var.project}-${var.env}-core-migrations"
  role                           = aws_iam_role.core_migrations[0].arn
  runtime                        = "nodejs24.x"
  handler                        = "dist/migrations/lambda.handler"
  architectures                  = ["arm64"]
  layers                         = [aws_lambda_layer_version.rds_ca.arn]
  memory_size                    = var.core_migrations_lambda_memory
  timeout                        = var.core_migrations_lambda_timeout
  reserved_concurrent_executions = 1
  publish                        = true

  filename         = "${path.module}/../gootip-core/migration-lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/../gootip-core/migration-lambda.zip")

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.core_migrations[0].id]
  }

  environment {
    variables = {
      POSTGRES_DB_HOST                = aws_db_instance.main.address
      POSTGRES_DB_PORT                = "5432"
      POSTGRES_DB_NAME                = var.rds_db_name
      POSTGRES_DB_USER                = "core_migrator"
      POSTGRES_SSL_MODE               = "verify-full"
      POSTGRES_CA_PATH                = "/opt/certs/rds-ca-bundle.pem"
      CORE_PG_POOL_MAX                = "1"
      MIGRATION_CREDENTIAL_SECRET_ARN = var.core_migrator_secret_arn
    }
  }

  tags = {
    Name       = "${var.project}-${var.env}-core-migrations"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }

  depends_on = [
    aws_cloudwatch_log_group.core_migrations,
    aws_iam_role_policy_attachment.core_migrations_secrets_read[0],
    aws_iam_role_policy_attachment.lambda_logs["core_migrations"],
    aws_iam_role_policy_attachment.lambda_vpc_scoped["core_migrations"],
  ]

  lifecycle {
    precondition {
      condition = (
        var.core_migrator_secret_arn != null &&
        var.core_migrations_runtime_boundary_arn != null
      )
      error_message = "The Core migration runner requires the reviewed runtime boundary and Core migrator secret ARN handoffs."
    }
  }
}

resource "aws_lambda_alias" "core_migrations_deployment" {
  count = var.core_migrations_deployment_enabled ? 1 : 0

  name             = "deployment"
  description      = "Authorized only for reviewed Core migration validate and apply operations."
  function_name    = aws_lambda_function.core_migrations[0].function_name
  function_version = aws_lambda_function.core_migrations[0].version
}
