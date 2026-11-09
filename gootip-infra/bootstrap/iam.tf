data "aws_partition" "current" {}

resource "aws_iam_user" "source" {
  provider             = aws.source_user
  name                 = var.source_user_name
  path                 = "/"
  force_destroy        = false
  permissions_boundary = var.source_user_cutover_enabled ? aws_iam_policy.source_user_assume_only_boundary.arn : null

  lifecycle {
    prevent_destroy = true
    # The existing user is imported before its historical tags are reconciled
    # through a separate reviewed cutover change.
    ignore_changes = [tags]
  }
}

locals {
  iam_account_arn_prefix = "arn:${data.aws_partition.current.partition}:iam::${var.aws_account_id}"

  source_user_arn                       = "${local.iam_account_arn_prefix}:user/${var.source_user_name}"
  bootstrap_role_arn                    = "${local.iam_account_arn_prefix}:role/gootip/bootstrap/GootipBootstrapAdmin"
  deployment_role_arn                   = "${local.iam_account_arn_prefix}:role/gootip/deployment/GootipTerraformDeploy"
  database_operator_role_arn            = "${local.iam_account_arn_prefix}:role/gootip/operations/GootipDatabaseOperator"
  credential_provisioner_role_arn       = "${local.iam_account_arn_prefix}:role/gootip/operations/GootipCredentialProvisioner"
  credential_operator_role_arn          = "${local.iam_account_arn_prefix}:role/gootip/operations/GootipCredentialOperator"
  runtime_boundary_arn                  = "${local.iam_account_arn_prefix}:policy/gootip/bootstrap/GootipApplicationRuntimeBoundary"
  bootstrap_policy_arn                  = "${local.iam_account_arn_prefix}:policy/gootip/bootstrap/GootipBootstrapAdminPermissions"
  bootstrap_state_policy_arn            = "${local.iam_account_arn_prefix}:policy/gootip/bootstrap/GootipBootstrapStatePermissions"
  bootstrap_diagnostics_policy_arn      = "${local.iam_account_arn_prefix}:policy/gootip/bootstrap/GootipBootstrapDiagnosticsPermissions"
  deployment_foundation_read_policy_arn = "${local.iam_account_arn_prefix}:policy/gootip/deployment/GootipTerraformDeployFoundationReadPermissions"
  deployment_policy_arn                 = "${local.iam_account_arn_prefix}:policy/gootip/deployment/GootipTerraformDeployPermissions"
  deployment_pass_role_policy_arn       = "${local.iam_account_arn_prefix}:policy/gootip/deployment/GootipTerraformDeployAdministrativePassRole"
  source_boundary_arn                   = "${local.iam_account_arn_prefix}:policy/gootip/bootstrap/GootipSourceUserAssumeOnlyBoundary"
  database_operator_policy_arn          = "${local.iam_account_arn_prefix}:policy/gootip/operations/GootipDatabaseOperatorPermissions"
  credential_provisioner_policy_arn     = "${local.iam_account_arn_prefix}:policy/gootip/operations/GootipCredentialProvisionerPermissions"
  credential_operator_policy_arn        = "${local.iam_account_arn_prefix}:policy/gootip/operations/GootipCredentialOperatorPermissions"

  # Capability-scoped split policies introduced by SPEC 03.1. Their ARNs are
  # declared here so the retained bootstrap core can create them and the
  # policy-administration policy can version, tag, and attach them.
  bootstrap_policy_admin_policy_arn     = "${local.iam_account_arn_prefix}:policy/gootip/bootstrap/GootipBootstrapPolicyAdminPermissions"
  bootstrap_deployment_policy_admin_arn = "${local.iam_account_arn_prefix}:policy/gootip/bootstrap/GootipBootstrapDeploymentPolicyAdminPermissions"
  deployment_network_policy_arn         = "${local.iam_account_arn_prefix}:policy/gootip/deployment/GootipTerraformDeployNetworkPermissions"
  deployment_database_policy_arn        = "${local.iam_account_arn_prefix}:policy/gootip/deployment/GootipTerraformDeployDatabasePermissions"
  deployment_db_config_policy_arn       = "${local.iam_account_arn_prefix}:policy/gootip/deployment/GootipTerraformDeployDbConfigPermissions"
  deployment_auth_migrations_policy_arn = "${local.iam_account_arn_prefix}:policy/gootip/deployment/GootipTerraformDeployAuthMigrationsPermissions"
  deployment_core_migrations_policy_arn = "${local.iam_account_arn_prefix}:policy/gootip/deployment/GootipTerraformDeployCoreMigrationsPermissions"
  deployment_observability_policy_arn   = "${local.iam_account_arn_prefix}:policy/gootip/deployment/GootipTerraformDeployObservabilityPermissions"
  deployment_application_policy_arn     = "${local.iam_account_arn_prefix}:policy/gootip/deployment/GootipTerraformDeployApplicationPermissions"
  deployment_api_gateway_policy_arn     = "${local.iam_account_arn_prefix}:policy/gootip/deployment/GootipTerraformDeployApiGatewayPermissions"
  observability_log_group_arns = [
    "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${var.project}-auth-${var.env}",
    "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/lambda_db_config",
    local.auth_migrations_log_group_arn,
    "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/apigateway/${var.project}-${var.env}-auth",
  ]
  observability_alarm_arns = [
    "arn:${data.aws_partition.current.partition}:cloudwatch:${var.aws_region}:${var.aws_account_id}:alarm:${var.project}-${var.env}-auth-migrations-errors",
    "arn:${data.aws_partition.current.partition}:cloudwatch:${var.aws_region}:${var.aws_account_id}:alarm:${var.project}-${var.env}-rds-cpu",
    "arn:${data.aws_partition.current.partition}:cloudwatch:${var.aws_region}:${var.aws_account_id}:alarm:${var.project}-${var.env}-rds-database-connections",
    "arn:${data.aws_partition.current.partition}:cloudwatch:${var.aws_region}:${var.aws_account_id}:alarm:${var.project}-${var.env}-core-api-errors",
    "arn:${data.aws_partition.current.partition}:cloudwatch:${var.aws_region}:${var.aws_account_id}:alarm:${var.project}-${var.env}-core-api-throttles",
    "arn:${data.aws_partition.current.partition}:cloudwatch:${var.aws_region}:${var.aws_account_id}:alarm:${var.project}-${var.env}-api-5xx",
  ]
  api_observability_log_group_arns = [
    "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${var.project}-core-${var.env}",
  ]
  observability_topic_arn              = "arn:${data.aws_partition.current.partition}:sns:${var.aws_region}:${var.aws_account_id}:${var.project}-${var.env}-operational-alarms"
  observability_topic_subscription_arn = "${local.observability_topic_arn}:*"
  observability_budget_arn             = "arn:${data.aws_partition.current.partition}:budgets::${var.aws_account_id}:budget/${var.project}-${var.env}-monthly-actual-cost"
  source_assume_policy_arn             = "${local.iam_account_arn_prefix}:policy/gootip/bootstrap/GootipSourceUserAssumeOnly"

  account_group_path_arn = "${local.iam_account_arn_prefix}:group/*"

  state_bucket_name                        = "gootip-terraform-state-${var.aws_account_id}"
  state_bucket_arn                         = "arn:${data.aws_partition.current.partition}:s3:::${local.state_bucket_name}"
  bootstrap_state_key                      = "bootstrap/terraform.tfstate"
  bootstrap_lock_key                       = "${local.bootstrap_state_key}.tflock"
  application_state_key                    = "gootip/dev/terraform.tfstate"
  application_lock_key                     = "${local.application_state_key}.tflock"
  bootstrap_state_object_arn               = "${local.state_bucket_arn}/${local.bootstrap_state_key}"
  bootstrap_lock_object_arn                = "${local.state_bucket_arn}/${local.bootstrap_lock_key}"
  application_state_object_arn             = "${local.state_bucket_arn}/${local.application_state_key}"
  application_lock_object_arn              = "${local.state_bucket_arn}/${local.application_lock_key}"
  application_database_arn                 = "arn:${data.aws_partition.current.partition}:rds:${var.aws_region}:${var.aws_account_id}:db:${var.project}-${var.env}"
  application_database_arn_pattern         = "arn:${data.aws_partition.current.partition}:rds:${var.aws_region}:${var.aws_account_id}:db:*"
  foundation_parameter_group_arn           = "arn:${data.aws_partition.current.partition}:rds:${var.aws_region}:${var.aws_account_id}:pg:${var.project}-${var.env}-postgres"
  postgres18_parameter_group_arn           = "arn:${data.aws_partition.current.partition}:rds:${var.aws_region}:${var.aws_account_id}:pg:${var.project}-${var.env}-postgres18"
  pre_upgrade_snapshot_arn                 = "arn:${data.aws_partition.current.partition}:rds:${var.aws_region}:${var.aws_account_id}:snapshot:${var.project}-${var.env}-pre-pg18-20261025"
  foundation_subnet_group_arn              = "arn:${data.aws_partition.current.partition}:rds:${var.aws_region}:${var.aws_account_id}:subgrp:${var.project}-${var.env}"
  foundation_layer_arn                     = "arn:${data.aws_partition.current.partition}:lambda:${var.aws_region}:${var.aws_account_id}:layer:${var.project}-${var.env}-rds-ca"
  rds_managed_secret_arn_pattern           = "arn:${data.aws_partition.current.partition}:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:rds!db-*"
  rds_service_linked_role_arn              = "${local.iam_account_arn_prefix}:role/aws-service-role/rds.amazonaws.com/AWSServiceRoleForRDS"
  instance_connect_service_linked_role_arn = "${local.iam_account_arn_prefix}:role/aws-service-role/ec2-instance-connect.amazonaws.com/AWSServiceRoleForEc2InstanceConnect"
  rds_kms_key_arn                          = "arn:${data.aws_partition.current.partition}:kms:${var.aws_region}:${var.aws_account_id}:key/e0638b06-ad54-4317-9670-694aaa5fc422"

  administrative_role_arn              = "${local.iam_account_arn_prefix}:role/gootip/administrative/${var.project}-db-config-${var.env}-lambda"
  auth_migrations_role_arn             = "${local.iam_account_arn_prefix}:role/gootip/application/${var.project}-${var.env}-auth-migrations-lambda"
  core_migrations_role_arn             = "${local.iam_account_arn_prefix}:role/gootip/application/${var.project}-${var.env}-core-migrations-lambda"
  db_config_secrets_policy_arn         = "${local.iam_account_arn_prefix}:policy/${var.project}-db-config-${var.env}-secrets-read"
  db_config_logs_policy_arn            = "${local.iam_account_arn_prefix}:policy/lambda_db_config-logs"
  db_config_vpc_policy_arn             = "${local.iam_account_arn_prefix}:policy/lambda_db_config-vpc"
  db_config_function_arn               = "arn:${data.aws_partition.current.partition}:lambda:${var.aws_region}:${var.aws_account_id}:function:lambda_db_config"
  auth_migrations_secrets_policy_arn   = "${local.iam_account_arn_prefix}:policy/${var.project}-${var.env}-auth-migrations-secrets-read"
  auth_migrations_logs_policy_arn      = "${local.iam_account_arn_prefix}:policy/${var.project}-${var.env}-auth-migrations-logs"
  auth_migrations_vpc_policy_arn       = "${local.iam_account_arn_prefix}:policy/${var.project}-${var.env}-auth-migrations-vpc"
  auth_migrations_function_arn         = "arn:${data.aws_partition.current.partition}:lambda:${var.aws_region}:${var.aws_account_id}:function:${var.project}-${var.env}-auth-migrations"
  auth_migrations_deployment_alias_arn = "${local.auth_migrations_function_arn}:deployment"
  core_migrations_secrets_policy_arn   = "${local.iam_account_arn_prefix}:policy/${var.project}-${var.env}-core-migrations-secrets-read"
  core_migrations_logs_policy_arn      = "${local.iam_account_arn_prefix}:policy/${var.project}-${var.env}-core-migrations-logs"
  core_migrations_vpc_policy_arn       = "${local.iam_account_arn_prefix}:policy/${var.project}-${var.env}-core-migrations-vpc"
  core_migrations_function_arn         = "arn:${data.aws_partition.current.partition}:lambda:${var.aws_region}:${var.aws_account_id}:function:${var.project}-${var.env}-core-migrations"
  core_migrations_deployment_alias_arn = "${local.core_migrations_function_arn}:deployment"
  auth_api_role_arn                    = "${local.iam_account_arn_prefix}:role/gootip/application/${var.project}-auth-${var.env}-lambda"
  core_api_role_arn                    = "${local.iam_account_arn_prefix}:role/gootip/application/${var.project}-core-${var.env}-lambda"
  auth_api_function_arn                = "arn:${data.aws_partition.current.partition}:lambda:${var.aws_region}:${var.aws_account_id}:function:${var.project}-auth-${var.env}"
  core_api_function_arn                = "arn:${data.aws_partition.current.partition}:lambda:${var.aws_region}:${var.aws_account_id}:function:${var.project}-core-${var.env}"
  auth_api_secrets_policy_arn          = "${local.iam_account_arn_prefix}:policy/${var.project}-auth-${var.env}-secrets-read"
  auth_api_logs_policy_arn             = "${local.iam_account_arn_prefix}:policy/${var.project}-auth-${var.env}-logs"
  auth_api_vpc_policy_arn              = "${local.iam_account_arn_prefix}:policy/${var.project}-auth-${var.env}-vpc"
  core_api_secrets_policy_arn          = "${local.iam_account_arn_prefix}:policy/${var.project}-core-${var.env}-secrets-read"
  core_api_logs_policy_arn             = "${local.iam_account_arn_prefix}:policy/${var.project}-core-${var.env}-logs"
  core_api_vpc_policy_arn              = "${local.iam_account_arn_prefix}:policy/${var.project}-core-${var.env}-vpc"
  api_gateway_arn                      = var.api_gateway_id == null ? null : "arn:${data.aws_partition.current.partition}:apigateway:${var.aws_region}::/apis/${var.api_gateway_id}"
  api_gateway_read_arn                 = var.api_gateway_read_id == null ? null : "arn:${data.aws_partition.current.partition}:apigateway:${var.aws_region}::/apis/${var.api_gateway_read_id}"
  auth_api_access_log_group_arn        = "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/apigateway/${var.project}-${var.env}-auth"
  auth_api_lambda_log_group_arn        = "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${var.project}-auth-${var.env}"
  auth_api_log_group_arns = [
    local.auth_api_access_log_group_arn,
    local.auth_api_lambda_log_group_arn,
  ]
  auth_api_log_stream_arns = [
    "${local.auth_api_access_log_group_arn}:log-stream:*",
    "${local.auth_api_lambda_log_group_arn}:log-stream:*",
  ]
  auth_migrations_log_group_arn         = "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${var.project}-${var.env}-auth-migrations"
  core_migrations_log_group_arn         = "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${var.project}-${var.env}-core-migrations"
  application_client_security_group_arn = "arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${var.aws_account_id}:security-group/${var.deployment_application_client_security_group_id}"
  role_secret_arn_pattern               = "arn:${data.aws_partition.current.partition}:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:${var.project}-${var.env}-auth-*"
  role_secret_names                     = ["${var.project}-${var.env}-auth-runtime", "${var.project}-${var.env}-auth-migrator"]
  core_role_secret_names                = ["${var.project}-${var.env}-core-runtime", "${var.project}-${var.env}-core-migrator"]
  core_role_secret_arn_patterns = [
    for name in local.core_role_secret_names : "arn:${data.aws_partition.current.partition}:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:${name}-*"
  ]
  core_role_secret_arns_approved       = var.core_runtime_secret_arn != null && var.core_migrator_secret_arn != null
  core_role_secret_in_scope            = var.core_role_secret_creation_enabled || local.core_role_secret_arns_approved
  database_operator_secret_name        = "${var.project}-${var.env}-db-operator"
  database_operator_secret_arn_pattern = "arn:${data.aws_partition.current.partition}:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:${local.database_operator_secret_name}-*"

  # Reviewed name patterns for the two role-secret containers, used while both
  # exact ARNs are still unapproved. Addressing the containers by pattern keeps
  # the container-metadata statement independent of the containers it authorizes,
  # so the policy update is ordered before the container-creation apply and the
  # AWS provider can read DescribeSecret and GetResourcePolicy immediately after
  # CreateSecret. The approved exact ARNs replace the patterns once supplied.
  role_secret_arn_patterns = [
    for name in local.role_secret_names : "arn:${data.aws_partition.current.partition}:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:${name}-*"
  ]

  # The manual-value expansion on the two role-secret containers is gated by the
  # presence of both reviewed ARNs, not by role_secret_creation_enabled: it stays
  # closed while the temporary CreateSecret grant is active, so the container
  # creation apply never also grants manual value access to what it creates.
  role_secret_arns_approved = var.auth_runtime_secret_arn != null && var.auth_migrator_secret_arn != null

  # The operator container follows the same rule with its own reviewed ARN and
  # its own temporary creation grant, so it never reopens the SPEC 03 role-secret
  # creation phase.
  database_operator_secret_approved = var.db_operator_secret_arn != null

  # The operator secret enters the bootstrap secret policy only while its own
  # phased workflow is active: the reviewed container-creation apply sets the
  # flag, and the reviewed follow-up supplies the ARN. Before that the container
  # and every reference to it are absent, so the SPEC 03.1 transition core (which
  # predates this secret) keeps its reviewed size and the guardrail's transition
  # render never carries this later secret.
  database_operator_secret_in_scope = var.database_operator_secret_creation_enabled || var.db_operator_secret_arn != null

  # The runtime boundary allows and denies secret reads against the same exact
  # ARN set: the application secret, RDS master secret, both role secrets, and
  # the temporary db-config operator secret. Unsupplied ARNs are absent until
  # their reviewed handoff; application and migration identity policies still
  # grant no access to the operator secret.
  runtime_secret_arns = compact([
    var.application_secret_arn,
    var.rds_master_secret_arn,
    var.auth_runtime_secret_arn,
    var.auth_migrator_secret_arn,
    var.core_runtime_secret_arn,
    var.core_migrator_secret_arn,
    var.db_operator_secret_arn,
  ])
}

# SPEC 02.4 raises the shared MFA-age ceiling to three hours (10,800 seconds)
# for both human roles. This bounds the MFA age accepted when a role is assumed;
# it is not a shared credential lifetime. Source-session and assumed-role
# credentials have independent expirations. Both roles keep
# max_session_duration = 3600 because AWS caps a role session assumed by role
# chaining (from the gootip-mfa GetSessionToken source) at one hour.
data "aws_iam_policy_document" "human_role_trust" {
  statement {
    sid     = "AllowOnlySourceUserWithRecentMfa"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = [local.source_user_arn]
    }

    condition {
      test     = "Bool"
      variable = "aws:MultiFactorAuthPresent"
      values   = ["true"]
    }

    condition {
      test     = "NumericLessThanEquals"
      variable = "aws:MultiFactorAuthAge"
      values   = ["10800"]
    }
  }
}

resource "aws_iam_role" "bootstrap_admin" {
  name                 = "GootipBootstrapAdmin"
  path                 = "/gootip/bootstrap/"
  assume_role_policy   = data.aws_iam_policy_document.human_role_trust.json
  max_session_duration = 3600

  tags = {
    Name       = "GootipBootstrapAdmin"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_iam_role" "terraform_deploy" {
  name                 = "GootipTerraformDeploy"
  path                 = "/gootip/deployment/"
  assume_role_policy   = data.aws_iam_policy_document.human_role_trust.json
  max_session_duration = 3600

  tags = {
    Name       = "GootipTerraformDeploy"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

# SPEC 05.1: the interactive database operator uses the same MFA-backed trust
# contract as the other human roles. Its standing AWS permission is the exact
# operator-secret read policy; SPEC 05.2 owns the network-session permissions.
resource "aws_iam_role" "database_operator" {
  name                 = "GootipDatabaseOperator"
  path                 = "/gootip/operations/"
  assume_role_policy   = data.aws_iam_policy_document.human_role_trust.json
  max_session_duration = 3600

  tags = {
    Name       = "GootipDatabaseOperator"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_iam_role" "credential_provisioner" {
  count = var.credential_provisioner_role_enabled ? 1 : 0

  name                 = "GootipCredentialProvisioner"
  path                 = "/gootip/operations/"
  assume_role_policy   = data.aws_iam_policy_document.human_role_trust.json
  max_session_duration = 3600

  tags = {
    Name       = "GootipCredentialProvisioner"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_iam_role" "credential_operator" {
  count = var.credential_operator_role_enabled ? 1 : 0

  name                 = "GootipCredentialOperator"
  path                 = "/gootip/operations/"
  assume_role_policy   = data.aws_iam_policy_document.human_role_trust.json
  max_session_duration = 3600

  tags = {
    Name       = "GootipCredentialOperator"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

data "aws_iam_policy_document" "source_user_assume_only_boundary" {
  statement {
    sid     = "AllowOnlyApprovedHumanRoleAssumptions"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    resources = concat([
      local.bootstrap_role_arn,
      local.deployment_role_arn,
      local.database_operator_role_arn,
      ], var.credential_provisioner_role_enabled ? [local.credential_provisioner_role_arn] : [],
    var.credential_operator_role_enabled ? [local.credential_operator_role_arn] : [])
  }

  statement {
    sid       = "AllowMfaSessionCreation"
    effect    = "Allow"
    actions   = ["sts:GetSessionToken"]
    resources = ["*"]
  }

  statement {
    sid         = "DenyEverythingExceptMfaSessionAndApprovedRoleAssumption"
    effect      = "Deny"
    not_actions = ["sts:AssumeRole", "sts:GetSessionToken"]
    resources   = ["*"]
  }
}

resource "aws_iam_policy" "source_user_assume_only_boundary" {
  name        = "GootipSourceUserAssumeOnlyBoundary"
  path        = "/gootip/bootstrap/"
  description = "Permissions boundary restricting the source user to MFA session creation and approved human-role assumptions."
  policy      = data.aws_iam_policy_document.source_user_assume_only_boundary.json

  tags = {
    Name       = "GootipSourceUserAssumeOnlyBoundary"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

data "aws_iam_policy_document" "source_user_assume_only" {
  statement {
    sid     = "AssumeOnlyApprovedHumanRoles"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    resources = concat([
      local.bootstrap_role_arn,
      local.deployment_role_arn,
      local.database_operator_role_arn,
      ], var.credential_provisioner_role_enabled ? [local.credential_provisioner_role_arn] : [],
    var.credential_operator_role_enabled ? [local.credential_operator_role_arn] : [])
  }
}

resource "aws_iam_policy" "source_user_assume_only" {
  name        = "GootipSourceUserAssumeOnly"
  path        = "/gootip/bootstrap/"
  description = "Identity policy allowing the source user to assume only the Gootip human roles."
  policy      = data.aws_iam_policy_document.source_user_assume_only.json

  tags = {
    Name       = "GootipSourceUserAssumeOnly"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_iam_user_policy_attachment" "source_user_assume_only" {
  count = var.source_user_cutover_enabled ? 1 : 0

  user       = var.source_user_name
  policy_arn = aws_iam_policy.source_user_assume_only.arn
}

# SPEC 05.1: the operator's standing AWS permission starts with the exact
# operator-secret read. SPEC 05.2 adds only the private discovery, start/stop,
# public-key, and one-hour endpoint-tunnel actions required by the helper.
data "aws_iam_policy_document" "database_operator_permissions" {
  dynamic "statement" {
    for_each = var.db_operator_secret_arn == null ? [] : [var.db_operator_secret_arn]

    content {
      sid    = "ReadExactDatabaseOperatorSecret"
      effect = "Allow"
      actions = [
        "secretsmanager:DescribeSecret",
        "secretsmanager:GetSecretValue",
      ]
      resources = [statement.value]
    }
  }

  # Discovery is Region-scoped because these EC2 and Instance Connect read
  # actions have no resource-level authorization scope. The helper still filters
  # the results by the exact ownership and purpose tags before acting.
  statement {
    sid    = "DiscoverTaggedDbTunnelResources"
    effect = "Allow"
    actions = [
      "ec2:DescribeInstanceConnectEndpoints",
      "ec2:DescribeInstances",
      "ec2:DescribeInstanceStatus",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }
  }

  statement {
    sid       = "DescribeExactDevDatabase"
    effect    = "Allow"
    actions   = ["rds:DescribeDBInstances"]
    resources = [local.application_database_arn]
  }

  statement {
    sid       = "StartAndStopTaggedDbTunnelInstance"
    effect    = "Allow"
    actions   = ["ec2:StartInstances", "ec2:StopInstances"]
    resources = ["arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${var.aws_account_id}:instance/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/project"
      values   = [var.project]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/env"
      values   = [var.env]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/purpose"
      values   = ["db-tunnel"]
    }
  }

  statement {
    sid       = "SendPublicKeyToTaggedDbTunnelInstance"
    effect    = "Allow"
    actions   = ["ec2-instance-connect:SendSSHPublicKey"]
    resources = ["arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${var.aws_account_id}:instance/*"]

    condition {
      test     = "StringEquals"
      variable = "ec2:osuser"
      values   = ["ec2-user"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/project"
      values   = [var.project]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/env"
      values   = [var.env]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/purpose"
      values   = ["db-tunnel"]
    }
  }

  statement {
    sid       = "OpenTunnelToTaggedDbTunnelEndpoint"
    effect    = "Allow"
    actions   = ["ec2-instance-connect:OpenTunnel"]
    resources = ["arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${var.aws_account_id}:instance-connect-endpoint/*"]

    condition {
      test     = "NumericEquals"
      variable = "ec2-instance-connect:remotePort"
      values   = ["22"]
    }

    condition {
      test     = "NumericLessThanEquals"
      variable = "ec2-instance-connect:maxTunnelDuration"
      values   = ["3600"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/project"
      values   = [var.project]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/env"
      values   = [var.env]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/purpose"
      values   = ["db-tunnel"]
    }
  }
}

resource "aws_iam_policy" "database_operator_permissions" {
  count = var.db_operator_secret_arn == null ? 0 : 1

  name        = "GootipDatabaseOperatorPermissions"
  path        = "/gootip/operations/"
  description = "Allows the database operator to read only the exact gootip-dev-db-operator secret container."
  policy      = data.aws_iam_policy_document.database_operator_permissions.json

  tags = {
    Name       = "GootipDatabaseOperatorPermissions"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_iam_role_policy_attachment" "database_operator_permissions" {
  count = var.db_operator_secret_arn == null ? 0 : 1

  role       = aws_iam_role.database_operator.name
  policy_arn = aws_iam_policy.database_operator_permissions[0].arn
}

data "aws_iam_policy_document" "credential_provisioner_permissions" {
  count = var.credential_provisioner_role_enabled ? 1 : 0

  statement {
    sid       = "ReadOnlyExactRdsMasterSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]
    resources = [var.rds_master_secret_arn]
  }
}

resource "aws_iam_policy" "credential_provisioner_permissions" {
  count = var.credential_provisioner_role_enabled ? 1 : 0

  name        = "GootipCredentialProvisionerPermissions"
  path        = "/gootip/operations/"
  description = "Allows approved credential provisioning to read only the exact RDS master secret."
  policy      = data.aws_iam_policy_document.credential_provisioner_permissions[0].json

  tags = {
    Name       = "GootipCredentialProvisionerPermissions"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_iam_role_policy_attachment" "credential_provisioner_permissions" {
  count = var.credential_provisioner_role_enabled ? 1 : 0

  role       = aws_iam_role.credential_provisioner[0].name
  policy_arn = aws_iam_policy.credential_provisioner_permissions[0].arn
}

data "aws_iam_policy_document" "credential_operator_permissions" {
  count = var.credential_operator_role_enabled ? 1 : 0

  statement {
    sid    = "OperateOnlyExactRuntimeSecrets"
    effect = "Allow"
    actions = [
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetSecretValue",
      "secretsmanager:PutSecretValue",
    ]
    resources = [var.auth_runtime_secret_arn, var.core_runtime_secret_arn]
  }

  statement {
    sid       = "DescribeExactDevDatabase"
    effect    = "Allow"
    actions   = ["rds:DescribeDBInstances"]
    resources = [local.application_database_arn]
  }
}

resource "aws_iam_policy" "credential_operator_permissions" {
  count = var.credential_operator_role_enabled ? 1 : 0

  name        = "GootipCredentialOperatorPermissions"
  path        = "/gootip/operations/"
  description = "Allows credential transitions on exact Auth and Core secrets and discovery of the exact dev database."
  policy      = data.aws_iam_policy_document.credential_operator_permissions[0].json

  tags = {
    Name       = "GootipCredentialOperatorPermissions"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_iam_role_policy_attachment" "credential_operator_permissions" {
  count = var.credential_operator_role_enabled ? 1 : 0

  role       = aws_iam_role.credential_operator[0].name
  policy_arn = aws_iam_policy.credential_operator_permissions[0].arn
}

data "aws_iam_policy_document" "credential_role_lifecycle" {
  count = var.credential_role_lifecycle_enabled ? 1 : 0
  dynamic "statement" {
    for_each = [1]
    content {
      sid       = "ManageExactCredentialProvisionerRole"
      effect    = "Allow"
      actions   = ["iam:AttachRolePolicy", "iam:CreateRole", "iam:DeleteRole", "iam:DetachRolePolicy", "iam:GetRole", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole", "iam:ListRolePolicies", "iam:TagRole", "iam:UntagRole", "iam:UpdateAssumeRolePolicy", "iam:UpdateRole"]
      resources = [local.credential_provisioner_role_arn]
    }
  }
  dynamic "statement" {
    for_each = [1]
    content {
      sid       = "ManageExactCredentialProvisionerPolicy"
      effect    = "Allow"
      actions   = ["iam:CreatePolicy", "iam:CreatePolicyVersion", "iam:DeletePolicy", "iam:DeletePolicyVersion", "iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyTags", "iam:ListPolicyVersions", "iam:SetDefaultPolicyVersion", "iam:TagPolicy", "iam:UntagPolicy"]
      resources = [local.credential_provisioner_policy_arn]
    }
  }
  dynamic "statement" {
    for_each = [1]
    content {
      sid       = "ManageExactCredentialOperatorRole"
      effect    = "Allow"
      actions   = ["iam:AttachRolePolicy", "iam:CreateRole", "iam:DeleteRole", "iam:DetachRolePolicy", "iam:GetRole", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole", "iam:ListRolePolicies", "iam:TagRole", "iam:UntagRole", "iam:UpdateAssumeRolePolicy", "iam:UpdateRole"]
      resources = [local.credential_operator_role_arn]
    }
  }
  dynamic "statement" {
    for_each = [1]
    content {
      sid       = "ManageExactCredentialOperatorPolicy"
      effect    = "Allow"
      actions   = ["iam:CreatePolicy", "iam:CreatePolicyVersion", "iam:DeletePolicy", "iam:DeletePolicyVersion", "iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyTags", "iam:ListPolicyVersions", "iam:SetDefaultPolicyVersion", "iam:TagPolicy", "iam:UntagPolicy"]
      resources = [local.credential_operator_policy_arn]
    }
  }
}

resource "aws_iam_role_policy" "credential_role_lifecycle" {
  count = var.credential_role_lifecycle_enabled ? 1 : 0

  name   = "GootipCredentialRoleLifecycle"
  role   = aws_iam_role.bootstrap_admin.name
  policy = data.aws_iam_policy_document.credential_role_lifecycle[0].json
}

data "aws_iam_policy_document" "application_runtime_boundary" {
  # This boundary is attached only after the later exact-secret and runtime-role
  # handoff. Until then it blocks every listed escalation and control-plane path.
  statement {
    sid    = "DenyIamAndStsEscalation"
    effect = "Deny"
    actions = [
      "iam:AddUserToGroup",
      "iam:AttachGroupPolicy",
      "iam:AttachRolePolicy",
      "iam:AttachUserPolicy",
      "iam:CreateAccessKey",
      "iam:CreateLoginProfile",
      "iam:CreatePolicyVersion",
      "iam:CreateRole",
      "iam:DeleteGroupPolicy",
      "iam:DeleteRolePolicy",
      "iam:DeleteUserPolicy",
      "iam:PassRole",
      "iam:PutGroupPolicy",
      "iam:PutRolePolicy",
      "iam:PutUserPolicy",
      "iam:RemoveUserFromGroup",
      "iam:SetDefaultPolicyVersion",
      "iam:UpdateAssumeRolePolicy",
      "iam:UpdateRole",
      "sts:AssumeRole",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "DenyHumanAndStateBucketAccess"
    effect = "Deny"
    actions = [
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:ListBucket",
      "s3:ListBucketVersions",
      "s3:PutObject",
    ]
    resources = [
      local.state_bucket_arn,
      "${local.state_bucket_arn}/*",
    ]
  }

  statement {
    sid     = "AllowOnlyApprovedRuntimeLogStreams"
    effect  = "Allow"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = concat([
      "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${var.project}-auth-${var.env}:*",
      "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/lambda_db_config:*",
      "${local.api_observability_log_group_arns[0]}:*",
      "${local.auth_migrations_log_group_arn}:*",
    ], var.core_migrations_log_access_enabled ? ["${local.core_migrations_log_group_arn}:*"] : [])
  }

  # Lambda VPC interface actions do not support resource-level permissions.
  statement {
    sid    = "AllowLambdaVpcInterfaceOperationsInConfiguredRegion"
    effect = "Allow"
    actions = [
      "ec2:AssignPrivateIpAddresses",
      "ec2:CreateNetworkInterface",
      "ec2:DeleteNetworkInterface",
      "ec2:DescribeNetworkInterfaces",
      "ec2:DescribeSubnets",
      "ec2:UnassignPrivateIpAddresses",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }
  }

  # The approved secret set grows to the two role-secret containers once their
  # reviewed ARN handoff completes. Both statements always use the same ARNs so
  # the boundary cannot allow a read it does not also exempt from the deny.
  dynamic "statement" {
    for_each = length(local.runtime_secret_arns) == 0 ? [] : [true]

    content {
      sid       = "AllowOnlyExactRuntimeSecrets"
      effect    = "Allow"
      actions   = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]
      resources = local.runtime_secret_arns
    }
  }

  dynamic "statement" {
    for_each = length(local.runtime_secret_arns) == 0 ? [] : [true]

    content {
      sid           = "DenyEveryOtherSecret"
      effect        = "Deny"
      actions       = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]
      not_resources = local.runtime_secret_arns
    }
  }
}

resource "aws_iam_policy" "application_runtime_boundary" {
  name        = "GootipApplicationRuntimeBoundary"
  path        = "/gootip/bootstrap/"
  description = "Bootstrap-owned maximum-permission boundary for Gootip application runtime roles."
  policy      = data.aws_iam_policy_document.application_runtime_boundary.json

  tags = {
    Name       = "GootipApplicationRuntimeBoundary"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

# SPEC 03.1 splits the SPEC 02.2 foundation expansion, previously merged into
# GootipTerraformDeployPermissions through source_policy_documents, into three
# capability-scoped attached policies. Every statement keeps its exact actions,
# resources, conditions, and Region scoping; only its physical policy changed.
# Each policy is gated by foundation_policy_expansion_enabled, exactly as the
# merged document was.
data "aws_iam_policy_document" "deployment_network_permissions" {
  count = var.foundation_policy_expansion_enabled ? 1 : 0

  # EC2 create APIs cannot name future VPC resources. CreateSubnet,
  # CreateRouteTable, and CreateSecurityGroup also authorize against the parent
  # VPC ARN, where request tags are unavailable. The wildcard is therefore
  # limited to the assigned Region; tagging is authorized separately below.
  statement {
    sid    = "CreateFoundationNetworkResources"
    effect = "Allow"
    actions = [
      "ec2:CreateRouteTable",
      "ec2:CreateSecurityGroup",
      "ec2:CreateSubnet",
      "ec2:CreateVpc",
      "ec2:CreateVpcEndpoint",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }

  }

  statement {
    sid       = "TagFoundationNetworkResources"
    effect    = "Allow"
    actions   = ["ec2:CreateTags"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/project"
      values   = [var.project]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/env"
      values   = [var.env]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/managed_by"
      values   = ["terraform"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["Name", "project", "env", "managed_by", "purpose"]
    }
  }

  # Terraform's provider refresh and network associations have no stable
  # resource ARN before the foundation exists. These actions remain Region-
  # scoped and exclude Internet gateways, NAT, and Logs endpoints.
  statement {
    sid    = "ReadAndAssociateFoundationNetworkResources"
    effect = "Allow"
    actions = [
      "ec2:AssociateRouteTable",
      "ec2:AuthorizeSecurityGroupEgress",
      "ec2:AuthorizeSecurityGroupIngress",
      "ec2:DescribeNetworkAcls",
      "ec2:DescribeNetworkInterfaces",
      "ec2:DescribePrefixLists",
      "ec2:DescribeRouteTables",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeSubnets",
      "ec2:DescribeTags",
      "ec2:DescribeVpcAttribute",
      "ec2:DescribeVpcEndpointServices",
      "ec2:DescribeVpcEndpoints",
      "ec2:DescribeVpcs",
      "ec2:DescribeAvailabilityZones",
      "ec2:ModifyVpcAttribute",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }
  }

  dynamic "statement" {
    for_each = var.secretsmanager_vpc_endpoint_id == null ? [] : [var.secretsmanager_vpc_endpoint_id]

    content {
      sid       = "ModifyExactSecretsManagerVpcEndpointPolicy"
      effect    = "Allow"
      actions   = ["ec2:ModifyVpcEndpoint"]
      resources = ["arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${var.aws_account_id}:vpc-endpoint/${statement.value}"]

      condition {
        test     = "StringEquals"
        variable = "aws:RequestedRegion"
        values   = [var.aws_region]
      }
    }
  }

  # New security groups begin with an AWS-managed default egress rule. Terraform
  # must revoke it for the RDS and endpoint groups; scope the operation to
  # Terraform-managed Gootip security groups only.
  statement {
    sid       = "RevokeEgressOnlyFromTaggedFoundationSecurityGroups"
    effect    = "Allow"
    actions   = ["ec2:RevokeSecurityGroupEgress"]
    resources = ["arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${var.aws_account_id}:security-group/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/project"
      values   = [var.project]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/env"
      values   = [var.env]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/managed_by"
      values   = ["terraform"]
    }
  }

  statement {
    sid    = "RevokeIngressAndDeleteTaggedFoundationSecurityGroups"
    effect = "Allow"
    actions = [
      "ec2:DeleteSecurityGroup",
      "ec2:RevokeSecurityGroupIngress",
    ]
    resources = ["arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${var.aws_account_id}:security-group/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/project"
      values   = [var.project]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/env"
      values   = [var.env]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/managed_by"
      values   = ["terraform"]
    }
  }

  dynamic "statement" {
    for_each = length(var.db_config_network_interface_arns) == 0 ? [] : [true]

    content {
      sid       = "DeleteExactDbConfigNetworkInterfaces"
      effect    = "Allow"
      actions   = ["ec2:DeleteNetworkInterface"]
      resources = var.db_config_network_interface_arns
    }
  }

  # SPEC 05.2: create the tunnel host only in the reviewed private subnet and
  # only with the reviewed request tags. RunInstances authorizes separately
  # against the instance and its root volume; EC2 also checks the image, subnet,
  # network interface, and security group used by the launch.
  #
  # The launched instance and its root volume must carry every reviewed request
  # tag. RunInstances authorizes against both resources.
  statement {
    sid     = "RunTaggedDbTunnelInstance"
    effect  = "Allow"
    actions = ["ec2:RunInstances"]
    resources = [
      "arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${var.aws_account_id}:instance/*",
      "arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${var.aws_account_id}:volume/*",
    ]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/project"
      values   = [var.project]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/env"
      values   = [var.env]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/managed_by"
      values   = ["terraform"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/purpose"
      values   = ["db-tunnel"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["Name", "project", "env", "managed_by", "purpose"]
    }

    condition {
      test     = "Null"
      variable = "aws:TagKeys"
      values   = ["false"]
    }
  }

  # The image, exact private subnet, and new network interface are fixed
  # infrastructure resources. The subnet condition prevents a launch or an
  # endpoint in any other subnet.
  statement {
    sid    = "CreateDbTunnelInfrastructure"
    effect = "Allow"
    actions = [
      "ec2:CreateInstanceConnectEndpoint",
      "ec2:RunInstances",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}::image/${var.deployment_db_tunnel_ami_id}",
      "arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${var.aws_account_id}:subnet/${var.deployment_db_tunnel_subnet_id}",
      "arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${var.aws_account_id}:network-interface/*",
      "arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${var.aws_account_id}:instance-connect-endpoint/*",
    ]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }

    condition {
      test     = "ArnEqualsIfExists"
      variable = "ec2:Subnet"
      values   = ["arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${var.aws_account_id}:subnet/${var.deployment_db_tunnel_subnet_id}"]
    }
  }

  # RunInstances, endpoint creation, and endpoint ENI creation authorize against
  # the two reviewed tunnel security groups, identified by exact Name and
  # ownership tags.
  statement {
    sid    = "UseDbTunnelSecurityGroups"
    effect = "Allow"
    actions = [
      "ec2:CreateInstanceConnectEndpoint",
      "ec2:CreateNetworkInterface",
      "ec2:RunInstances",
    ]
    resources = ["arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${var.aws_account_id}:security-group/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/project"
      values   = [var.project]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/env"
      values   = [var.env]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/managed_by"
      values   = ["terraform"]
    }

    condition {
      test     = "ForAnyValue:StringEquals"
      variable = "aws:ResourceTag/Name"
      values = [
        "${var.project}-${var.env}-db-eice",
        "${var.project}-${var.env}-db-tunnel",
      ]
    }
  }

  # The endpoint service tags its network interface during creation with
  # service-controlled keys. Scope the permission to endpoint ENIs in this
  # Region and require at least one tag key.
  statement {
    sid       = "TagDbTunnelEndpointNetworkInterfaces"
    effect    = "Allow"
    actions   = ["ec2:CreateTags"]
    resources = ["arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${var.aws_account_id}:network-interface/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }

    condition {
      test     = "Null"
      variable = "aws:TagKeys"
      values   = ["false"]
    }
  }

  # EC2 Instance Connect Endpoint creates its network interfaces in the selected
  # private subnet. The action is limited to this account and Region and cannot
  # reach a network interface outside the reviewed VPC topology.
  statement {
    sid     = "CreateDbTunnelEndpointNetworkInterfaces"
    effect  = "Allow"
    actions = ["ec2:CreateNetworkInterface"]
    resources = [
      "arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${var.aws_account_id}:network-interface/*",
      "arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${var.aws_account_id}:subnet/*",
    ]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }
  }

  # Provider refresh and post-create reconciliation reads. These actions have no
  # resource-level scope, so the Region condition is the boundary.
  statement {
    sid    = "ReadDbTunnelResources"
    effect = "Allow"
    actions = [
      "ec2:DescribeImages",
      "ec2:DescribeInstanceAttribute",
      "ec2:DescribeInstanceConnectEndpoints",
      "ec2:DescribeInstanceCreditSpecifications",
      "ec2:DescribeInstanceStatus",
      "ec2:DescribeInstanceTypes",
      "ec2:DescribeInstances",
      "ec2:DescribeSecurityGroupRules",
      "ec2:DescribeVolumes",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }
  }

  # Start, stop, update, and terminate only the tagged tunnel instance.
  statement {
    sid    = "ManageTaggedDbTunnelResources"
    effect = "Allow"
    actions = [
      "ec2:ModifyInstanceAttribute",
      "ec2:ModifyInstanceMetadataOptions",
      "ec2:StartInstances",
      "ec2:StopInstances",
      "ec2:TerminateInstances",
    ]
    resources = ["arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${var.aws_account_id}:instance/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/project"
      values   = [var.project]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/env"
      values   = [var.env]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/managed_by"
      values   = ["terraform"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/purpose"
      values   = ["db-tunnel"]
    }
  }

  # Update and delete only the tagged Instance Connect Endpoint.
  statement {
    sid    = "ManageTaggedDbTunnelEndpoint"
    effect = "Allow"
    actions = [
      "ec2:DeleteInstanceConnectEndpoint",
      "ec2:ModifyInstanceConnectEndpoint",
    ]
    resources = ["arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${var.aws_account_id}:instance-connect-endpoint/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/project"
      values   = [var.project]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/env"
      values   = [var.env]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/managed_by"
      values   = ["terraform"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/purpose"
      values   = ["db-tunnel"]
    }
  }
}

data "aws_iam_policy_document" "deployment_database_permissions" {
  count = var.foundation_policy_expansion_enabled ? 1 : 0

  # Account attributes expose the Free Plan's effective RDS limits without
  # reading credentials, database content, or a secret value.
  statement {
    sid       = "ReadFoundationRdsAccountAttributes"
    effect    = "Allow"
    actions   = ["rds:DescribeAccountAttributes"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }
  }

  # RDS creates the exact foundation DB, parameter group, and subnet group.
  # No role, replica, restore, secret-value, or tenant-database operation is
  # authorized by this expansion.
  statement {
    sid    = "CreateProtectedFoundationRdsResources"
    effect = "Allow"
    actions = [
      "rds:CreateDBInstance",
      "rds:CreateDBParameterGroup",
      "rds:CreateDBSubnetGroup",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }
  }

  statement {
    sid    = "ConfigureAndReadExactFoundationRdsResources"
    effect = "Allow"
    actions = [
      "rds:AddTagsToResource",
      "rds:DescribeDBInstances",
      "rds:DescribeDBParameterGroups",
      "rds:DescribeDBParameters",
      "rds:DescribeDBSubnetGroups",
      "rds:ListTagsForResource",
      "rds:ModifyDBParameterGroup",
    ]
    resources = [
      local.application_database_arn,
      local.foundation_parameter_group_arn,
      local.postgres18_parameter_group_arn,
      local.foundation_subnet_group_arn,
    ]
  }

  # The RDS authorization reference has no resource type for these two actions.
  statement {
    sid    = "AllowRdsEngineAndOrderableDiscovery"
    effect = "Allow"
    actions = [
      "rds:DescribeDBEngineVersions",
      "rds:DescribeOrderableDBInstanceOptions",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }
  }

  statement {
    sid       = "DiscoverGootipRdsInstancesInRegion"
    effect    = "Allow"
    actions   = ["rds:DescribeDBInstances"]
    resources = [local.application_database_arn_pattern]
  }

  # SPEC 12: the PostgreSQL 18 change modifies only this instance in place.
  statement {
    sid     = "ModifyExactGootipRdsInstanceForUpgrade"
    effect  = "Allow"
    actions = ["rds:ModifyDBInstance"]
    resources = [
      local.application_database_arn,
      local.postgres18_parameter_group_arn,
    ]
  }

  statement {
    sid       = "CreateExactGootipPreUpgradeSnapshot"
    effect    = "Allow"
    actions   = ["rds:CreateDBSnapshot"]
    resources = [local.application_database_arn, local.pre_upgrade_snapshot_arn]
  }

  statement {
    sid       = "DeleteExactPostgres17ParameterGroup"
    effect    = "Allow"
    actions   = ["rds:DeleteDBParameterGroup"]
    resources = [local.foundation_parameter_group_arn]
  }

  # DescribeDBSnapshots has no resource-level authorization; keep it
  # metadata-only and Region-bound.
  statement {
    sid       = "ReadUpgradeRdsSnapshotMetadataInRegion"
    effect    = "Allow"
    actions   = ["rds:DescribeDBSnapshots"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }
  }

  # The upgrade stop conditions require reading pending maintenance actions;
  # this discovery API is metadata-only and Region-bound.
  statement {
    sid       = "ReadUpgradeRdsPendingMaintenanceInRegion"
    effect    = "Allow"
    actions   = ["rds:DescribePendingMaintenanceActions"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }
  }

  # RDS validates the AWS-managed Secrets Manager key before creating its
  # managed master secret. CloudTrail identified this exact read as the only
  # denied KMS operation after the RDS-key grant succeeded.
  statement {
    sid       = "DescribeExactSecretsManagerManagedKmsKey"
    effect    = "Allow"
    actions   = ["kms:DescribeKey"]
    resources = [var.secrets_manager_kms_key_arn]
  }

  # AWS requires the caller to create and tag the generated RDS-managed master
  # secret. The future secret identifier is not known before DB creation, so
  # both actions are limited to RDS DB secret names in this account and Region.
  statement {
    sid       = "CreateOnlyRdsManagedMasterSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:CreateSecret"]
    resources = [local.rds_managed_secret_arn_pattern]

    condition {
      test     = "StringLike"
      variable = "secretsmanager:Name"
      values   = ["rds!db-*"]
    }
  }

  statement {
    sid       = "TagOnlyRdsManagedMasterSecrets"
    effect    = "Allow"
    actions   = ["secretsmanager:TagResource"]
    resources = [local.rds_managed_secret_arn_pattern]
  }
}

data "aws_iam_policy_document" "deployment_foundation_read_permissions" {
  count = var.foundation_policy_expansion_enabled ? 1 : 0

  # Standard CloudWatch metrics are not scoped to alarm or RDS resource ARNs.
  statement {
    sid       = "ReadCloudWatchMetricDataInRegion"
    effect    = "Allow"
    actions   = ["cloudwatch:GetMetricData"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }
  }

  # The layer name is fixed by the foundation contract. Publishing creates a
  # version under that name; version reads are limited to its version suffix.
  statement {
    sid       = "PublishExactRdsCaLayer"
    effect    = "Allow"
    actions   = ["lambda:PublishLayerVersion"]
    resources = [local.foundation_layer_arn]
  }

  statement {
    sid       = "ReadExactRdsCaLayerVersions"
    effect    = "Allow"
    actions   = ["lambda:GetLayerVersion"]
    resources = ["${local.foundation_layer_arn}:*"]
  }

  # Service Quotas has no resource-level scope for this read-only inventory
  # action. It is required by the SPEC 02.2 pre-apply quota gate.
  statement {
    sid       = "ReadFoundationServiceQuotas"
    effect    = "Allow"
    actions   = ["servicequotas:ListServiceQuotas"]
    resources = ["*"]
  }

  # AWS Free Tier read actions do not support resource-level permissions or
  # service-specific condition keys. They are required for the foundation
  # eligibility gate and deliberately exclude every mutation action, including
  # freetier:UpgradeAccountPlan.
  statement {
    sid    = "ReadFreeTierEligibilityAndUsage"
    effect = "Allow"
    actions = [
      "freetier:GetAccountPlanState",
      "freetier:GetFreeTierUsage",
    ]
    resources = ["*"]
  }
}

data "aws_iam_policy_document" "deployment_permissions" {
  source_policy_documents = var.foundation_policy_expansion_enabled ? [data.aws_iam_policy_document.deployment_foundation_read_permissions[0].json] : []

  statement {
    sid       = "AllowApplicationStateOnly"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [local.state_bucket_arn]

    condition {
      test     = "StringEquals"
      variable = "s3:prefix"
      values   = [local.application_state_key, local.application_lock_key]
    }

    condition {
      test     = "StringEquals"
      variable = "s3:ResourceAccount"
      values   = [var.aws_account_id]
    }
  }

  # GetBucketLocation does not include the s3:prefix request context used for
  # state listing, so it remains a separate exact-bucket read.
  statement {
    sid       = "ReadApplicationStateBucketRegion"
    effect    = "Allow"
    actions   = ["s3:GetBucketLocation"]
    resources = [local.state_bucket_arn]

    condition {
      test     = "StringEquals"
      variable = "s3:ResourceAccount"
      values   = [var.aws_account_id]
    }
  }

  statement {
    sid     = "AllowApplicationStateReadWrite"
    effect  = "Allow"
    actions = ["s3:GetObject", "s3:PutObject"]
    resources = [
      local.application_state_object_arn,
    ]

    condition {
      test     = "StringEquals"
      variable = "s3:ResourceAccount"
      values   = [var.aws_account_id]
    }
  }

  statement {
    sid     = "AllowApplicationLockOnly"
    effect  = "Allow"
    actions = ["s3:DeleteObject", "s3:GetObject", "s3:PutObject"]
    resources = [
      local.application_lock_object_arn,
    ]

    condition {
      test     = "StringEquals"
      variable = "s3:ResourceAccount"
      values   = [var.aws_account_id]
    }
  }

  statement {
    sid    = "DenySecretsManagerMutationAndValues"
    effect = "Deny"
    actions = [
      "secretsmanager:BatchGetSecretValue",
      "secretsmanager:CancelRotateSecret",
      "secretsmanager:DescribeSecret",
      "secretsmanager:DeleteResourcePolicy",
      "secretsmanager:DeleteSecret",
      "secretsmanager:GetResourcePolicy",
      "secretsmanager:GetSecretValue",
      "secretsmanager:PutResourcePolicy",
      "secretsmanager:PutSecretValue",
      "secretsmanager:RemoveRegionsFromReplication",
      "secretsmanager:ReplicateSecretToRegions",
      "secretsmanager:RestoreSecret",
      "secretsmanager:RotateSecret",
      "secretsmanager:UntagResource",
      "secretsmanager:UpdateSecret",
      "secretsmanager:UpdateSecretVersionStage",
    ]
    resources = ["*"]
  }

  # RDS creates and tags its own managed master secret during CreateDBInstance,
  # so those two actions cannot be denied outright. They stay denied for every
  # secret except the RDS-managed DB secret pattern in this account and Region,
  # which keeps secret-value access and every other secret out of reach.
  statement {
    sid    = "DenyNonRdsSecretsManagerCreateAndTag"
    effect = "Deny"
    actions = [
      "secretsmanager:CreateSecret",
      "secretsmanager:TagResource",
    ]
    not_resources = [local.rds_managed_secret_arn_pattern]
  }

  # The SPEC 03 PassRole expansion lives in its own attached policy
  # (GootipTerraformDeployAdministrativePassRole) because this document is
  # already close to the 6144-character managed-policy limit. Secret-container
  # and secret-value management remain denied above.
}

resource "aws_iam_policy" "deployment_permissions" {
  name        = "GootipTerraformDeployPermissions"
  path        = "/gootip/deployment/"
  description = "Bootstrap-owned explicit baseline permissions for the Gootip deployment role."
  policy      = data.aws_iam_policy_document.deployment_permissions.json

  tags = {
    Name       = "GootipTerraformDeployPermissions"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_iam_role_policy_attachment" "deployment_permissions" {
  role       = aws_iam_role.terraform_deploy.name
  policy_arn = aws_iam_policy.deployment_permissions.arn
}

# SPEC 03 and SPEC 04 expand the SPEC 02.1 PassRole allowlist by exact execution
# roles only. It stays limited to the
# Lambda service and grants no Lambda CRUD, which SPEC 07 owns. It is a separate
# attached policy because GootipTerraformDeployPermissions is already close to the
# 6144-character managed-policy limit and must not absorb new grants, and an
# inline policy is not an accepted overflow mechanism.
# SPEC 02.1 approves this exact-role, Lambda-only PassRole grant.
#trivy:ignore:AVD-AWS-0342
data "aws_iam_policy_document" "deployment_administrative_pass_role" {
  statement {
    sid     = "PassExactPrivateFunctionRoles"
    effect  = "Allow"
    actions = ["iam:PassRole"]
    resources = [
      local.administrative_role_arn,
      local.auth_migrations_role_arn,
      local.core_migrations_role_arn,
      local.auth_api_role_arn,
      local.core_api_role_arn,
    ]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_policy" "deployment_administrative_pass_role" {
  name        = "GootipTerraformDeployAdministrativePassRole"
  path        = "/gootip/deployment/"
  description = "Bootstrap-owned PassRole allowlist for the Gootip deployment role."
  policy      = data.aws_iam_policy_document.deployment_administrative_pass_role.json

  tags = {
    Name       = "GootipTerraformDeployAdministrativePassRole"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }

  # Creating this policy is authorized by the bootstrap admin policy itself, so
  # that update must be applied first. IAM authorization propagation can still
  # lag, which is why the operator procedure in README.md applies the bootstrap
  # permissions update as its own reviewed step before this resource.
  depends_on = [aws_iam_policy.bootstrap_permissions]
}

resource "aws_iam_role_policy_attachment" "deployment_administrative_pass_role" {
  role       = aws_iam_role.terraform_deploy.name
  policy_arn = aws_iam_policy.deployment_administrative_pass_role.arn
}

# SPEC 04 deployment capability for the private migration runner. Every mutable
# IAM, Lambda, Logs, and invocation resource is named exactly; networking stays
# in the already-reviewed foundation network capability.
data "aws_iam_policy_document" "deployment_auth_migrations_permissions" {
  statement {
    sid       = "CreateExactAuthMigrationsRole"
    effect    = "Allow"
    actions   = ["iam:CreateRole"]
    resources = [local.auth_migrations_role_arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.runtime_boundary_arn]
    }

  }

  statement {
    sid       = "ReadAndTagExactAuthMigrationsRole"
    effect    = "Allow"
    actions   = ["iam:GetRole", "iam:ListAttachedRolePolicies", "iam:ListRolePolicies", "iam:TagRole"]
    resources = [local.auth_migrations_role_arn]
  }

  statement {
    sid       = "CreateReadAndTagExactAuthMigrationsSecretsPolicy"
    effect    = "Allow"
    actions   = ["iam:CreatePolicy", "iam:GetPolicy", "iam:GetPolicyVersion", "iam:TagPolicy"]
    resources = [local.auth_migrations_secrets_policy_arn]
  }

  statement {
    sid    = "ManageExactAuthMigrationsHardeningPolicies"
    effect = "Allow"
    actions = [
      "iam:CreatePolicy",
      "iam:CreatePolicyVersion",
      "iam:DeletePolicyVersion",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListPolicyTags",
      "iam:ListPolicyVersions",
      "iam:SetDefaultPolicyVersion",
      "iam:TagPolicy",
      "iam:UntagPolicy",
    ]
    resources = [local.auth_migrations_logs_policy_arn, local.auth_migrations_vpc_policy_arn]
  }

  statement {
    sid       = "AttachOnlyReviewedAuthMigrationsPolicies"
    effect    = "Allow"
    actions   = ["iam:AttachRolePolicy"]
    resources = [local.auth_migrations_role_arn]

    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values = [
        "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
        local.auth_migrations_secrets_policy_arn,
        local.auth_migrations_logs_policy_arn,
        local.auth_migrations_vpc_policy_arn,
      ]
    }
  }

  statement {
    sid       = "DetachOnlyTransitionAuthMigrationsPolicies"
    effect    = "Allow"
    actions   = ["iam:DetachRolePolicy"]
    resources = [local.auth_migrations_role_arn]

    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values = [
        "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
      ]
    }
  }

  statement {
    sid       = "ManageExactAuthMigrationsFunction"
    effect    = "Allow"
    actions   = ["lambda:CreateFunction", "lambda:GetFunction", "lambda:GetFunctionCodeSigningConfig", "lambda:ListVersionsByFunction", "lambda:PublishVersion", "lambda:TagResource", "lambda:UpdateFunctionCode"]
    resources = [local.auth_migrations_function_arn]
  }

  statement {
    sid       = "ReadExactAuthMigrationsVersions"
    effect    = "Allow"
    actions   = ["lambda:GetFunctionConfiguration"]
    resources = ["${local.auth_migrations_function_arn}:*"]
  }

  statement {
    sid       = "CreateExactAuthMigrationsAliases"
    effect    = "Allow"
    actions   = ["lambda:CreateAlias"]
    resources = [local.auth_migrations_function_arn]
  }

  statement {
    sid       = "ManageExactAuthMigrationsAliases"
    effect    = "Allow"
    actions   = ["lambda:GetAlias", "lambda:UpdateAlias"]
    resources = [local.auth_migrations_function_arn]
  }

  # shortcut: CloudWatch Logs does not propagate request tags to its composed
  # CreateLogGroup/TagResource authorization. Before staging/production, remove
  # these wildcard creation/tagging statements after all log groups exist.
  statement {
    sid       = "CreateTaggedAuthMigrationsLogGroup"
    effect    = "Allow"
    actions   = ["logs:CreateLogGroup"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Name"
      values   = ["${var.project}-${var.env}-auth-migrations"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/project"
      values   = [var.project]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/env"
      values   = [var.env]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/managed_by"
      values   = ["terraform"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["Name", "project", "env", "managed_by"]
    }

    condition {
      test     = "Null"
      variable = "aws:TagKeys"
      values   = ["false"]
    }
  }

  statement {
    sid       = "ManageDevLogTags"
    effect    = "Allow"
    actions   = ["logs:TagResource", "logs:UntagResource"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }
  }

  statement {
    sid       = "DescribeDevLogGroups"
    effect    = "Allow"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }
  }

  statement {
    sid       = "ManageExactAuthMigrationsLogGroup"
    effect    = "Allow"
    actions   = ["logs:FilterLogEvents", "logs:ListTagsForResource", "logs:PutRetentionPolicy", "logs:TagResource", "logs:UntagResource"]
    resources = [local.auth_migrations_log_group_arn]
  }

  statement {
    sid       = "InvokeExactAuthMigrationsDeploymentAlias"
    effect    = "Allow"
    actions   = ["lambda:InvokeFunction"]
    resources = [local.auth_migrations_deployment_alias_arn]
  }

  statement {
    sid       = "UpdateExactApplicationClientEgressDescription"
    effect    = "Allow"
    actions   = ["ec2:UpdateSecurityGroupRuleDescriptionsEgress"]
    resources = [local.application_client_security_group_arn]

    condition {
      test     = "StringEquals"
      variable = "ec2:Region"
      values   = [var.aws_region]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/project"
      values   = [var.project]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/env"
      values   = [var.env]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/managed_by"
      values   = ["terraform"]
    }
  }
}

resource "aws_iam_policy" "deployment_auth_migrations_permissions" {
  name        = "GootipTerraformDeployAuthMigrationsPermissions"
  path        = "/gootip/deployment/"
  description = "Bootstrap-managed least-privilege deployment capability for the private auth migration runner."
  policy      = data.aws_iam_policy_document.deployment_auth_migrations_permissions.json

  tags = {
    Name       = "GootipTerraformDeployAuthMigrationsPermissions"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_iam_role_policy_attachment" "deployment_auth_migrations_permissions" {
  role       = aws_iam_role.terraform_deploy.name
  policy_arn = aws_iam_policy.deployment_auth_migrations_permissions.arn
}

# SPEC 06 deployment capability for the private Core migration runner. Network
# permissions remain in the separate, reviewed foundation network policy.
data "aws_iam_policy_document" "deployment_core_migrations_permissions" {
  statement {
    sid       = "CreateExactCoreMigrationsRole"
    effect    = "Allow"
    actions   = ["iam:CreateRole"]
    resources = [local.core_migrations_role_arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.runtime_boundary_arn]
    }
  }

  statement {
    sid       = "ReadAndTagExactCoreMigrationsRole"
    effect    = "Allow"
    actions   = ["iam:GetRole", "iam:ListAttachedRolePolicies", "iam:ListRolePolicies", "iam:TagRole"]
    resources = [local.core_migrations_role_arn]
  }

  statement {
    sid    = "ManageExactCoreMigrationsSecretsPolicy"
    effect = "Allow"
    actions = [
      "iam:CreatePolicy",
      "iam:CreatePolicyVersion",
      "iam:DeletePolicyVersion",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListPolicyVersions",
      "iam:ListPolicyTags",
      "iam:SetDefaultPolicyVersion",
      "iam:TagPolicy",
      "iam:UntagPolicy",
    ]
    resources = [local.core_migrations_secrets_policy_arn]
  }

  statement {
    sid    = "ManageExactCoreMigrationsHardeningPolicies"
    effect = "Allow"
    actions = [
      "iam:CreatePolicy",
      "iam:CreatePolicyVersion",
      "iam:DeletePolicyVersion",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListPolicyTags",
      "iam:ListPolicyVersions",
      "iam:SetDefaultPolicyVersion",
      "iam:TagPolicy",
      "iam:UntagPolicy",
    ]
    resources = [local.core_migrations_logs_policy_arn, local.core_migrations_vpc_policy_arn]
  }

  statement {
    sid       = "AttachOnlyReviewedCoreMigrationsPolicies"
    effect    = "Allow"
    actions   = ["iam:AttachRolePolicy"]
    resources = [local.core_migrations_role_arn]

    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values = [
        "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
        local.core_migrations_secrets_policy_arn,
        local.core_migrations_logs_policy_arn,
        local.core_migrations_vpc_policy_arn,
      ]
    }
  }

  statement {
    sid       = "DetachOnlyTransitionCoreMigrationsPolicies"
    effect    = "Allow"
    actions   = ["iam:DetachRolePolicy"]
    resources = [local.core_migrations_role_arn]

    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values = [
        "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
      ]
    }
  }

  statement {
    sid    = "ManageExactCoreMigrationsFunction"
    effect = "Allow"
    actions = [
      "lambda:CreateFunction",
      "lambda:GetFunction",
      "lambda:GetFunctionConfiguration",
      "lambda:GetFunctionCodeSigningConfig",
      "lambda:GetFunctionConcurrency",
      "lambda:ListTags",
      "lambda:ListVersionsByFunction",
      "lambda:PublishVersion",
      "lambda:PutFunctionConcurrency",
      "lambda:TagResource",
      "lambda:UpdateFunctionCode",
      "lambda:UpdateFunctionConfiguration",
    ]
    resources = [local.core_migrations_function_arn]
  }

  statement {
    sid       = "ReadExactCoreMigrationsVersions"
    effect    = "Allow"
    actions   = ["lambda:GetFunctionConfiguration"]
    resources = ["${local.core_migrations_function_arn}:*"]
  }

  statement {
    sid       = "ReadExactRdsCaLayerVersionsForCoreMigrations"
    effect    = "Allow"
    actions   = ["lambda:GetLayerVersion"]
    resources = ["${local.foundation_layer_arn}:*"]
  }

  statement {
    sid       = "CreateExactCoreMigrationsAlias"
    effect    = "Allow"
    actions   = ["lambda:CreateAlias"]
    resources = [local.core_migrations_function_arn]
  }

  statement {
    sid       = "ManageExactCoreMigrationsAlias"
    effect    = "Allow"
    actions   = ["lambda:GetAlias", "lambda:UpdateAlias"]
    resources = [local.core_migrations_function_arn]
  }

  # CloudWatch Logs requires a wildcard only for creation; exact tag constraints
  # and the configured Region keep the exception limited to this log group.
  statement {
    sid       = "CreateTaggedCoreMigrationsLogGroup"
    effect    = "Allow"
    actions   = ["logs:CreateLogGroup"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Name"
      values   = ["${var.project}-${var.env}-core-migrations"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/project"
      values   = [var.project]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/env"
      values   = [var.env]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/managed_by"
      values   = ["terraform"]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["Name", "project", "env", "managed_by"]
    }
    condition {
      test     = "Null"
      variable = "aws:TagKeys"
      values   = ["false"]
    }
  }

  statement {
    sid       = "DescribeCoreMigrationsLogGroupsInRegion"
    effect    = "Allow"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }
  }

  statement {
    sid    = "ManageExactCoreMigrationsLogGroup"
    effect = "Allow"
    actions = [
      "logs:FilterLogEvents",
      "logs:ListTagsForResource",
      "logs:PutRetentionPolicy",
      "logs:TagResource",
      "logs:UntagResource",
    ]
    resources = [local.core_migrations_log_group_arn]
  }

  statement {
    sid       = "InvokeExactCoreMigrationsDeploymentAlias"
    effect    = "Allow"
    actions   = ["lambda:InvokeFunction"]
    resources = [local.core_migrations_deployment_alias_arn]
  }
}

resource "aws_iam_policy" "deployment_core_migrations_permissions" {
  name        = "GootipTerraformDeployCoreMigrationsPermissions"
  path        = "/gootip/deployment/"
  description = "Bootstrap-managed least-privilege deployment capability for the private Core migration runner."
  policy      = data.aws_iam_policy_document.deployment_core_migrations_permissions.json

  tags = {
    Name       = "GootipTerraformDeployCoreMigrationsPermissions"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }

  depends_on = [aws_iam_policy.bootstrap_policy_admin_permissions]
}

resource "aws_iam_role_policy_attachment" "deployment_core_migrations_permissions" {
  role       = aws_iam_role.terraform_deploy.name
  policy_arn = aws_iam_policy.deployment_core_migrations_permissions.arn
}

# SPEC 10 deployment capability for the independent Auth and Core API roles and
# functions. API Gateway source grants stay closed until the exact prepared API ID
# is supplied to the bootstrap root.
data "aws_iam_policy_document" "deployment_application_permissions" {
  source_policy_documents = [data.aws_iam_policy_document.deployment_api_observability_permissions.json]
  statement {
    sid       = "CreateExactApiRoles"
    effect    = "Allow"
    actions   = ["iam:CreateRole"]
    resources = [local.auth_api_role_arn, local.core_api_role_arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.runtime_boundary_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Name"
      values   = ["${var.project}-auth-${var.env}-lambda", "${var.project}-core-${var.env}-lambda"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/project"
      values   = [var.project]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/env"
      values   = [var.env]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/managed_by"
      values   = ["terraform"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["Name", "project", "env", "managed_by"]
    }

    condition {
      test     = "Null"
      variable = "aws:TagKeys"
      values   = ["false"]
    }
  }

  statement {
    sid    = "ManageApiRoles"
    effect = "Allow"
    actions = [
      "iam:GetRole",
      "iam:ListAttachedRolePolicies",
      "iam:ListRolePolicies",
      "iam:TagRole",
    ]
    resources = [local.auth_api_role_arn, local.core_api_role_arn]
  }

  statement {
    sid    = "ManageApiPolicies"
    effect = "Allow"
    actions = [
      "iam:CreatePolicy",
      "iam:CreatePolicyVersion",
      "iam:DeletePolicyVersion",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListPolicyTags",
      "iam:ListPolicyVersions",
      "iam:SetDefaultPolicyVersion",
      "iam:TagPolicy",
      "iam:UntagPolicy",
    ]
    resources = [
      local.auth_api_secrets_policy_arn,
      local.auth_api_logs_policy_arn,
      local.auth_api_vpc_policy_arn,
      local.core_api_secrets_policy_arn,
      local.core_api_logs_policy_arn,
      local.core_api_vpc_policy_arn,
    ]
  }

  statement {
    sid       = "AttachOnlyReviewedApplicationRuntimePolicies"
    effect    = "Allow"
    actions   = ["iam:AttachRolePolicy"]
    resources = [local.auth_api_role_arn, local.core_api_role_arn]

    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values = [
        local.auth_api_secrets_policy_arn,
        local.auth_api_logs_policy_arn,
        local.auth_api_vpc_policy_arn,
        local.core_api_secrets_policy_arn,
        local.core_api_logs_policy_arn,
        local.core_api_vpc_policy_arn,
      ]
    }
  }

  statement {
    sid       = "ManageApiFunctions"
    effect    = "Allow"
    actions   = ["lambda:CreateFunction", "lambda:GetFunction", "lambda:GetFunctionCodeSigningConfig", "lambda:GetFunctionConcurrency", "lambda:GetFunctionConfiguration", "lambda:GetLayerVersion", "lambda:ListTags", "lambda:PutFunctionConcurrency", "lambda:TagResource", "lambda:UntagResource", "lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration"]
    resources = [local.auth_api_function_arn, local.core_api_function_arn, "${local.foundation_layer_arn}:*"]
  }

  statement {
    sid       = "ReadApiFunctionPolicies"
    effect    = "Allow"
    actions   = ["lambda:GetPolicy"]
    resources = [local.auth_api_function_arn, local.core_api_function_arn]
  }

  statement {
    sid       = "ReadExactApiFunctionVersions"
    effect    = "Allow"
    actions   = ["lambda:ListVersionsByFunction"]
    resources = [local.auth_api_function_arn, local.core_api_function_arn]
  }

  statement {
    sid       = "ReadAuthMigrationAlias"
    effect    = "Allow"
    actions   = ["lambda:GetAlias"]
    resources = [local.auth_migrations_deployment_alias_arn]
  }

  dynamic "statement" {
    for_each = var.api_gateway_id == null ? [] : [true]

    content {
      sid       = "ManageOnlyPreparedApiRoutePermissions"
      effect    = "Allow"
      actions   = ["lambda:AddPermission"]
      resources = [local.auth_api_function_arn]

      condition {
        test     = "StringEquals"
        variable = "lambda:Principal"
        values   = ["apigateway.amazonaws.com"]
      }
    }
  }

}

resource "aws_iam_policy" "deployment_application_permissions" {
  name        = "GootipTerraformDeployApplicationPermissions"
  path        = "/gootip/deployment/"
  description = "Bootstrap-managed exact Auth and Core API deployment capability."
  policy      = data.aws_iam_policy_document.deployment_application_permissions.json

  tags = {
    Name       = "GootipTerraformDeployApplicationPermissions"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }

  depends_on = [aws_iam_policy.bootstrap_policy_admin_permissions]
}

resource "aws_iam_role_policy_attachment" "deployment_application_permissions" {
  role       = aws_iam_role.terraform_deploy.name
  policy_arn = aws_iam_policy.deployment_application_permissions.arn
}

data "aws_iam_policy_document" "deployment_api_gateway_permissions" {
  statement {
    sid       = "CreateOnlyTaggedGootipHttpApi"
    effect    = "Allow"
    actions   = ["apigateway:POST"]
    resources = ["arn:${data.aws_partition.current.partition}:apigateway:${var.aws_region}::/apis"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Name"
      values   = ["${var.project}-auth-${var.env}"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/project"
      values   = [var.project]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/env"
      values   = [var.env]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/managed_by"
      values   = ["terraform"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["Name", "project", "env", "managed_by"]
    }

    condition {
      test     = "Null"
      variable = "aws:TagKeys"
      values   = ["false"]
    }
  }

  statement {
    sid     = "TagOnlyNewGootipHttpApi"
    effect  = "Allow"
    actions = ["apigateway:POST"]
    resources = [
      "arn:${data.aws_partition.current.partition}:apigateway:${var.aws_region}::/tags/arn%3A${data.aws_partition.current.partition}%3Aapigateway%3A${var.aws_region}%3A%3A%2Fv2%2Fapis%2F*",
    ]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Name"
      values   = ["${var.project}-auth-${var.env}"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/project"
      values   = [var.project]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/env"
      values   = [var.env]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/managed_by"
      values   = ["terraform"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["Name", "project", "env", "managed_by"]
    }

    condition {
      test     = "Null"
      variable = "aws:TagKeys"
      values   = ["false"]
    }
  }

  dynamic "statement" {
    for_each = var.api_gateway_read_id == null ? [] : [true]

    content {
      sid       = "ReadOnlyExactPreparedGootipHttpApi"
      effect    = "Allow"
      actions   = ["apigateway:GET"]
      resources = [local.api_gateway_read_arn]
    }
  }

  dynamic "statement" {
    for_each = var.api_gateway_id == null ? [] : [true]

    content {
      sid    = "ManageOnlyPreparedGootipHttpApi"
      effect = "Allow"
      actions = [
        "apigateway:GET",
        "apigateway:PATCH",
      ]
      resources = [
        local.api_gateway_arn,
        "${local.api_gateway_arn}/authorizers",
        "${local.api_gateway_arn}/authorizers/*",
        "${local.api_gateway_arn}/integrations",
        "${local.api_gateway_arn}/integrations/*",
        "${local.api_gateway_arn}/routes",
        "${local.api_gateway_arn}/routes/*",
        "${local.api_gateway_arn}/stages",
        "${local.api_gateway_arn}/stages/$default",
      ]
    }
  }

  dynamic "statement" {
    for_each = var.api_gateway_id == null ? [] : [true]

    content {
      sid       = "CreateOnlyPreparedApiResources"
      effect    = "Allow"
      actions   = ["apigateway:POST"]
      resources = ["${local.api_gateway_arn}/integrations", "${local.api_gateway_arn}/routes"]
    }
  }

  dynamic "statement" {
    for_each = var.api_gateway_id == null ? [] : [true]

    content {
      sid       = "CreateOnlyJwtAuthorizersOnPreparedApi"
      effect    = "Allow"
      actions   = ["apigateway:POST"]
      resources = ["${local.api_gateway_arn}/authorizers"]

      condition {
        test     = "StringEquals"
        variable = "apigateway:Request/AuthorizerType"
        values   = ["JWT"]
      }
    }
  }

  dynamic "statement" {
    for_each = var.api_gateway_id == null ? [] : [true]

    content {
      sid       = "CreateOnlyTaggedDefaultStageOnPreparedApi"
      effect    = "Allow"
      actions   = ["apigateway:POST"]
      resources = ["${local.api_gateway_arn}/stages"]

      condition {
        test     = "StringEquals"
        variable = "aws:RequestTag/Name"
        values   = ["${var.project}-auth-${var.env}-default"]
      }

      condition {
        test     = "StringEquals"
        variable = "aws:RequestTag/project"
        values   = [var.project]
      }

      condition {
        test     = "StringEquals"
        variable = "aws:RequestTag/env"
        values   = [var.env]
      }

      condition {
        test     = "StringEquals"
        variable = "aws:RequestTag/managed_by"
        values   = ["terraform"]
      }

      condition {
        test     = "ForAllValues:StringEquals"
        variable = "aws:TagKeys"
        values   = ["Name", "project", "env", "managed_by"]
      }

      condition {
        test     = "Null"
        variable = "aws:TagKeys"
        values   = ["false"]
      }
    }
  }

  dynamic "statement" {
    for_each = var.api_gateway_id == null ? [] : [true]

    content {
      sid       = "TagOnlyDefaultStageOnPreparedApi"
      effect    = "Allow"
      actions   = ["apigateway:TagResource"]
      resources = ["${local.api_gateway_arn}/stages"]

      condition {
        test     = "StringEquals"
        variable = "aws:RequestTag/Name"
        values   = ["${var.project}-auth-${var.env}-default"]
      }

      condition {
        test     = "StringEquals"
        variable = "aws:RequestTag/project"
        values   = [var.project]
      }

      condition {
        test     = "StringEquals"
        variable = "aws:RequestTag/env"
        values   = [var.env]
      }

      condition {
        test     = "StringEquals"
        variable = "aws:RequestTag/managed_by"
        values   = ["terraform"]
      }

      condition {
        test     = "ForAllValues:StringEquals"
        variable = "aws:TagKeys"
        values   = ["Name", "project", "env", "managed_by"]
      }

      condition {
        test     = "Null"
        variable = "aws:TagKeys"
        values   = ["false"]
      }
    }
  }

  dynamic "statement" {
    for_each = var.api_gateway_core_permissions_enabled ? [true] : []

    content {
      sid       = "ManageOnlyPreparedCoreApiRoutePermissions"
      effect    = "Allow"
      actions   = ["lambda:AddPermission"]
      resources = [local.core_api_function_arn]

      condition {
        test     = "StringEquals"
        variable = "lambda:Principal"
        values   = ["apigateway.amazonaws.com"]
      }
    }
  }

  statement {
    sid       = "ReadExactCoreLambdaLogEvents"
    effect    = "Allow"
    actions   = ["logs:FilterLogEvents", "logs:Unmask"]
    resources = local.api_observability_log_group_arns

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }
  }

  statement {
    sid       = "ListExactCoreFunctionUrlConfigs"
    effect    = "Allow"
    actions   = ["lambda:ListFunctionUrlConfigs"]
    resources = [local.core_api_function_arn]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }
  }
}

resource "aws_iam_policy" "deployment_api_gateway_permissions" {
  name        = "GootipTerraformDeployApiGatewayPermissions"
  path        = "/gootip/deployment/"
  description = "Bootstrap-managed API Gateway capability limited to the tagged Gootip HTTP API and its exact prepared API ID."
  policy      = data.aws_iam_policy_document.deployment_api_gateway_permissions.json

  tags = {
    Name       = "GootipTerraformDeployApiGatewayPermissions"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }

  depends_on = [aws_iam_policy.bootstrap_policy_admin_permissions]
}

resource "aws_iam_role_policy_attachment" "deployment_api_gateway_permissions" {
  role       = aws_iam_role.terraform_deploy.name
  policy_arn = aws_iam_policy.deployment_api_gateway_permissions.arn
}

data "aws_iam_policy_document" "deployment_observability_permissions" {
  statement {
    sid       = "CreateObsLogGroups"
    effect    = "Allow"
    actions   = ["logs:CreateLogGroup"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Name"
      values = [
        "${var.project}-auth-${var.env}",
        "lambda-db-config",
        "${var.project}-${var.env}-auth-api-access",
      ]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/project"
      values   = [var.project]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/env"
      values   = [var.env]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/managed_by"
      values   = ["terraform"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["Name", "project", "env", "managed_by"]
    }

    condition {
      test     = "Null"
      variable = "aws:TagKeys"
      values   = ["false"]
    }
  }

  statement {
    sid    = "ManageObsLogs"
    effect = "Allow"
    actions = [
      "logs:DeleteLogGroup",
      "logs:ListTagsForResource",
      "logs:PutRetentionPolicy",
    ]
    resources = local.observability_log_group_arns
  }

  statement {
    sid       = "TagObsLogs"
    effect    = "Allow"
    actions   = ["logs:TagLogGroup", "logs:TagResource"]
    resources = local.observability_log_group_arns

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Name"
      values = [
        "${var.project}-auth-${var.env}",
        "lambda-db-config",
        "${var.project}-${var.env}-auth-migrations",
        "${var.project}-${var.env}-auth-api-access",
      ]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/project"
      values   = [var.project]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/env"
      values   = [var.env]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/managed_by"
      values   = ["terraform"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["Name", "project", "env", "managed_by"]
    }

    condition {
      test     = "Null"
      variable = "aws:TagKeys"
      values   = ["false"]
    }
  }

  statement {
    sid       = "PutAlarms"
    effect    = "Allow"
    actions   = ["cloudwatch:PutMetricAlarm", "cloudwatch:TagResource"]
    resources = local.observability_alarm_arns

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/project"
      values   = [var.project]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/env"
      values   = [var.env]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/managed_by"
      values   = ["terraform"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["project", "env", "managed_by"]
    }

    condition {
      test     = "Null"
      variable = "aws:TagKeys"
      values   = ["false"]
    }
  }

  statement {
    sid    = "AlarmOps"
    effect = "Allow"
    actions = [
      "cloudwatch:DeleteAlarms",
      "cloudwatch:DescribeAlarms",
      "cloudwatch:ListTagsForResource",
    ]
    resources = local.observability_alarm_arns
  }

  statement {
    sid       = "CreateObsTopic"
    effect    = "Allow"
    actions   = ["sns:CreateTopic", "sns:TagResource"]
    resources = [local.observability_topic_arn]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Name"
      values   = ["${var.project}-${var.env}-operational-alarms"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/project"
      values   = [var.project]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/env"
      values   = [var.env]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/managed_by"
      values   = ["terraform"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["Name", "project", "env", "managed_by"]
    }

    condition {
      test     = "Null"
      variable = "aws:TagKeys"
      values   = ["false"]
    }
  }

  statement {
    sid    = "ManageObsTopic"
    effect = "Allow"
    actions = [
      "sns:DeleteTopic",
      "sns:GetSubscriptionAttributes",
      "sns:GetTopicAttributes",
      "sns:ListSubscriptionsByTopic",
      "sns:ListTagsForResource",
      "sns:SetTopicAttributes",
      "sns:Subscribe",
    ]
    resources = [local.observability_topic_arn]
  }

  statement {
    sid    = "ManageBudget"
    effect = "Allow"
    actions = [
      "budgets:ListTagsForResource",
      "budgets:ModifyBudget",
      "budgets:ViewBudget",
    ]
    resources = [local.observability_budget_arn]
  }

  statement {
    sid       = "ReadBillingPrefs"
    effect    = "Allow"
    actions   = ["billing:GetBillingPreferences"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_billing_region]
    }
  }

  statement {
    sid       = "TagBudget"
    effect    = "Allow"
    actions   = ["budgets:TagResource"]
    resources = [local.observability_budget_arn]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Name"
      values   = ["${var.project}-${var.env}-monthly-actual-cost"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/project"
      values   = [var.project]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/env"
      values   = [var.env]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/managed_by"
      values   = ["terraform"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["Name", "project", "env", "managed_by"]
    }

    condition {
      test     = "Null"
      variable = "aws:TagKeys"
      values   = ["false"]
    }
  }

  statement {
    sid       = "ManageObsEmail"
    effect    = "Allow"
    actions   = ["sns:Unsubscribe"]
    resources = [local.observability_topic_subscription_arn]
  }

  statement {
    sid    = "UntagObs"
    effect = "Allow"
    actions = [
      "cloudwatch:UntagResource",
      "budgets:UntagResource",
      "logs:UntagLogGroup",
      "logs:UntagResource",
      "sns:UntagResource",
    ]
    resources = concat(
      local.observability_log_group_arns,
      local.observability_alarm_arns,
      [local.observability_topic_arn, local.observability_budget_arn],
    )

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["Name", "project", "env", "managed_by"]
    }

    condition {
      test     = "Null"
      variable = "aws:TagKeys"
      values   = ["false"]
    }
  }
}

resource "aws_iam_policy" "deployment_observability_permissions" {
  name        = "GootipTerraformDeployObservabilityPermissions"
  path        = "/gootip/deployment/"
  description = "Bootstrap-managed least-privilege deployment capability for SPEC 06 observability."
  policy      = data.aws_iam_policy_document.deployment_observability_permissions.json

  tags = {
    Name       = "GootipTerraformDeployObservabilityPermissions"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }

  depends_on = [aws_iam_policy.bootstrap_policy_admin_permissions]
}

resource "aws_iam_role_policy_attachment" "deployment_observability_permissions" {
  role       = aws_iam_role.terraform_deploy.name
  policy_arn = aws_iam_policy.deployment_observability_permissions.arn
}

data "aws_iam_policy_document" "deployment_api_observability_permissions" {
  # HTTP API access-log delivery actions below do not support resource-level
  # ARNs. Keep the wildcard action set regional and enable it only for the
  # prepared API. The exact Auth access log group already exists, so no
  # logs:CreateLogGroup grant is needed here.
  dynamic "statement" {
    for_each = var.api_gateway_id == null ? [] : [true]

    content {
      sid    = "ManageAuthApiLogDeliveryInRegion"
      effect = "Allow"
      actions = [
        "logs:CreateLogDelivery",
        "logs:DeleteLogDelivery",
        "logs:DescribeLogGroups",
        "logs:DescribeResourcePolicies",
        "logs:GetLogDelivery",
        "logs:ListLogDeliveries",
        "logs:PutResourcePolicy",
        "logs:UpdateLogDelivery",
      ]
      resources = ["*"]

      condition {
        test     = "StringEquals"
        variable = "aws:RequestedRegion"
        values   = [var.aws_region]
      }
    }
  }

  statement {
    sid       = "CreateApiObsLogGroups"
    effect    = "Allow"
    actions   = ["logs:CreateLogGroup"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Name"
      values   = ["${var.project}-core-${var.env}"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/project"
      values   = [var.project]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/env"
      values   = [var.env]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/managed_by"
      values   = ["terraform"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["Name", "project", "env", "managed_by"]
    }

    condition {
      test     = "Null"
      variable = "aws:TagKeys"
      values   = ["false"]
    }
  }

  statement {
    sid    = "ManageApiObsLogs"
    effect = "Allow"
    actions = [
      "logs:DeleteLogGroup",
      "logs:ListTagsForResource",
      "logs:PutRetentionPolicy",
    ]
    resources = local.api_observability_log_group_arns
  }

  statement {
    sid       = "TagApiObsLogs"
    effect    = "Allow"
    actions   = ["logs:TagLogGroup", "logs:TagResource"]
    resources = local.api_observability_log_group_arns

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Name"
      values   = ["${var.project}-core-${var.env}"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/project"
      values   = [var.project]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/env"
      values   = [var.env]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/managed_by"
      values   = ["terraform"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["Name", "project", "env", "managed_by"]
    }

    condition {
      test     = "Null"
      variable = "aws:TagKeys"
      values   = ["false"]
    }
  }

  statement {
    sid       = "UntagApiObsLogs"
    effect    = "Allow"
    actions   = ["logs:UntagLogGroup", "logs:UntagResource"]
    resources = local.api_observability_log_group_arns

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["Name", "project", "env", "managed_by"]
    }

    condition {
      test     = "Null"
      variable = "aws:TagKeys"
      values   = ["false"]
    }
  }

  statement {
    sid       = "ReadExactAuthApiLogs"
    effect    = "Allow"
    actions   = ["logs:DescribeLogStreams", "logs:FilterLogEvents"]
    resources = local.auth_api_log_group_arns
  }

  statement {
    sid       = "ReadExactAuthApiLogStreams"
    effect    = "Allow"
    actions   = ["logs:GetLogEvents"]
    resources = local.auth_api_log_stream_arns
  }

}

data "aws_iam_policy_document" "deployment_db_config_permissions" {
  statement {
    sid       = "CreateExactDbConfigRole"
    effect    = "Allow"
    actions   = ["iam:CreateRole"]
    resources = [local.administrative_role_arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.runtime_boundary_arn]
    }
  }

  statement {
    sid       = "ReadAndTagExactDbConfigRole"
    effect    = "Allow"
    actions   = ["iam:GetRole", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole", "iam:ListRolePolicies", "iam:TagRole"]
    resources = [local.administrative_role_arn]
  }

  statement {
    sid       = "DeleteExactDbConfigRole"
    effect    = "Allow"
    actions   = ["iam:DeleteRole", "iam:DetachRolePolicy"]
    resources = [local.administrative_role_arn]
  }

  statement {
    sid    = "CreateReadAndTagExactDbConfigSecretsPolicy"
    effect = "Allow"
    actions = [
      "iam:CreatePolicy",
      "iam:CreatePolicyVersion",
      "iam:DeletePolicyVersion",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListPolicyVersions",
      "iam:SetDefaultPolicyVersion",
      "iam:TagPolicy",
    ]
    resources = [local.db_config_secrets_policy_arn]
  }

  statement {
    sid    = "ManageExactDbConfigHardeningPolicies"
    effect = "Allow"
    actions = [
      "iam:CreatePolicy",
      "iam:CreatePolicyVersion",
      "iam:DeletePolicyVersion",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListPolicyTags",
      "iam:ListPolicyVersions",
      "iam:SetDefaultPolicyVersion",
      "iam:TagPolicy",
      "iam:UntagPolicy",
    ]
    resources = [local.db_config_logs_policy_arn, local.db_config_vpc_policy_arn]
  }

  statement {
    sid       = "DeleteExactDbConfigSecretsPolicy"
    effect    = "Allow"
    actions   = ["iam:DeletePolicy"]
    resources = [local.db_config_secrets_policy_arn]
  }

  statement {
    sid       = "AttachOnlyReviewedDbConfigPolicies"
    effect    = "Allow"
    actions   = ["iam:AttachRolePolicy"]
    resources = [local.administrative_role_arn]

    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values = [
        "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
        local.db_config_secrets_policy_arn,
        local.db_config_logs_policy_arn,
        local.db_config_vpc_policy_arn,
      ]
    }
  }

  statement {
    sid       = "DetachOnlyTransitionDbConfigPolicies"
    effect    = "Allow"
    actions   = ["iam:DetachRolePolicy"]
    resources = [local.administrative_role_arn]

    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values = [
        "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
      ]
    }
  }

  statement {
    sid       = "CreateReadAndTagExactDbConfigFunction"
    effect    = "Allow"
    actions   = ["lambda:CreateFunction", "lambda:GetFunction", "lambda:GetFunctionCodeSigningConfig", "lambda:ListVersionsByFunction", "lambda:TagResource", "lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration"]
    resources = [local.db_config_function_arn]
  }

  statement {
    sid       = "ReadExactDbConfigFunctionConfiguration"
    effect    = "Allow"
    actions   = ["lambda:GetFunctionConfiguration"]
    resources = [local.db_config_function_arn]
  }

  statement {
    sid       = "DeleteExactDbConfigFunction"
    effect    = "Allow"
    actions   = ["lambda:DeleteFunction"]
    resources = [local.db_config_function_arn]
  }
}

resource "aws_iam_policy" "deployment_db_config_permissions" {
  name        = "GootipTerraformDeployDbConfigPermissions"
  path        = "/gootip/deployment/"
  description = "Bootstrap-managed least-privilege deployment capability for the SPEC 03 administrative Lambda."
  policy      = data.aws_iam_policy_document.deployment_db_config_permissions.json

  tags = {
    Name       = "GootipTerraformDeployDbConfigPermissions"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_iam_role_policy_attachment" "deployment_db_config_permissions" {
  role       = aws_iam_role.terraform_deploy.name
  policy_arn = aws_iam_policy.deployment_db_config_permissions.arn
}

# SPEC 03.1 attaches the three capability-scoped foundation policies. Each one is
# gated by foundation_policy_expansion_enabled, exactly as the merged document
# was, so the deployment role carries no foundation statement while the
# expansion is disabled.
resource "aws_iam_policy" "deployment_network_permissions" {
  count = var.foundation_policy_expansion_enabled ? 1 : 0

  name        = "GootipTerraformDeployNetworkPermissions"
  path        = "/gootip/deployment/"
  description = "Foundation network permissions for the Gootip deployment role."
  policy      = data.aws_iam_policy_document.deployment_network_permissions[0].json

  tags = {
    Name       = "GootipTerraformDeployNetworkPermissions"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_iam_role_policy_attachment" "deployment_network_permissions" {
  count      = var.foundation_policy_expansion_enabled ? 1 : 0
  role       = aws_iam_role.terraform_deploy.name
  policy_arn = aws_iam_policy.deployment_network_permissions[0].arn
}

resource "aws_iam_policy" "deployment_database_permissions" {
  count = var.foundation_policy_expansion_enabled ? 1 : 0

  name        = "GootipTerraformDeployDatabasePermissions"
  path        = "/gootip/deployment/"
  description = "Foundation database permissions for the Gootip deployment role."
  policy      = data.aws_iam_policy_document.deployment_database_permissions[0].json

  tags = {
    Name       = "GootipTerraformDeployDatabasePermissions"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_iam_role_policy_attachment" "deployment_database_permissions" {
  count      = var.foundation_policy_expansion_enabled ? 1 : 0
  role       = aws_iam_role.terraform_deploy.name
  policy_arn = aws_iam_policy.deployment_database_permissions[0].arn
}

# Temporary policy creation and the foundation-read retirement lifecycle are
# scoped to exact ARNs and exist only while split_policy_creation_enabled is true.
data "aws_iam_policy_document" "bootstrap_split_policy_creation" {
  count = var.split_policy_creation_enabled ? 1 : 0

  statement {
    sid     = "CreateExactSplitPolicies"
    effect  = "Allow"
    actions = ["iam:CreatePolicy", "iam:ListPolicyTags", "iam:TagPolicy", "iam:UntagPolicy"]
    resources = [
      local.bootstrap_policy_admin_policy_arn,
      local.deployment_network_policy_arn,
      local.deployment_database_policy_arn,
      local.deployment_application_policy_arn,
      local.deployment_api_gateway_policy_arn,
      local.bootstrap_deployment_policy_admin_arn,
    ]
  }

  statement {
    sid    = "ReadExactFoundationRetirementTargets"
    effect = "Allow"
    actions = [
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListPolicyTags",
    ]
    resources = [
      local.deployment_foundation_read_policy_arn,
      local.deployment_observability_policy_arn,
    ]
  }

  statement {
    sid       = "DeleteExactRetiredFoundationReadPolicy"
    effect    = "Allow"
    actions   = ["iam:DeletePolicy"]
    resources = [local.deployment_foundation_read_policy_arn]
  }

  statement {
    sid       = "ListVersionsExactRetiredFoundationReadPolicy"
    effect    = "Allow"
    actions   = ["iam:ListPolicyVersions"]
    resources = [local.deployment_foundation_read_policy_arn]
  }
}

data "aws_iam_policy_document" "bootstrap_permissions" {
  source_policy_documents = concat(
    var.account_resource_phase_enabled ? [data.aws_iam_policy_document.bootstrap_application_secret_permissions[0].json] : [],
    var.split_policy_creation_enabled ? [data.aws_iam_policy_document.bootstrap_split_policy_creation[0].json] : [],
  )

  # KMS aliases have no resource-level IAM scope. This regional read is limited
  # to diagnosing the AWS-managed RDS key used by the foundation.
  statement {
    sid       = "ListKmsAliasesInFoundationRegion"
    effect    = "Allow"
    actions   = ["kms:ListAliases"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }
  }

  statement {
    sid       = "DescribeExactRdsManagedKmsKey"
    effect    = "Allow"
    actions   = ["kms:DescribeKey"]
    resources = [local.rds_kms_key_arn]
  }

  # This permits only the AWS-managed RDS service-linked role to be created
  # externally when RDS first requires it. Terraform never manages or imports
  # the role itself.
  statement {
    sid       = "ReadExactRdsServiceLinkedRole"
    effect    = "Allow"
    actions   = ["iam:GetRole"]
    resources = [local.rds_service_linked_role_arn]
  }

  statement {
    sid       = "CreateExactRdsServiceLinkedRole"
    effect    = "Allow"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = [local.rds_service_linked_role_arn]

    condition {
      test     = "StringEquals"
      variable = "iam:AWSServiceName"
      values   = ["rds.amazonaws.com"]
    }
  }

  # SPEC 05.2: the EC2 Instance Connect service-linked role is created externally
  # once through this temporary exact grant. Terraform never manages or imports
  # the role, and the permission is removed immediately after it exists.
  dynamic "statement" {
    for_each = var.instance_connect_service_linked_role_creation_enabled ? [true] : []

    content {
      sid       = "CreateExactInstanceConnectServiceLinkedRole"
      effect    = "Allow"
      actions   = ["iam:CreateServiceLinkedRole"]
      resources = [local.instance_connect_service_linked_role_arn]

      condition {
        test     = "StringEquals"
        variable = "iam:AWSServiceName"
        values   = ["ec2-instance-connect.amazonaws.com"]
      }
    }
  }

  dynamic "statement" {
    for_each = var.db_config_operator_invocation_enabled ? [true] : []

    content {
      sid       = "InvokeExactDbConfigBootstrap"
      effect    = "Allow"
      actions   = ["lambda:InvokeFunction"]
      resources = [local.db_config_function_arn]
    }
  }

  # SPEC 03.1 moved the role and policy lifecycle statements
  # (ManageExactHumanRolesAndPolicies, ManageExactSplitPolicyTags, and
  # CreateExactAdministrativePassRolePolicy) into the capability-scoped
  # GootipBootstrapPolicyAdminPermissions policy.

  statement {
    sid    = "ManageSourceUserCutoverOnly"
    effect = "Allow"
    actions = [
      "iam:AttachUserPolicy",
      "iam:DeleteUserPermissionsBoundary",
      "iam:DeleteUserPolicy",
      "iam:DetachUserPolicy",
      "iam:GetUser",
      "iam:GetUserPolicy",
      "iam:ListAttachedUserPolicies",
      "iam:ListGroupsForUser",
      "iam:ListUserPolicies",
      "iam:PutUserPermissionsBoundary",
      "iam:PutUserPolicy",
    ]
    resources = [local.source_user_arn]
  }

  # IAM evaluates RemoveUserFromGroup against the group resource rather than
  # the user. This is limited to groups in the validated account and used only
  # to remove the imported source user during the reviewed cutover inventory.
  statement {
    sid       = "RemoveSourceUserFromAccountGroups"
    effect    = "Allow"
    actions   = ["iam:RemoveUserFromGroup"]
    resources = [local.account_group_path_arn]
  }

}

# Temporary container-creation grant for the reviewed role-secret apply only. It
# is an inline policy so it can be added and removed with the existing
# PutRolePolicy/DeleteRolePolicy grants, and it names only the two exact
# containers plus the required Gootip tags. It is removed as soon as the
# containers exist (role_secret_creation_enabled=false).
data "aws_iam_policy_document" "role_secret_creation" {
  count = var.role_secret_creation_enabled ? 1 : 0

  statement {
    sid       = "CreateExactRoleSecretContainers"
    effect    = "Allow"
    actions   = ["secretsmanager:CreateSecret"]
    resources = [local.role_secret_arn_pattern]

    condition {
      test     = "StringEquals"
      variable = "secretsmanager:Name"
      values   = local.role_secret_names
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/project"
      values   = [var.project]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/env"
      values   = [var.env]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/managed_by"
      values   = ["terraform"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["Name", "project", "env", "managed_by"]
    }
  }
}

resource "aws_iam_role_policy" "role_secret_creation" {
  count = var.role_secret_creation_enabled ? 1 : 0

  name   = "GootipRoleSecretCreation"
  role   = aws_iam_role.bootstrap_admin.id
  policy = data.aws_iam_policy_document.role_secret_creation[0].json
}

data "aws_iam_policy_document" "core_role_secret_creation" {
  count = var.core_role_secret_creation_enabled ? 1 : 0

  statement {
    sid       = "CreateOnlyCoreRoleSecretContainers"
    effect    = "Allow"
    actions   = ["secretsmanager:CreateSecret"]
    resources = local.core_role_secret_arn_patterns

    condition {
      test     = "StringEquals"
      variable = "secretsmanager:Name"
      values   = local.core_role_secret_names
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/project"
      values   = [var.project]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Name"
      values   = local.core_role_secret_names
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/env"
      values   = [var.env]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/managed_by"
      values   = ["terraform"]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["Name", "project", "env", "managed_by"]
    }
    condition {
      test     = "Null"
      variable = "aws:TagKeys"
      values   = ["false"]
    }
  }
}

resource "aws_iam_role_policy" "core_role_secret_creation" {
  count = var.core_role_secret_creation_enabled ? 1 : 0

  name   = "GootipCoreRoleSecretCreation"
  role   = aws_iam_role.bootstrap_admin.id
  policy = data.aws_iam_policy_document.core_role_secret_creation[0].json
}

# SPEC 05.1 temporary container-creation grant for the reviewed operator-secret
# apply only. It mirrors the SPEC 03 role-secret grant but names only the exact
# gootip-dev-db-operator container and the required Gootip tags. It is an inline
# policy so it is added and removed with the existing PutRolePolicy/DeleteRolePolicy
# grants, and it disappears as soon as the container exists
# (database_operator_secret_creation_enabled=false).
data "aws_iam_policy_document" "database_operator_secret_creation" {
  count = var.database_operator_secret_creation_enabled ? 1 : 0

  statement {
    sid       = "CreateExactDatabaseOperatorSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:CreateSecret"]
    resources = [local.database_operator_secret_arn_pattern]

    condition {
      test     = "StringEquals"
      variable = "secretsmanager:Name"
      values   = [local.database_operator_secret_name]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/project"
      values   = [var.project]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/env"
      values   = [var.env]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/managed_by"
      values   = ["terraform"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Name"
      values   = [local.database_operator_secret_name]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["Name", "project", "env", "managed_by"]
    }

    condition {
      test     = "Null"
      variable = "aws:TagKeys"
      values   = ["false"]
    }
  }
}

resource "aws_iam_role_policy" "database_operator_secret_creation" {
  count = var.database_operator_secret_creation_enabled ? 1 : 0

  name   = "GootipDatabaseOperatorSecretCreation"
  role   = aws_iam_role.bootstrap_admin.id
  policy = data.aws_iam_policy_document.database_operator_secret_creation[0].json
}

resource "aws_iam_policy" "bootstrap_permissions" {
  name        = "GootipBootstrapAdminPermissions"
  path        = "/gootip/bootstrap/"
  description = "Bootstrap-owned explicit control-plane permissions for Gootip."
  policy      = data.aws_iam_policy_document.bootstrap_permissions.json

  tags = {
    Name       = "GootipBootstrapAdminPermissions"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_iam_role_policy_attachment" "bootstrap_permissions" {
  role       = aws_iam_role.bootstrap_admin.name
  policy_arn = aws_iam_policy.bootstrap_permissions.arn
}

# Role, policy, version, tag, and attachment lifecycle for the bootstrap
# identity. SPEC 03.1 moved these statements out of GootipBootstrapAdminPermissions
# because that policy grew past the healthy capacity budget of SPEC 02.3. Every
# moved statement keeps its exact actions, resources, and conditions; only its
# policy changed. The managed-ARN list now also names the capability-scoped
# policies introduced by this spec so the same lifecycle covers them.
# The role, policy, and tag lifecycle the bootstrap admin needs. It is the whole
# of the policy-admin capability in the standing configuration. SPEC 03.1 keeps a
# single definition here so the temporary creation apply can merge the same
# statements into the retained core without duplicating them (see
# bootstrap_split_policy_creation).
# The role, policy, and tag lifecycle the bootstrap admin needs. Together with
# the two statements in the capability document below, this is the whole of
# GootipBootstrapPolicyAdminPermissions in the standing configuration.
#
# SPEC 03.1 needs only iam:AttachRolePolicy and iam:CreatePolicyVersion while the
# capability does not exist yet: apply B creates the four split policies and
# attaches them to their roles, and it updates GootipTerraformDeployPermissions.
# This single statement authorizes all of that, so it is the only statement the
# temporary split-creation document merges into the retained core. Retaining the
# other two as well overflowed the 6144-character policy quota (6192 rendered),
# which is why apply A must drop them.
data "aws_iam_policy_document" "bootstrap_role_policy_lifecycle" {
  statement {
    sid    = "ManageExactHumanRolesAndPolicies"
    effect = "Allow"
    actions = [
      "iam:AttachRolePolicy",
      "iam:CreatePolicyVersion",
      "iam:DeletePolicyVersion",
      "iam:DeleteRolePolicy",
      "iam:DetachRolePolicy",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListPolicyVersions",
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:ListRolePolicies",
      "iam:PutRolePolicy",
      "iam:SetDefaultPolicyVersion",
      "iam:TagRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:UpdateRole",
    ]
    resources = [
      local.bootstrap_role_arn,
      local.deployment_role_arn,
      local.bootstrap_policy_arn,
      local.bootstrap_policy_admin_policy_arn,
      local.bootstrap_state_policy_arn,
      local.bootstrap_diagnostics_policy_arn,
      local.deployment_policy_arn,
      local.deployment_pass_role_policy_arn,
      local.deployment_network_policy_arn,
      local.deployment_database_policy_arn,
      local.deployment_db_config_policy_arn,
      local.deployment_auth_migrations_policy_arn,
      local.deployment_core_migrations_policy_arn,
      local.bootstrap_deployment_policy_admin_arn,
      local.runtime_boundary_arn,
      local.source_boundary_arn,
      local.source_assume_policy_arn,
    ]
  }
}

# The standing capability: the retained role/policy lifecycle plus split-policy
# tag management and the SPEC 03 PassRole creation statement. Applying it is what
# returns the retained core to its final shape.
data "aws_iam_policy_document" "bootstrap_policy_admin_permissions" {
  source_policy_documents = [data.aws_iam_policy_document.bootstrap_role_policy_lifecycle.json]

  statement {
    sid     = "ManageExactSplitPolicyTags"
    effect  = "Allow"
    actions = ["iam:TagPolicy", "iam:UntagPolicy"]
    resources = [
      local.bootstrap_state_policy_arn,
      local.bootstrap_diagnostics_policy_arn,
      local.bootstrap_policy_admin_policy_arn,
      local.deployment_network_policy_arn,
      local.deployment_database_policy_arn,
      local.bootstrap_deployment_policy_admin_arn,
    ]
  }

  # SPEC 03 needs one additional attached managed policy for the deployment role
  # (the exact administrative PassRole allowlist). Creating a customer managed
  # policy is therefore a reviewed capability scoped to exactly that one policy
  # ARN. No other customer managed policy can be created, and no policy can be
  # deleted.
  # SPEC 05.1 adds the interactive database-operator role and its exact
  # secret-read policy. Both stay out of the shared human-role lifecycle statement
  # so the temporary SPEC 03.1 transition core keeps its reviewed size. Their full
  # trust, tag, attachment, version, and read lifecycle is scoped to exactly these
  # two ARNs.
  statement {
    sid    = "ManageExactDatabaseOperatorRole"
    effect = "Allow"
    actions = [
      "iam:AttachRolePolicy",
      "iam:CreateRole",
      "iam:DetachRolePolicy",
      "iam:GetRole",
      "iam:ListAttachedRolePolicies",
      "iam:ListRolePolicies",
      "iam:TagRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:UpdateRole",
    ]
    resources = [local.database_operator_role_arn]
  }

  statement {
    sid    = "ManageExactDatabaseOperatorPolicy"
    effect = "Allow"
    actions = [
      "iam:CreatePolicy",
      "iam:CreatePolicyVersion",
      "iam:DeletePolicyVersion",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListPolicyTags",
      "iam:ListPolicyVersions",
      "iam:SetDefaultPolicyVersion",
      "iam:TagPolicy",
      "iam:UntagPolicy",
    ]
    resources = [local.database_operator_policy_arn]
  }

}

resource "aws_iam_policy" "bootstrap_policy_admin_permissions" {
  name        = "GootipBootstrapPolicyAdminPermissions"
  path        = "/gootip/bootstrap/"
  description = "Bootstrap-owned role and policy lifecycle permissions for Gootip."
  policy      = data.aws_iam_policy_document.bootstrap_policy_admin_permissions.json

  tags = {
    Name       = "GootipBootstrapPolicyAdminPermissions"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }

  # Creating this policy is authorized by the retained bootstrap core, so that
  # update must be applied first. IAM authorization propagation can still lag,
  # which is why the operator procedure applies the core permissions update as
  # its own reviewed step before this resource.
  depends_on = [aws_iam_policy.bootstrap_permissions]
}

resource "aws_iam_role_policy_attachment" "bootstrap_policy_admin_permissions" {
  role       = aws_iam_role.bootstrap_admin.name
  policy_arn = aws_iam_policy.bootstrap_policy_admin_permissions.arn
}

data "aws_iam_policy_document" "bootstrap_deployment_policy_admin_permissions" {
  statement {
    sid     = "ManageExactDeploymentPolicyTags"
    effect  = "Allow"
    actions = ["iam:ListPolicyTags", "iam:TagPolicy", "iam:UntagPolicy"]
    resources = [
      local.deployment_pass_role_policy_arn,
      local.deployment_db_config_policy_arn,
      local.deployment_auth_migrations_policy_arn,
      local.deployment_core_migrations_policy_arn,
      local.deployment_observability_policy_arn,
      local.deployment_application_policy_arn,
      local.deployment_api_gateway_policy_arn,
    ]
  }

  statement {
    sid     = "ManageExactDeploymentPolicies"
    effect  = "Allow"
    actions = ["iam:CreatePolicy", "iam:CreatePolicyVersion", "iam:DeletePolicyVersion", "iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyVersions", "iam:SetDefaultPolicyVersion"]
    resources = [
      local.deployment_pass_role_policy_arn,
      local.deployment_db_config_policy_arn,
      local.deployment_auth_migrations_policy_arn,
      local.deployment_core_migrations_policy_arn,
      local.deployment_observability_policy_arn,
      local.deployment_application_policy_arn,
      local.deployment_api_gateway_policy_arn,
    ]
  }
}

resource "aws_iam_policy" "bootstrap_deployment_policy_admin_permissions" {
  name        = "GootipBootstrapDeploymentPolicyAdminPermissions"
  path        = "/gootip/bootstrap/"
  description = "Bootstrap-only management of exact Gootip deployment capability policies."
  policy      = data.aws_iam_policy_document.bootstrap_deployment_policy_admin_permissions.json

  tags = {
    Name       = "GootipBootstrapDeploymentPolicyAdminPermissions"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }

  depends_on = [aws_iam_policy.bootstrap_policy_admin_permissions]
}

resource "aws_iam_role_policy_attachment" "bootstrap_deployment_policy_admin_permissions" {
  role       = aws_iam_role.bootstrap_admin.name
  policy_arn = aws_iam_policy.bootstrap_deployment_policy_admin_permissions.arn
}

data "aws_iam_policy_document" "bootstrap_state_permissions" {
  statement {
    sid       = "ReadExactStateBucketExistence"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [local.state_bucket_arn]
  }

  statement {
    sid       = "ReadBootstrapStateBucketRegion"
    effect    = "Allow"
    actions   = ["s3:GetBucketLocation"]
    resources = [local.state_bucket_arn]

    condition {
      test     = "StringEquals"
      variable = "s3:ResourceAccount"
      values   = [var.aws_account_id]
    }
  }

  statement {
    sid       = "ReadExactStateBucketConfiguration"
    effect    = "Allow"
    actions   = ["s3:GetReplicationConfiguration", "s3:GetLifecycleConfiguration", "s3:GetEncryptionConfiguration", "s3:GetBucketWebsite", "s3:GetBucketVersioning", "s3:GetBucketTagging", "s3:GetBucketRequestPayment", "s3:GetBucketPublicAccessBlock", "s3:GetBucketPolicy", "s3:GetBucketOwnershipControls", "s3:GetBucketObjectLockConfiguration", "s3:GetBucketLogging", "s3:GetBucketLocation", "s3:GetBucketCORS", "s3:GetBucketAcl", "s3:GetAccelerateConfiguration"]
    resources = [local.state_bucket_arn]
  }

  # SPEC 02.1 amendment, evidence from IAM Access Analyzer ValidatePolicy:
  # s3:PutBucketEncryption does not exist as an IAM action. The PutBucketEncryption
  # API authorizes against s3:PutEncryptionConfiguration, so the previous entry
  # granted no encryption-config write at all. This is the single documented
  # action substitution accepted against the recorded SPEC 03.1 pre-split
  # baseline, which is deliberately not re-recorded, so the history stays
  # auditable. Every other statement of this policy is unchanged.
  statement {
    sid       = "ManageExactStateBucketConfiguration"
    effect    = "Allow"
    actions   = ["s3:PutBucketVersioning", "s3:PutBucketPublicAccessBlock", "s3:PutBucketPolicy", "s3:PutBucketOwnershipControls", "s3:PutEncryptionConfiguration", "s3:GetEncryptionConfiguration", "s3:GetBucketVersioning", "s3:GetBucketPublicAccessBlock", "s3:GetBucketPolicy", "s3:GetBucketOwnershipControls", "s3:GetBucketAcl", "s3:DeleteBucketPolicy"]
    resources = [local.state_bucket_arn]

    condition {
      test     = "StringEquals"
      variable = "s3:ResourceAccount"
      values   = [var.aws_account_id]
    }
  }

  statement {
    sid       = "ReadWriteBootstrapStateOnly"
    effect    = "Allow"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = [local.bootstrap_state_object_arn]

    condition {
      test     = "StringEquals"
      variable = "s3:ResourceAccount"
      values   = [var.aws_account_id]
    }
  }

  statement {
    sid       = "ManageBootstrapLockOnly"
    effect    = "Allow"
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = [local.bootstrap_lock_object_arn]

    condition {
      test     = "StringEquals"
      variable = "s3:ResourceAccount"
      values   = [var.aws_account_id]
    }
  }

  statement {
    sid       = "RecoverOnlyApprovedStateVersions"
    effect    = "Allow"
    actions   = ["s3:GetObjectVersion"]
    resources = [local.application_state_object_arn, local.bootstrap_state_object_arn]

    condition {
      test     = "StringEquals"
      variable = "s3:ResourceAccount"
      values   = [var.aws_account_id]
    }
  }

  statement {
    sid       = "RestoreOnlyApprovedStateObjects"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = [local.application_state_object_arn, local.bootstrap_state_object_arn]

    condition {
      test     = "StringEquals"
      variable = "s3:ResourceAccount"
      values   = [var.aws_account_id]
    }
  }

  statement {
    sid       = "ListOnlyApprovedStateVersions"
    effect    = "Allow"
    actions   = ["s3:ListBucketVersions"]
    resources = [local.state_bucket_arn]

    condition {
      test     = "StringEquals"
      variable = "s3:ResourceAccount"
      values   = [var.aws_account_id]
    }

    condition {
      test     = "StringEquals"
      variable = "s3:prefix"
      values   = [local.bootstrap_state_key, local.application_state_key]
    }
  }

}

resource "aws_iam_policy" "bootstrap_state_permissions" {
  name        = "GootipBootstrapStatePermissions"
  path        = "/gootip/bootstrap/"
  description = "Bootstrap-owned exact state access permissions for Gootip."
  policy      = data.aws_iam_policy_document.bootstrap_state_permissions.json

  tags = {
    Name       = "GootipBootstrapStatePermissions"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_iam_role_policy_attachment" "bootstrap_state_permissions" {
  role       = aws_iam_role.bootstrap_admin.name
  policy_arn = aws_iam_policy.bootstrap_state_permissions.arn
}
data "aws_iam_policy_document" "bootstrap_diagnostics_permissions" {
  statement {
    sid       = "LookupFoundationCloudTrailEventsInRegion"
    effect    = "Allow"
    actions   = ["cloudtrail:LookupEvents"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.aws_region]
    }
  }

  # SPEC 02.3 read-only policy and role inventory. This authorization belongs to
  # SPEC 02.3 and not to the SPEC 03.1 capacity split, so it is gated behind
  # diagnostics_inventory_enabled: every SPEC 03.1 apply renders the diagnostics
  # policy exactly as it already exists in AWS, and the SPEC 02.3 inventory is
  # introduced by its own reviewed apply that flips the flag. The statements
  # below are unchanged from that specification.

  # IAM Access Analyzer ValidatePolicy has no resource-level scope. The Region
  # condition keeps the read-only policy validation inside the assigned project
  # Region and never authorizes a mutating Access Analyzer action.
  dynamic "statement" {
    for_each = var.diagnostics_inventory_enabled ? [1] : []

    content {
      sid       = "ValidateGootipPoliciesInConfiguredRegion"
      effect    = "Allow"
      actions   = ["access-analyzer:ValidatePolicy"]
      resources = ["*"]

      condition {
        test     = "StringEquals"
        variable = "aws:RequestedRegion"
        values   = [var.aws_region]
      }
    }
  }

  # Read-only default-version inventory for the exact Terraform-owned Gootip
  # customer managed policies, including every SPEC 03.1 split policy. No
  # list-all-account, creation, version mutation, or attachment mutation is
  # authorized.
  dynamic "statement" {
    for_each = var.diagnostics_inventory_enabled ? [1] : []

    content {
      sid    = "ReadGootipManagedPolicyVersions"
      effect = "Allow"
      actions = [
        "iam:GetPolicy",
        "iam:GetPolicyVersion",
        "iam:ListPolicyVersions",
      ]
      resources = [
        local.bootstrap_policy_arn,
        local.bootstrap_policy_admin_policy_arn,
        local.bootstrap_state_policy_arn,
        local.bootstrap_diagnostics_policy_arn,
        local.deployment_policy_arn,
        local.deployment_pass_role_policy_arn,
        local.deployment_network_policy_arn,
        local.deployment_database_policy_arn,
        local.deployment_db_config_policy_arn,
        local.database_operator_policy_arn,
        local.runtime_boundary_arn,
        local.source_boundary_arn,
        local.source_assume_policy_arn,
      ]
    }
  }

  # Read-only attachment inventory for the exact Terraform-owned Gootip roles.
  # A permissions boundary is read through its policy ARN above and is never
  # normalized as a role attachment.
  dynamic "statement" {
    for_each = var.diagnostics_inventory_enabled ? [1] : []

    content {
      sid    = "ReadGootipRoleAttachments"
      effect = "Allow"
      actions = [
        "iam:GetRole",
        "iam:ListAttachedRolePolicies",
        "iam:ListRolePolicies",
      ]
      resources = [
        local.bootstrap_role_arn,
        local.deployment_role_arn,
        local.database_operator_role_arn,
      ]
    }
  }
}

resource "aws_iam_policy" "bootstrap_diagnostics_permissions" {
  name        = "GootipBootstrapDiagnosticsPermissions"
  path        = "/gootip/bootstrap/"
  description = "Read-only diagnostics for the Gootip bootstrap control plane."
  policy      = data.aws_iam_policy_document.bootstrap_diagnostics_permissions.json

  tags = {
    Name       = "GootipBootstrapDiagnosticsPermissions"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_iam_role_policy_attachment" "bootstrap_diagnostics_permissions" {
  role       = aws_iam_role.bootstrap_admin.name
  policy_arn = aws_iam_policy.bootstrap_diagnostics_permissions.arn
}
