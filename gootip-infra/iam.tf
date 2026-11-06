# Execution role for the future app Lambda. Secret reads are scoped to the two
# exact ARNs (app secret + auth-runtime credential). The RDS master secret is
# administrative-only and is never referenced here.
locals {
  lambda_hardening_functions = {
    auth = {
      enabled       = var.application_runtime_deployment_enabled
      function_name = "gootip-auth-${var.env}"
      role_name     = "gootip-auth-${var.env}-lambda"
    }
    core_api = {
      enabled       = var.core_runtime_deployment_enabled
      function_name = "gootip-core-${var.env}"
      role_name     = "gootip-core-${var.env}-lambda"
    }
    db_config = {
      enabled       = var.db_config_deployment_enabled
      function_name = "lambda_db_config"
      role_name     = "gootip-db-config-${var.env}-lambda"
    }
    auth_migrations = {
      enabled       = var.auth_migrations_deployment_enabled
      function_name = "${var.project}-${var.env}-auth-migrations"
      role_name     = "${var.project}-${var.env}-auth-migrations-lambda"
    }
    core_migrations = {
      enabled       = var.core_migrations_deployment_enabled
      function_name = "${var.project}-${var.env}-core-migrations"
      role_name     = "${var.project}-${var.env}-core-migrations-lambda"
    }
  }

  enabled_lambda_hardening_functions = {
    for name, function in local.lambda_hardening_functions : name => function
    if function.enabled
  }

  lambda_vpc_interface_actions = [
    "ec2:AssignPrivateIpAddresses",
    "ec2:CreateNetworkInterface",
    "ec2:DeleteNetworkInterface",
    "ec2:DescribeNetworkInterfaces",
    "ec2:DescribeSubnets",
    "ec2:UnassignPrivateIpAddresses",
  ]
}

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  count = var.application_runtime_deployment_enabled ? 1 : 0

  name                 = "gootip-auth-${var.env}-lambda"
  path                 = "/gootip/application/"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume_role.json
  permissions_boundary = var.application_runtime_boundary_arn

  tags = {
    Name       = "gootip-auth-${var.env}-lambda"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_iam_role" "core_api" {
  count = var.core_runtime_deployment_enabled ? 1 : 0

  name                 = "gootip-core-${var.env}-lambda"
  path                 = "/gootip/application/"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume_role.json
  permissions_boundary = var.application_runtime_boundary_arn

  tags = {
    Name       = "gootip-core-${var.env}-lambda"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

data "aws_iam_policy_document" "secrets_read" {
  count = var.application_runtime_deployment_enabled ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]

    resources = [
      var.app_secret_arn,
      var.auth_runtime_secret_arn,
    ]
  }
}

resource "aws_iam_policy" "secrets_read" {
  count = var.application_runtime_deployment_enabled ? 1 : 0

  name   = "gootip-auth-${var.env}-secrets-read"
  policy = data.aws_iam_policy_document.secrets_read[0].json

  tags = {
    Name       = "gootip-auth-${var.env}-secrets-read"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_iam_role_policy_attachment" "secrets_read" {
  count      = var.application_runtime_deployment_enabled ? 1 : 0
  role       = aws_iam_role.lambda[0].name
  policy_arn = aws_iam_policy.secrets_read[0].arn
}

data "aws_iam_policy_document" "core_api_secrets_read" {
  count = var.core_runtime_deployment_enabled ? 1 : 0

  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.core_runtime_secret_arn]
  }
}

resource "aws_iam_policy" "core_api_secrets_read" {
  count = var.core_runtime_deployment_enabled ? 1 : 0

  name   = "gootip-core-${var.env}-secrets-read"
  policy = data.aws_iam_policy_document.core_api_secrets_read[0].json

  tags = {
    Name       = "gootip-core-${var.env}-secrets-read"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_iam_role_policy_attachment" "core_api_secrets_read" {
  count      = var.core_runtime_deployment_enabled ? 1 : 0
  role       = aws_iam_role.core_api[0].name
  policy_arn = aws_iam_policy.core_api_secrets_read[0].arn
}

# Independent execution role for the administrative database bootstrap. It uses
# its own path and security group, and is bounded by the bootstrap-owned runtime
# boundary just like every other runtime role. Its fixed reviewed operation
# reads exactly the master, runtime, migrator, and operator secret ARNs.
resource "aws_iam_role" "db_config" {
  count = var.db_config_deployment_enabled ? 1 : 0

  name                 = "gootip-db-config-${var.env}-lambda"
  path                 = "/gootip/administrative/"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume_role.json
  permissions_boundary = var.application_runtime_boundary_arn

  tags = {
    Name       = "gootip-db-config-${var.env}-lambda"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

data "aws_iam_policy_document" "db_config_secrets_read" {
  count = var.db_config_deployment_enabled ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]

    resources = [
      var.db_master_secret_arn,
      var.auth_runtime_secret_arn,
      var.auth_migrator_secret_arn,
      var.core_runtime_secret_arn,
      var.core_migrator_secret_arn,
      var.db_operator_secret_arn,
    ]
  }
}

resource "aws_iam_policy" "db_config_secrets_read" {
  count = var.db_config_deployment_enabled ? 1 : 0

  name   = "gootip-db-config-${var.env}-secrets-read"
  policy = data.aws_iam_policy_document.db_config_secrets_read[0].json

  tags = {
    Name       = "gootip-db-config-${var.env}-secrets-read"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_iam_role_policy_attachment" "db_config_secrets_read" {
  count      = var.db_config_deployment_enabled ? 1 : 0
  role       = aws_iam_role.db_config[0].name
  policy_arn = aws_iam_policy.db_config_secrets_read[0].arn
}

resource "aws_iam_role" "auth_migrations" {
  count = var.auth_migrations_deployment_enabled ? 1 : 0

  name                 = "${var.project}-${var.env}-auth-migrations-lambda"
  path                 = "/gootip/application/"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume_role.json
  permissions_boundary = var.application_runtime_boundary_arn

  tags = {
    Name       = "${var.project}-${var.env}-auth-migrations-lambda"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

data "aws_iam_policy_document" "auth_migrations_secrets_read" {
  count = var.auth_migrations_deployment_enabled ? 1 : 0

  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.auth_migrator_secret_arn]
  }
}

resource "aws_iam_policy" "auth_migrations_secrets_read" {
  count = var.auth_migrations_deployment_enabled ? 1 : 0

  name   = "${var.project}-${var.env}-auth-migrations-secrets-read"
  policy = data.aws_iam_policy_document.auth_migrations_secrets_read[0].json

  tags = {
    Name       = "${var.project}-${var.env}-auth-migrations-secrets-read"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_iam_role_policy_attachment" "auth_migrations_secrets_read" {
  count      = var.auth_migrations_deployment_enabled ? 1 : 0
  role       = aws_iam_role.auth_migrations[0].name
  policy_arn = aws_iam_policy.auth_migrations_secrets_read[0].arn
}

resource "aws_iam_role" "core_migrations" {
  count = var.core_migrations_deployment_enabled ? 1 : 0

  name                 = "${var.project}-${var.env}-core-migrations-lambda"
  path                 = "/gootip/application/"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume_role.json
  permissions_boundary = var.core_migrations_runtime_boundary_arn

  tags = {
    Name       = "${var.project}-${var.env}-core-migrations-lambda"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

# The broad AWS-managed attachment resources remain only for the defined but
# disabled Auth function; deployed functions use their scoped replacements.

data "aws_iam_policy_document" "core_migrations_secrets_read" {
  count = var.core_migrations_deployment_enabled ? 1 : 0

  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.core_migrator_secret_arn]
  }
}

resource "aws_iam_policy" "core_migrations_secrets_read" {
  count = var.core_migrations_deployment_enabled ? 1 : 0

  name   = "${var.project}-${var.env}-core-migrations-secrets-read"
  policy = data.aws_iam_policy_document.core_migrations_secrets_read[0].json

  tags = {
    Name       = "${var.project}-${var.env}-core-migrations-secrets-read"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_iam_role_policy_attachment" "core_migrations_secrets_read" {
  count      = var.core_migrations_deployment_enabled ? 1 : 0
  role       = aws_iam_role.core_migrations[0].name
  policy_arn = aws_iam_policy.core_migrations_secrets_read[0].arn
}

# SPEC 07.1 replacement policies are attached only to their matching function
# roles. Core, Auth migrations, and Admin have completed separate reviewed
# transitions; the defined-but-disabled Auth function keeps its tested setup.
data "aws_iam_policy_document" "lambda_logs" {
  for_each = local.enabled_lambda_hardening_functions

  statement {
    sid       = "WriteOnlyOwnLogStreams"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${each.value.function_name}:*"]
  }
}

resource "aws_iam_policy" "lambda_logs" {
  for_each = local.enabled_lambda_hardening_functions

  name   = "${each.value.function_name}-logs"
  policy = data.aws_iam_policy_document.lambda_logs[each.key].json

  tags = {
    Name       = "${each.value.function_name}-logs"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  for_each = local.enabled_lambda_hardening_functions

  role       = each.value.role_name
  policy_arn = aws_iam_policy.lambda_logs[each.key].arn
}

data "aws_iam_policy_document" "lambda_vpc_scoped" {
  for_each = local.enabled_lambda_hardening_functions

  statement {
    sid       = "AllowLambdaVpcInterfaceOperationsInConfiguredRegion"
    effect    = "Allow"
    actions   = local.lambda_vpc_interface_actions
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }
  }

  statement {
    sid       = "DenyFunctionCodeVpcInterfaceOperations"
    effect    = "Deny"
    actions   = local.lambda_vpc_interface_actions
    resources = ["*"]

    condition {
      test     = "ArnEquals"
      variable = "lambda:SourceFunctionArn"
      values   = ["arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:function:${each.value.function_name}"]
    }
  }
}

resource "aws_iam_policy" "lambda_vpc_scoped" {
  for_each = local.enabled_lambda_hardening_functions

  name   = "${each.value.function_name}-vpc"
  policy = data.aws_iam_policy_document.lambda_vpc_scoped[each.key].json

  tags = {
    Name       = "${each.value.function_name}-vpc"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_iam_role_policy_attachment" "lambda_vpc_scoped" {
  for_each = local.enabled_lambda_hardening_functions

  role       = each.value.role_name
  policy_arn = aws_iam_policy.lambda_vpc_scoped[each.key].arn
}
