variables {
  deployment_application_client_security_group_id = "sg-0123456789abcdef0"
  deployment_db_tunnel_ami_id                     = "ami-0123456789abcdef0"
  deployment_db_tunnel_subnet_id                  = "subnet-0123456789abcdef0"
}

variable "aws_account_id" {
  type = string
}

# First reviewed apply: temporary name-and-tag-constrained CreateSecret plus the
# two empty containers. No value may be loaded.
run "container_creation_phase_grants_only_constrained_create_secret" {
  command = plan

  variables {
    eligibility_gate_passed                   = true
    account_resource_phase_enabled            = true
    role_secret_creation_enabled              = true
    database_operator_secret_creation_enabled = true
  }

  assert {
    condition = (
      aws_secretsmanager_secret.auth_runtime[0].name == "gootip-dev-auth-runtime" &&
      aws_secretsmanager_secret.auth_migrator[0].name == "gootip-dev-auth-migrator" &&
      aws_secretsmanager_secret.database_operator[0].name == "gootip-dev-db-operator"
    )
    error_message = "The three role-secret containers must use the exact reviewed names."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.role_secret_creation[0].json).Statement : statement
        if statement.Sid == "CreateExactRoleSecretContainers"
      ]).Action == "secretsmanager:CreateSecret" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.role_secret_creation[0].json).Statement : statement
        if statement.Sid == "CreateExactRoleSecretContainers"
      ]).Resource == "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:gootip-dev-auth-*"
    )
    error_message = "Container creation must grant CreateSecret only for the reviewed role-secret name pattern."
  }

  assert {
    condition = (
      length(one([
        for statement in jsondecode(data.aws_iam_policy_document.role_secret_creation[0].json).Statement : statement
        if statement.Sid == "CreateExactRoleSecretContainers"
      ]).Condition.StringEquals["secretsmanager:Name"]) == 2 &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.role_secret_creation[0].json).Statement : statement
        if statement.Sid == "CreateExactRoleSecretContainers"
      ]).Condition.StringEquals["aws:RequestTag/managed_by"] == "terraform"
    )
    error_message = "CreateSecret must be constrained by the two exact names and the required Gootip tags."
  }

  # The manual-value expansion must stay closed: with the temporary CreateSecret
  # grant active, no reviewed role ARN exists, so the policy cannot grant
  # GetSecretValue or PutSecretValue on the containers this apply creates.
  assert {
    condition     = local.role_secret_arns_approved == false && local.database_operator_secret_approved == false
    error_message = "The manual-value expansion must stay closed while a temporary CreateSecret grant is active."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.database_operator_secret_creation[0].json).Statement : statement
        if statement.Sid == "CreateExactDatabaseOperatorSecret"
      ]).Action == "secretsmanager:CreateSecret" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.database_operator_secret_creation[0].json).Statement : statement
        if statement.Sid == "CreateExactDatabaseOperatorSecret"
      ]).Resource == "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:gootip-dev-db-operator-*" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.database_operator_secret_creation[0].json).Statement : statement
        if statement.Sid == "CreateExactDatabaseOperatorSecret"
      ]).Condition.StringEquals["secretsmanager:Name"] == "gootip-dev-db-operator"
    )
    error_message = "Operator container creation must grant CreateSecret only for the exact gootip-dev-db-operator name and pattern."
  }

  # The creation-API exception must require the exact container Name request tag
  # and must refuse a request that omits aws:TagKeys entirely.
  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.database_operator_secret_creation[0].json).Statement : statement
        if statement.Sid == "CreateExactDatabaseOperatorSecret"
      ]).Condition.StringEquals["aws:RequestTag/Name"] == "gootip-dev-db-operator" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.database_operator_secret_creation[0].json).Statement : statement
        if statement.Sid == "CreateExactDatabaseOperatorSecret"
      ]).Condition.Null["aws:TagKeys"] == "false"
    )
    error_message = "Operator CreateSecret must require the exact Name request tag and Null aws:TagKeys = false."
  }
}

# Second reviewed apply: CreateSecret is gone, the manual-value expansion opens
# for both role containers, the runtime boundary names the approved ARNs, and
# the RDS master-secret denial is preserved.
run "second_apply_removes_create_secret_and_scopes_approved_arns" {
  command = plan

  variables {
    eligibility_gate_passed        = true
    account_resource_phase_enabled = true
    role_secret_creation_enabled   = false
    application_secret_arn         = "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:gootip-auth-dev-Xy99Zz"
    rds_master_secret_arn          = "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:rds!db-example-Def123"
    auth_runtime_secret_arn        = "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:gootip-dev-auth-runtime-Ab12Cd"
    auth_migrator_secret_arn       = "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:gootip-dev-auth-migrator-Ef34Gh"
    db_operator_secret_arn         = "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:gootip-dev-db-operator-Ij5Kl6"
  }

  assert {
    condition = (
      length(aws_iam_role_policy.role_secret_creation) == 0 &&
      length(aws_iam_role_policy.database_operator_secret_creation) == 0
    )
    error_message = "The temporary CreateSecret grants must be removed as soon as the containers exist."
  }

  # The permissions policy cannot be asserted at plan time: it names the
  # application container ARN, which is unknown until this apply runs. Its final
  # shape is verified against the applied policy in the operator procedure
  # documented in bootstrap/README.md ("SPEC 03 role-secret transition").
  assert {
    condition     = local.role_secret_arns_approved == true && local.database_operator_secret_approved == true
    error_message = "The manual-value expansion must open once every reviewed secret ARN is supplied."
  }

  assert {
    condition = toset(one([
      for statement in jsondecode(data.aws_iam_policy_document.application_runtime_boundary.json).Statement : statement
      if statement.Sid == "AllowOnlyExactRuntimeSecrets"
      ]).Resource) == toset([
      var.application_secret_arn,
      var.rds_master_secret_arn,
      var.auth_runtime_secret_arn,
      var.auth_migrator_secret_arn,
      var.db_operator_secret_arn,
    ])
    error_message = "The runtime boundary must allow and deny reads for exactly the same approved secret ARNs."
  }

  assert {
    condition = toset(one([
      for statement in jsondecode(data.aws_iam_policy_document.application_runtime_boundary.json).Statement : statement
      if statement.Sid == "DenyEveryOtherSecret"
      ]).NotResource) == toset([
      var.application_secret_arn,
      var.rds_master_secret_arn,
      var.auth_runtime_secret_arn,
      var.auth_migrator_secret_arn,
      var.db_operator_secret_arn,
    ])
    error_message = "The runtime boundary deny must use the same exact ARNs as the allow."
  }
}

# The temporary CreateSecret grant and manual value access must never coexist:
# supplying the reviewed ARNs while the creation flag is still true must fail the
# plan instead of silently granting both.
run "creation_grant_and_supplied_arns_must_not_coexist" {
  command = plan

  variables {
    eligibility_gate_passed        = true
    account_resource_phase_enabled = true
    role_secret_creation_enabled   = true
    auth_runtime_secret_arn        = "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:gootip-dev-auth-runtime-Ab12Cd"
    auth_migrator_secret_arn       = "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:gootip-dev-auth-migrator-Ef34Gh"
  }

  expect_failures = [data.aws_iam_policy_document.bootstrap_application_secret_permissions]
}

# SPEC 05.1: the operator container follows the same rule with its own temporary
# grant, so supplying its ARN while database_operator_secret_creation_enabled is
# true must fail instead of granting CreateSecret and value access together.
run "operator_creation_grant_and_supplied_arn_must_not_coexist" {
  command = plan

  variables {
    eligibility_gate_passed                   = true
    account_resource_phase_enabled            = true
    database_operator_secret_creation_enabled = true
    db_operator_secret_arn                    = "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:gootip-dev-db-operator-Ij5Kl6"
  }

  expect_failures = [data.aws_iam_policy_document.bootstrap_application_secret_permissions]
}
