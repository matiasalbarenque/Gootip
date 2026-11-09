variables {
  deployment_application_client_security_group_id = "sg-0123456789abcdef0"
  deployment_db_tunnel_ami_id                     = "ami-0123456789abcdef0"
  deployment_db_tunnel_subnet_id                  = "subnet-0123456789abcdef0"
}

variable "aws_account_id" {
  type = string
}

run "credential_roles_are_disabled_by_default" {
  command = plan

  assert {
    condition = (
      length(aws_iam_role.credential_provisioner) == 0 &&
      length(aws_iam_role.credential_operator) == 0 &&
      length(aws_iam_role_policy.credential_role_lifecycle) == 0 &&
      !contains(flatten([for statement in jsondecode(data.aws_iam_policy_document.source_user_assume_only.json).Statement : statement.Resource]), local.credential_provisioner_role_arn) &&
      !contains(flatten([for statement in jsondecode(data.aws_iam_policy_document.source_user_assume_only.json).Statement : statement.Resource]), local.credential_operator_role_arn)
    )
    error_message = "Credential roles and source-user assume grants must remain absent by default."
  }
}

run "credential_roles_use_exact_secret_arns_and_mfa_trust" {
  command = plan

  variables {
    eligibility_gate_passed             = true
    account_resource_phase_enabled      = true
    credential_role_lifecycle_enabled   = true
    credential_provisioner_role_enabled = true
    credential_operator_role_enabled    = true
    rds_master_secret_arn               = "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:rds!db-example-a1b2c3"
    auth_runtime_secret_arn             = "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:gootip-dev-auth-runtime-Ab1Cd2"
    core_runtime_secret_arn             = "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:gootip-dev-core-runtime-Ab1Cd2"
  }

  assert {
    condition = (
      aws_iam_role.credential_provisioner[0].path == "/gootip/operations/" &&
      aws_iam_role.credential_operator[0].path == "/gootip/operations/" &&
      aws_iam_role.credential_provisioner[0].max_session_duration == 3600 &&
      aws_iam_role.credential_operator[0].max_session_duration == 3600 &&
      contains(flatten([for statement in jsondecode(data.aws_iam_policy_document.source_user_assume_only.json).Statement : statement.Resource]), local.credential_provisioner_role_arn) &&
      contains(flatten([for statement in jsondecode(data.aws_iam_policy_document.source_user_assume_only.json).Statement : statement.Resource]), local.credential_operator_role_arn)
    )
    error_message = "Both credential roles must have the reviewed path/session and explicit source-user allowlisting."
  }

  assert {
    condition = (
      toset(one(jsondecode(data.aws_iam_policy_document.credential_provisioner_permissions[0].json).Statement).Action) == toset(["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]) &&
      one(jsondecode(data.aws_iam_policy_document.credential_provisioner_permissions[0].json).Statement).Resource == var.rds_master_secret_arn &&
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.credential_operator_permissions[0].json).Statement : statement if statement.Sid == "OperateOnlyExactRuntimeSecrets"]).Action) == toset(["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"]) &&
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.credential_operator_permissions[0].json).Statement : statement if statement.Sid == "OperateOnlyExactRuntimeSecrets"]).Resource) == toset([var.auth_runtime_secret_arn, var.core_runtime_secret_arn]) &&
      one([for statement in jsondecode(data.aws_iam_policy_document.credential_operator_permissions[0].json).Statement : statement if statement.Sid == "DescribeExactDevDatabase"]).Action == "rds:DescribeDBInstances" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.credential_operator_permissions[0].json).Statement : statement if statement.Sid == "DescribeExactDevDatabase"]).Resource == local.application_database_arn &&
      toset([for statement in jsondecode(data.aws_iam_policy_document.credential_operator_permissions[0].json).Statement : statement.Sid]) == toset(["OperateOnlyExactRuntimeSecrets", "DescribeExactDevDatabase"])
    )
    error_message = "Credential policies must contain only the reviewed actions and exact secret ARNs."
  }

  assert {
    condition = (
      toset([for statement in jsondecode(data.aws_iam_policy_document.credential_role_lifecycle[0].json).Statement : statement.Sid]) == toset([
        "ManageExactCredentialProvisionerRole",
        "ManageExactCredentialProvisionerPolicy",
        "ManageExactCredentialOperatorRole",
        "ManageExactCredentialOperatorPolicy",
      ]) &&
      one([for statement in jsondecode(data.aws_iam_policy_document.credential_role_lifecycle[0].json).Statement : statement if statement.Sid == "ManageExactCredentialProvisionerRole"]).Resource == local.credential_provisioner_role_arn &&
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.credential_role_lifecycle[0].json).Statement : statement if statement.Sid == "ManageExactCredentialProvisionerRole"]).Action) == toset(["iam:AttachRolePolicy", "iam:CreateRole", "iam:DeleteRole", "iam:DetachRolePolicy", "iam:GetRole", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole", "iam:ListRolePolicies", "iam:TagRole", "iam:UntagRole", "iam:UpdateAssumeRolePolicy", "iam:UpdateRole"]) &&
      contains(one([for statement in jsondecode(data.aws_iam_policy_document.credential_role_lifecycle[0].json).Statement : statement if statement.Sid == "ManageExactCredentialProvisionerRole"]).Action, "iam:ListInstanceProfilesForRole") &&
      one([for statement in jsondecode(data.aws_iam_policy_document.credential_role_lifecycle[0].json).Statement : statement if statement.Sid == "ManageExactCredentialProvisionerPolicy"]).Resource == local.credential_provisioner_policy_arn &&
      one([for statement in jsondecode(data.aws_iam_policy_document.credential_role_lifecycle[0].json).Statement : statement if statement.Sid == "ManageExactCredentialOperatorRole"]).Resource == local.credential_operator_role_arn &&
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.credential_role_lifecycle[0].json).Statement : statement if statement.Sid == "ManageExactCredentialOperatorRole"]).Action) == toset(["iam:AttachRolePolicy", "iam:CreateRole", "iam:DeleteRole", "iam:DetachRolePolicy", "iam:GetRole", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole", "iam:ListRolePolicies", "iam:TagRole", "iam:UntagRole", "iam:UpdateAssumeRolePolicy", "iam:UpdateRole"]) &&
      contains(one([for statement in jsondecode(data.aws_iam_policy_document.credential_role_lifecycle[0].json).Statement : statement if statement.Sid == "ManageExactCredentialOperatorRole"]).Action, "iam:ListInstanceProfilesForRole") &&
      one([for statement in jsondecode(data.aws_iam_policy_document.credential_role_lifecycle[0].json).Statement : statement if statement.Sid == "ManageExactCredentialOperatorPolicy"]).Resource == local.credential_operator_policy_arn
    )
    error_message = "Bootstrap's temporary credential lifecycle policy must cover only the two exact role and policy ARNs."
  }

  assert {
    condition = (
      length(data.aws_iam_policy_document.bootstrap_policy_admin_permissions.json) < 6144 &&
      length(data.aws_iam_policy_document.credential_role_lifecycle[0].json) < 10240
    )
    error_message = "Credential-role lifecycle policy documents must stay within IAM size quotas."
  }
}

run "credential_lifecycle_permission_first_phase_creates_no_access_role" {
  command = plan

  variables {
    eligibility_gate_passed           = true
    account_resource_phase_enabled    = true
    credential_role_lifecycle_enabled = true
  }

  assert {
    condition = (
      length(aws_iam_role_policy.credential_role_lifecycle) == 1 &&
      length(aws_iam_role.credential_provisioner) == 0 &&
      length(aws_iam_role.credential_operator) == 0 &&
      !contains(flatten([for statement in jsondecode(data.aws_iam_policy_document.source_user_assume_only.json).Statement : statement.Resource]), local.credential_provisioner_role_arn) &&
      !contains(flatten([for statement in jsondecode(data.aws_iam_policy_document.source_user_assume_only.json).Statement : statement.Resource]), local.credential_operator_role_arn)
    )
    error_message = "The permission-first phase must add only exact bootstrap lifecycle permissions, not create or expose either credential role."
  }
}

run "human_roles_require_recent_mfa" {
  command = plan

  assert {
    condition     = aws_iam_role.bootstrap_admin.path == "/gootip/bootstrap/" && aws_iam_role.bootstrap_admin.max_session_duration == 3600
    error_message = "The bootstrap role must use its exact path and one-hour maximum session."
  }

  assert {
    condition     = aws_iam_role.terraform_deploy.path == "/gootip/deployment/" && aws_iam_role.terraform_deploy.max_session_duration == 3600
    error_message = "The deployment role must use its exact path and one-hour maximum session."
  }

  assert {
    condition     = aws_iam_role.database_operator.path == "/gootip/operations/" && aws_iam_role.database_operator.max_session_duration == 3600
    error_message = "The database operator must use the exact operations path and one-hour maximum session."
  }

  assert {
    condition = (
      jsondecode(data.aws_iam_policy_document.human_role_trust.json).Statement[0].Condition.Bool["aws:MultiFactorAuthPresent"] == "true" &&
      jsondecode(data.aws_iam_policy_document.human_role_trust.json).Statement[0].Condition.NumericLessThanEquals["aws:MultiFactorAuthAge"] == "10800" &&
      jsondecode(data.aws_iam_policy_document.human_role_trust.json).Statement[0].Principal.AWS == "arn:aws:iam::${var.aws_account_id}:user/gootip"
    )
    error_message = "Human-role trust must require present MFA no older than three hours."
  }
}

run "bootstrap_rds_service_linked_role_exception_is_exact" {
  command = plan

  variables {
    account_resource_phase_enabled = false
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_permissions.json).Statement : statement
        if statement.Sid == "ReadExactRdsServiceLinkedRole"
      ]).Action == "iam:GetRole" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_permissions.json).Statement : statement
        if statement.Sid == "ReadExactRdsServiceLinkedRole"
      ]).Resource == "arn:aws:iam::${var.aws_account_id}:role/aws-service-role/rds.amazonaws.com/AWSServiceRoleForRDS"
    )
    error_message = "Bootstrap may read only the exact AWSServiceRoleForRDS role."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_permissions.json).Statement : statement
        if statement.Sid == "CreateExactRdsServiceLinkedRole"
      ]).Action == "iam:CreateServiceLinkedRole" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_permissions.json).Statement : statement
        if statement.Sid == "CreateExactRdsServiceLinkedRole"
      ]).Resource == "arn:aws:iam::${var.aws_account_id}:role/aws-service-role/rds.amazonaws.com/AWSServiceRoleForRDS" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_permissions.json).Statement : statement
        if statement.Sid == "CreateExactRdsServiceLinkedRole"
      ]).Condition.StringEquals["iam:AWSServiceName"] == "rds.amazonaws.com"
    )
    error_message = "Bootstrap may create only the RDS service-linked role for rds.amazonaws.com."
  }
}

run "bootstrap_kms_alias_diagnosis_is_read_only_and_regional" {
  command = plan

  variables {
    account_resource_phase_enabled = false
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_permissions.json).Statement : statement
        if statement.Sid == "ListKmsAliasesInFoundationRegion"
      ]).Action == "kms:ListAliases" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_permissions.json).Statement : statement
        if statement.Sid == "ListKmsAliasesInFoundationRegion"
      ]).Resource == "*" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_permissions.json).Statement : statement
        if statement.Sid == "ListKmsAliasesInFoundationRegion"
      ]).Condition.StringEquals["aws:RequestedRegion"] == "us-east-2"
    )
    error_message = "KMS diagnosis must be limited to regional ListAliases and must not grant KMS writes."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_permissions.json).Statement : statement
        if statement.Sid == "DescribeExactRdsManagedKmsKey"
      ]).Action == "kms:DescribeKey" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_permissions.json).Statement : statement
        if statement.Sid == "DescribeExactRdsManagedKmsKey"
      ]).Resource == "arn:aws:kms:us-east-2:${var.aws_account_id}:key/e0638b06-ad54-4317-9670-694aaa5fc422"
    )
    error_message = "KMS diagnosis must describe only the exact RDS-managed key."
  }
}

run "db_config_operator_invocation_is_temporary_and_exact" {
  command = plan

  variables {
    account_resource_phase_enabled        = false
    db_config_operator_invocation_enabled = true
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_permissions.json).Statement : statement
        if statement.Sid == "InvokeExactDbConfigBootstrap"
      ]).Action == "lambda:InvokeFunction" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_permissions.json).Statement : statement
        if statement.Sid == "InvokeExactDbConfigBootstrap"
      ]).Resource == "arn:aws:lambda:us-east-2:${var.aws_account_id}:function:lambda_db_config"
    )
    error_message = "The temporary SPEC 03 operator grant must invoke only the exact unqualified db-config Lambda."
  }
}

run "bootstrap_split_policy_lifecycle_is_exact" {
  command = plan

  variables {
    account_resource_phase_enabled = false
  }

  assert {
    condition = toset(one([
      for statement in jsondecode(data.aws_iam_policy_document.bootstrap_policy_admin_permissions.json).Statement : statement
      if statement.Sid == "ManageExactHumanRolesAndPolicies"
      ]).Resource) == toset([
      "arn:aws:iam::${var.aws_account_id}:role/gootip/bootstrap/GootipBootstrapAdmin",
      "arn:aws:iam::${var.aws_account_id}:role/gootip/deployment/GootipTerraformDeploy",
      "arn:aws:iam::${var.aws_account_id}:policy/gootip/bootstrap/GootipBootstrapAdminPermissions",
      "arn:aws:iam::${var.aws_account_id}:policy/gootip/bootstrap/GootipBootstrapPolicyAdminPermissions",
      "arn:aws:iam::${var.aws_account_id}:policy/gootip/bootstrap/GootipBootstrapStatePermissions",
      "arn:aws:iam::${var.aws_account_id}:policy/gootip/bootstrap/GootipBootstrapDiagnosticsPermissions",
      "arn:aws:iam::${var.aws_account_id}:policy/gootip/deployment/GootipTerraformDeployPermissions",
      "arn:aws:iam::${var.aws_account_id}:policy/gootip/deployment/GootipTerraformDeployAdministrativePassRole",
      "arn:aws:iam::${var.aws_account_id}:policy/gootip/deployment/GootipTerraformDeployNetworkPermissions",
      "arn:aws:iam::${var.aws_account_id}:policy/gootip/deployment/GootipTerraformDeployDatabasePermissions",
      "arn:aws:iam::${var.aws_account_id}:policy/gootip/deployment/GootipTerraformDeployDbConfigPermissions",
      "arn:aws:iam::${var.aws_account_id}:policy/gootip/deployment/GootipTerraformDeployAuthMigrationsPermissions",
      "arn:aws:iam::${var.aws_account_id}:policy/gootip/deployment/GootipTerraformDeployCoreMigrationsPermissions",
      "arn:aws:iam::${var.aws_account_id}:policy/gootip/bootstrap/GootipBootstrapDeploymentPolicyAdminPermissions",
      "arn:aws:iam::${var.aws_account_id}:policy/gootip/bootstrap/GootipApplicationRuntimeBoundary",
      "arn:aws:iam::${var.aws_account_id}:policy/gootip/bootstrap/GootipSourceUserAssumeOnlyBoundary",
      "arn:aws:iam::${var.aws_account_id}:policy/gootip/bootstrap/GootipSourceUserAssumeOnly",
    ])
    error_message = "The capability policy must cover only the exact Terraform-owned human roles and split policies."
  }

  assert {
    condition = !contains(one([
      for statement in jsondecode(data.aws_iam_policy_document.bootstrap_policy_admin_permissions.json).Statement : statement
      if statement.Sid == "ManageExactHumanRolesAndPolicies"
    ]).Action, "iam:CreatePolicy")
    error_message = "The shared role and policy lifecycle statement must not receive customer-managed policy creation permission."
  }

  assert {
    condition = (
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_deployment_policy_admin_permissions.json).Statement : statement
        if statement.Sid == "ManageExactDeploymentPolicies"
      ]).Action) == toset(["iam:CreatePolicy", "iam:CreatePolicyVersion", "iam:DeletePolicyVersion", "iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyVersions", "iam:SetDefaultPolicyVersion"]) &&
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_deployment_policy_admin_permissions.json).Statement : statement
        if statement.Sid == "ManageExactDeploymentPolicies"
        ]).Resource) == toset([
        local.deployment_pass_role_policy_arn,
        local.deployment_db_config_policy_arn,
        local.deployment_auth_migrations_policy_arn,
        local.deployment_core_migrations_policy_arn,
        local.deployment_observability_policy_arn,
        local.deployment_application_policy_arn,
        local.deployment_api_gateway_policy_arn,
      ]) &&
      contains(one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_deployment_policy_admin_permissions.json).Statement : statement
        if statement.Sid == "ManageExactDeploymentPolicyTags"
      ]).Resource, local.deployment_api_gateway_policy_arn) &&
      length(data.aws_iam_policy_document.bootstrap_deployment_policy_admin_permissions.json) < 6144 &&
      toset([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_policy_admin_permissions.json).Statement : statement.Sid
        if contains(flatten([statement.Action]), "iam:CreatePolicy")
      ]) == toset(["ManageExactDatabaseOperatorPolicy"])
    )
    error_message = "Bootstrap deployment-policy administration must cover only its exact capability and deployment-policy ARNs."
  }

  assert {
    condition = (
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_policy_admin_permissions.json).Statement : statement
        if statement.Sid == "ManageExactDatabaseOperatorRole"
        ]).Action) == toset([
        "iam:AttachRolePolicy",
        "iam:CreateRole",
        "iam:DetachRolePolicy",
        "iam:GetRole",
        "iam:ListAttachedRolePolicies",
        "iam:ListRolePolicies",
        "iam:TagRole",
        "iam:UpdateAssumeRolePolicy",
        "iam:UpdateRole",
      ]) &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_policy_admin_permissions.json).Statement : statement
        if statement.Sid == "ManageExactDatabaseOperatorRole"
      ]).Resource == "arn:aws:iam::${var.aws_account_id}:role/gootip/operations/GootipDatabaseOperator"
    )
    error_message = "The database-operator role lifecycle must be scoped to the exact operations role ARN."
  }

  assert {
    condition = (
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_policy_admin_permissions.json).Statement : statement
        if statement.Sid == "ManageExactDatabaseOperatorPolicy"
        ]).Action) == toset([
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
      ]) &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_policy_admin_permissions.json).Statement : statement
        if statement.Sid == "ManageExactDatabaseOperatorPolicy"
      ]).Resource == "arn:aws:iam::${var.aws_account_id}:policy/gootip/operations/GootipDatabaseOperatorPermissions"
    )
    error_message = "The database-operator policy lifecycle must be scoped to the exact operations policy ARN."
  }

  assert {
    condition = (
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_policy_admin_permissions.json).Statement : statement
        if statement.Sid == "ManageExactSplitPolicyTags"
      ]).Action) == toset(["iam:TagPolicy", "iam:UntagPolicy"]) &&
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_policy_admin_permissions.json).Statement : statement
        if statement.Sid == "ManageExactSplitPolicyTags"
        ]).Resource) == toset([
        "arn:aws:iam::${var.aws_account_id}:policy/gootip/bootstrap/GootipBootstrapStatePermissions",
        "arn:aws:iam::${var.aws_account_id}:policy/gootip/bootstrap/GootipBootstrapDiagnosticsPermissions",
        "arn:aws:iam::${var.aws_account_id}:policy/gootip/bootstrap/GootipBootstrapPolicyAdminPermissions",
        "arn:aws:iam::${var.aws_account_id}:policy/gootip/deployment/GootipTerraformDeployNetworkPermissions",
        "arn:aws:iam::${var.aws_account_id}:policy/gootip/deployment/GootipTerraformDeployDatabasePermissions",
        "arn:aws:iam::${var.aws_account_id}:policy/gootip/bootstrap/GootipBootstrapDeploymentPolicyAdminPermissions",
      ])
    )
    error_message = "Split-policy tag management must use only TagPolicy and UntagPolicy on the exact split policies."
  }

  assert {
    condition = (
      length(data.aws_iam_policy_document.bootstrap_policy_admin_permissions.json) < 6144 &&
      length(data.aws_iam_policy_document.bootstrap_deployment_policy_admin_permissions.json) < 6144
    )
    error_message = "Bootstrap policy-administration capabilities must remain within the IAM managed-policy size quota."
  }

  assert {
    condition = length([
      for statement in jsondecode(data.aws_iam_policy_document.bootstrap_permissions.json).Statement : statement
      if contains(flatten([statement.Action]), "iam:CreatePolicy")
    ]) == 0
    error_message = "The retained core must not carry any iam:CreatePolicy without the temporary split-creation flag."
  }

  # The default standing core must carry none of the transition-only creation,
  # retirement, or legacy lifecycle grants; cleanup removes those without
  # changing the permanent policy-administration capabilities.
  assert {
    condition = length([
      for statement in jsondecode(data.aws_iam_policy_document.bootstrap_permissions.json).Statement : statement
      if contains([
        "CreateExactSplitPolicies",
        "ReadExactFoundationRetirementTargets",
        "DeleteExactRetiredFoundationReadPolicy",
        "ManageExactHumanRolesAndPolicies",
        "ManageExactSplitPolicyTags",
        "CreateExactAdministrativePassRolePolicy",
      ], statement.Sid)
    ]) == 0
    error_message = "The standing core must not retain any temporary creation, retirement, or transition lifecycle statement."
  }

  # Apply C must not remove anything else: every remaining core statement is a
  # standing grant that predates SPEC 03.1 and has its own assertion elsewhere.
  assert {
    condition = length(jsondecode(data.aws_iam_policy_document.bootstrap_permissions.json).Statement) == length(distinct([
      for statement in jsondecode(data.aws_iam_policy_document.bootstrap_permissions.json).Statement : statement.Sid
    ]))
    error_message = "The retained core must not contain duplicate statement IDs that would mask a partial removal."
  }
}

run "bootstrap_split_creation_grant_is_temporary_and_exact" {
  command = plan

  variables {
    eligibility_gate_passed        = true
    account_resource_phase_enabled = true
    split_policy_creation_enabled  = true
  }

  assert {
    condition = (
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_split_policy_creation[0].json).Statement : statement
        if statement.Sid == "CreateExactSplitPolicies"
      ]).Action) == toset(["iam:CreatePolicy", "iam:ListPolicyTags", "iam:TagPolicy", "iam:UntagPolicy"]) &&
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_split_policy_creation[0].json).Statement : statement
        if statement.Sid == "CreateExactSplitPolicies"
        ]).Resource) == toset([
        "arn:aws:iam::${var.aws_account_id}:policy/gootip/bootstrap/GootipBootstrapPolicyAdminPermissions",
        "arn:aws:iam::${var.aws_account_id}:policy/gootip/deployment/GootipTerraformDeployNetworkPermissions",
        "arn:aws:iam::${var.aws_account_id}:policy/gootip/deployment/GootipTerraformDeployDatabasePermissions",
        "arn:aws:iam::${var.aws_account_id}:policy/gootip/deployment/GootipTerraformDeployApplicationPermissions",
        "arn:aws:iam::${var.aws_account_id}:policy/gootip/deployment/GootipTerraformDeployApiGatewayPermissions",
        "arn:aws:iam::${var.aws_account_id}:policy/gootip/bootstrap/GootipBootstrapDeploymentPolicyAdminPermissions",
      ]) &&
      length(data.aws_iam_policy_document.bootstrap_split_policy_creation[0].json) < 6144 &&
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_split_policy_creation[0].json).Statement : statement
        if statement.Sid == "ReadExactFoundationRetirementTargets"
      ]).Action) == toset(["iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyTags"]) &&
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_split_policy_creation[0].json).Statement : statement
        if statement.Sid == "ReadExactFoundationRetirementTargets"
        ]).Resource) == toset([
        "arn:aws:iam::${var.aws_account_id}:policy/gootip/deployment/GootipTerraformDeployFoundationReadPermissions",
        "arn:aws:iam::${var.aws_account_id}:policy/gootip/deployment/GootipTerraformDeployObservabilityPermissions",
      ]) &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_split_policy_creation[0].json).Statement : statement
        if statement.Sid == "DeleteExactRetiredFoundationReadPolicy"
      ]).Action == "iam:DeletePolicy" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_split_policy_creation[0].json).Statement : statement
        if statement.Sid == "DeleteExactRetiredFoundationReadPolicy"
      ]).Resource == "arn:aws:iam::${var.aws_account_id}:policy/gootip/deployment/GootipTerraformDeployFoundationReadPermissions" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_split_policy_creation[0].json).Statement : statement
        if statement.Sid == "ListVersionsExactRetiredFoundationReadPolicy"
      ]).Action == "iam:ListPolicyVersions" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_split_policy_creation[0].json).Statement : statement
        if statement.Sid == "ListVersionsExactRetiredFoundationReadPolicy"
      ]).Resource == "arn:aws:iam::${var.aws_account_id}:policy/gootip/deployment/GootipTerraformDeployFoundationReadPermissions" &&
      # The admin must keep iam:AttachRolePolicy while the capability is absent,
      # but only by retaining ManageExactHumanRolesAndPolicies: that single
      # statement also carries iam:CreatePolicyVersion, which apply B needs to
      # update GootipTerraformDeployPermissions. Retaining the other two lifecycle
      # statements as well rendered the core at 6192 characters, over the 6144
      # AWS quota, so apply A must drop them and the temporary document must not
      # carry them.
      toset([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_split_policy_creation[0].json).Statement : statement.Sid
        ]) == toset([
        "CreateExactSplitPolicies",
        "ReadExactFoundationRetirementTargets",
        "DeleteExactRetiredFoundationReadPolicy",
        "ListVersionsExactRetiredFoundationReadPolicy",
      ])
    )
    error_message = "Temporary policy creation and retirement grants must remain limited to exact reviewed policy ARNs and disappear when split_policy_creation_enabled is false."
  }
}

run "bootstrap_cloudtrail_diagnosis_is_read_only_and_regional" {
  command = plan

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_diagnostics_permissions.json).Statement : statement
        if statement.Sid == "LookupFoundationCloudTrailEventsInRegion"
      ]).Action == "cloudtrail:LookupEvents" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_diagnostics_permissions.json).Statement : statement
        if statement.Sid == "LookupFoundationCloudTrailEventsInRegion"
      ]).Resource == "*" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_diagnostics_permissions.json).Statement : statement
        if statement.Sid == "LookupFoundationCloudTrailEventsInRegion"
      ]).Condition.StringEquals["aws:RequestedRegion"] == "us-east-2"
    )
    error_message = "CloudTrail diagnosis must be limited to regional LookupEvents and must not grant writes."
  }

  assert {
    condition = (
      aws_iam_role_policy_attachment.bootstrap_diagnostics_permissions.role == "GootipBootstrapAdmin" &&
      aws_iam_policy.bootstrap_diagnostics_permissions.name == "GootipBootstrapDiagnosticsPermissions" &&
      aws_iam_policy.bootstrap_diagnostics_permissions.path == "/gootip/bootstrap/"
    )
    error_message = "Diagnostics permissions must target GootipBootstrapAdmin and use the exact bootstrap policy name and path."
  }
}

run "deployment_rds_and_state_access_are_exact" {
  command = plan

  variables {
    eligibility_gate_passed             = true
    account_resource_phase_enabled      = true
    foundation_policy_expansion_enabled = true
    secrets_manager_kms_key_arn         = "arn:aws:kms:us-east-2:${var.aws_account_id}:key/00000000-0000-0000-0000-000000000000"
  }

  assert {
    condition = (
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement
        if statement.Sid == "AllowRdsEngineAndOrderableDiscovery"
      ]).Action) == toset(["rds:DescribeDBEngineVersions", "rds:DescribeOrderableDBInstanceOptions"]) &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement
        if statement.Sid == "AllowRdsEngineAndOrderableDiscovery"
      ]).Resource == "*" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement
        if statement.Sid == "AllowRdsEngineAndOrderableDiscovery"
      ]).Condition.StringEquals["aws:RequestedRegion"] == "us-east-2"
    )
    error_message = "Only the documented RDS discovery statement may use a wildcard resource."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement
        if statement.Sid == "DiscoverGootipRdsInstancesInRegion"
      ]).Action == "rds:DescribeDBInstances" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement
        if statement.Sid == "DiscoverGootipRdsInstancesInRegion"
      ]).Resource == "arn:aws:rds:us-east-2:${var.aws_account_id}:db:*"
    )
    error_message = "DescribeDBInstances must be limited to RDS instances in the configured account and Region."
  }

  assert {
    condition = toset(one([
      for statement in jsondecode(data.aws_iam_policy_document.bootstrap_state_permissions.json).Statement : statement
      if statement.Sid == "RestoreOnlyApprovedStateObjects"
      ]).Resource) == toset([
      "arn:aws:s3:::gootip-terraform-state-${var.aws_account_id}/bootstrap/terraform.tfstate",
      "arn:aws:s3:::gootip-terraform-state-${var.aws_account_id}/gootip/dev/terraform.tfstate",
    ])
    error_message = "Bootstrap recovery must restore only the two approved state objects."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_state_permissions.json).Statement : statement
        if statement.Sid == "ReadExactStateBucketExistence"
      ]).Action == "s3:ListBucket" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_state_permissions.json).Statement : statement
        if statement.Sid == "ReadExactStateBucketExistence"
      ]).Resource == "arn:aws:s3:::gootip-terraform-state-${var.aws_account_id}"
    )
    error_message = "Bootstrap HeadBucket authorization must remain limited to the exact state bucket."
  }

  assert {
    condition = (
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_state_permissions.json).Statement : statement
        if statement.Sid == "ReadExactStateBucketConfiguration"
        ]).Action) == toset([
        "s3:GetAccelerateConfiguration",
        "s3:GetBucketAcl",
        "s3:GetBucketCORS",
        "s3:GetLifecycleConfiguration",
        "s3:GetBucketLocation",
        "s3:GetBucketLogging",
        "s3:GetBucketOwnershipControls",
        "s3:GetBucketPolicy",
        "s3:GetBucketPublicAccessBlock",
        "s3:GetReplicationConfiguration",
        "s3:GetBucketRequestPayment",
        "s3:GetBucketTagging",
        "s3:GetBucketVersioning",
        "s3:GetBucketWebsite",
        "s3:GetEncryptionConfiguration",
        "s3:GetBucketObjectLockConfiguration",
      ]) &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_state_permissions.json).Statement : statement
        if statement.Sid == "ReadExactStateBucketConfiguration"
      ]).Resource == "arn:aws:s3:::gootip-terraform-state-${var.aws_account_id}"
    )
    error_message = "Provider-refresh reads must stay limited to the exact state bucket."
  }

  # SPEC 02.1 amendment. Access Analyzer ValidatePolicy proved the previous
  # s3:PutBucketEncryption entry an INVALID_ACTION: the PutBucketEncryption API
  # authorizes against s3:PutEncryptionConfiguration, so the old name granted
  # nothing at all. The statement must carry the valid action inside exactly the
  # reviewed action set, and no other action may change with it.
  assert {
    condition = toset(one([
      for statement in jsondecode(data.aws_iam_policy_document.bootstrap_state_permissions.json).Statement : statement
      if statement.Sid == "ManageExactStateBucketConfiguration"
      ]).Action) == toset([
      "s3:PutBucketVersioning",
      "s3:PutBucketPublicAccessBlock",
      "s3:PutBucketPolicy",
      "s3:PutBucketOwnershipControls",
      "s3:PutEncryptionConfiguration",
      "s3:GetEncryptionConfiguration",
      "s3:GetBucketVersioning",
      "s3:GetBucketPublicAccessBlock",
      "s3:GetBucketPolicy",
      "s3:GetBucketOwnershipControls",
      "s3:GetBucketAcl",
      "s3:DeleteBucketPolicy",
    ])
    error_message = "State bucket configuration management must carry s3:PutEncryptionConfiguration inside exactly the reviewed action set."
  }

  # The rejected half of the same contract: IAM ignores action names it does not
  # know, so the invalid entry silently granted no encryption-config write while
  # looking authoritative in the policy document.
  assert {
    condition = !contains(one([
      for statement in jsondecode(data.aws_iam_policy_document.bootstrap_state_permissions.json).Statement : statement
      if statement.Sid == "ManageExactStateBucketConfiguration"
    ]).Action, "s3:PutBucketEncryption")
    error_message = "The invalid s3:PutBucketEncryption action must never reappear; Access Analyzer reports it as INVALID_ACTION."
  }

  assert {
    condition = toset(one([
      for statement in jsondecode(data.aws_iam_policy_document.deployment_permissions.json).Statement : statement
      if statement.Sid == "AllowApplicationStateReadWrite"
    ]).Action) == toset(["s3:GetObject", "s3:PutObject"])
    error_message = "Deployment state access must not allow deletion."
  }

  assert {
    condition = one([
      for statement in jsondecode(data.aws_iam_policy_document.deployment_permissions.json).Statement : statement
      if statement.Sid == "AllowApplicationLockOnly"
    ]).Resource == "arn:aws:s3:::gootip-terraform-state-${var.aws_account_id}/gootip/dev/terraform.tfstate.tflock"
    error_message = "Deployment lock access must target only the canonical application lock object."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_permissions.json).Statement : statement
        if statement.Sid == "AllowApplicationStateOnly"
      ]).Condition.StringEquals["s3:ResourceAccount"] == var.aws_account_id &&
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_permissions.json).Statement : statement
        if statement.Sid == "AllowApplicationStateOnly"
      ]).Condition.StringEquals["s3:prefix"]) == toset(["gootip/dev/terraform.tfstate", "gootip/dev/terraform.tfstate.tflock"])
    )
    error_message = "Deployment bucket listing must remain account- and application-prefix-scoped."
  }

  assert {
    condition = (
      contains(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "ReadAndAssociateFoundationNetworkResources"
      ]).Action, "ec2:DescribeAvailabilityZones") &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "ReadAndAssociateFoundationNetworkResources"
      ]).Resource == "*" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "ReadAndAssociateFoundationNetworkResources"
      ]).Condition.StringEquals["aws:RequestedRegion"] == "us-east-2"
    )
    error_message = "Network reads and Availability Zone discovery must stay Region-scoped and use only unavoidable wildcard resources."
  }

  assert {
    condition = (
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_foundation_read_permissions[0].json).Statement : statement
        if statement.Sid == "ReadFreeTierEligibilityAndUsage"
        ]).Action) == toset([
        "freetier:GetAccountPlanState",
        "freetier:GetFreeTierUsage",
      ]) &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_foundation_read_permissions[0].json).Statement : statement
        if statement.Sid == "ReadFreeTierEligibilityAndUsage"
      ]).Resource == "*" &&
      !contains(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_foundation_read_permissions[0].json).Statement : statement
        if statement.Sid == "ReadFreeTierEligibilityAndUsage"
      ]).Action, "freetier:UpgradeAccountPlan")
    )
    error_message = "Free Tier access must remain limited to the two required read-only actions."
  }
}

run "postgresql_18_upgrade_capability_is_exact" {
  command = plan

  variables {
    eligibility_gate_passed             = true
    account_resource_phase_enabled      = true
    foundation_policy_expansion_enabled = true
    secrets_manager_kms_key_arn         = "arn:aws:kms:us-east-2:${var.aws_account_id}:key/00000000-0000-0000-0000-000000000000"
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement
        if statement.Sid == "ModifyExactGootipRdsInstanceForUpgrade"
      ]).Action == "rds:ModifyDBInstance" &&
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement
        if statement.Sid == "ModifyExactGootipRdsInstanceForUpgrade"
        ]).Resource) == toset([
        "arn:aws:rds:us-east-2:${var.aws_account_id}:db:gootip-dev",
        "arn:aws:rds:us-east-2:${var.aws_account_id}:pg:gootip-dev-postgres18",
      ])
    )
    error_message = "The upgrade policy may modify only the exact gootip-dev RDS instance and its PostgreSQL 18 parameter group association."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement
        if statement.Sid == "CreateExactGootipPreUpgradeSnapshot"
      ]).Action == "rds:CreateDBSnapshot" &&
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement
        if statement.Sid == "CreateExactGootipPreUpgradeSnapshot"
        ]).Resource) == toset([
        "arn:aws:rds:us-east-2:${var.aws_account_id}:db:gootip-dev",
        "arn:aws:rds:us-east-2:${var.aws_account_id}:snapshot:gootip-dev-pre-pg18-20261025",
      ])
    )
    error_message = "Snapshot creation must name only gootip-dev and its exact dated pre-upgrade snapshot."
  }

  assert {
    condition = (
      contains(flatten([one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement
        if statement.Sid == "ConfigureAndReadExactFoundationRdsResources"
      ]).Action]), "rds:ModifyDBParameterGroup") &&
      contains(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement
        if statement.Sid == "ConfigureAndReadExactFoundationRdsResources"
      ]).Resource, "arn:aws:rds:us-east-2:${var.aws_account_id}:pg:gootip-dev-postgres18") &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement
        if statement.Sid == "DeleteExactPostgres17ParameterGroup"
      ]).Action == "rds:DeleteDBParameterGroup" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement
        if statement.Sid == "DeleteExactPostgres17ParameterGroup"
      ]).Resource == "arn:aws:rds:us-east-2:${var.aws_account_id}:pg:gootip-dev-postgres"
    )
    error_message = "Parameter-group configuration and deletion must target only the exact PostgreSQL 18 and obsolete PostgreSQL 17 groups."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement
        if statement.Sid == "ReadUpgradeRdsSnapshotMetadataInRegion"
      ]).Resource == "*" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement
        if statement.Sid == "ReadUpgradeRdsSnapshotMetadataInRegion"
      ]).Condition.StringEquals["aws:RequestedRegion"] == "us-east-2" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement
        if statement.Sid == "ReadUpgradeRdsPendingMaintenanceInRegion"
      ]).Resource == "*" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement
        if statement.Sid == "ReadUpgradeRdsPendingMaintenanceInRegion"
      ]).Condition.StringEquals["aws:RequestedRegion"] == "us-east-2" &&
      length([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement
        if contains(flatten([statement.Action]), "rds:DeleteDBInstance") ||
        contains(flatten([statement.Action]), "rds:RestoreDBInstanceFromDBSnapshot") ||
        contains(flatten([statement.Action]), "rds:CreateDBInstanceReadReplica") ||
        contains(flatten([statement.Action]), "iam:PassRole") ||
        contains(flatten([statement.Action]), "secretsmanager:GetSecretValue")
      ]) == 0
    )
    error_message = "RDS discovery must be Region-bound, and the upgrade grant must exclude instance deletion, restore, replicas, PassRole, and secret values."
  }
}

run "foundation_policy_expansion_is_minimal_and_runtime_free" {
  command = plan

  variables {
    eligibility_gate_passed             = true
    account_resource_phase_enabled      = true
    foundation_policy_expansion_enabled = true
    secrets_manager_kms_key_arn         = "arn:aws:kms:us-east-2:${var.aws_account_id}:key/00000000-0000-0000-0000-000000000000"
  }

  assert {
    condition = (
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "CreateFoundationNetworkResources"
        ]).Action) == toset([
        "ec2:CreateRouteTable",
        "ec2:CreateSecurityGroup",
        "ec2:CreateSubnet",
        "ec2:CreateVpc",
        "ec2:CreateVpcEndpoint",
      ]) &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "CreateFoundationNetworkResources"
      ]).Condition.StringEquals["aws:RequestedRegion"] == "us-east-2"
    )
    error_message = "Foundation network creation must be Region-scoped and limited to the reviewed resource types."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "TagFoundationNetworkResources"
      ]).Condition.StringEquals["aws:RequestTag/project"] == "gootip" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "TagFoundationNetworkResources"
      ]).Condition.StringEquals["aws:RequestTag/env"] == "dev" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "TagFoundationNetworkResources"
      ]).Condition.StringEquals["aws:RequestTag/managed_by"] == "terraform"
    )
    error_message = "Foundation network tagging must require the reviewed Gootip ownership tags."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "RevokeEgressOnlyFromTaggedFoundationSecurityGroups"
      ]).Resource == "arn:aws:ec2:us-east-2:${var.aws_account_id}:security-group/*" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "RevokeEgressOnlyFromTaggedFoundationSecurityGroups"
      ]).Condition.StringEquals["aws:ResourceTag/project"] == "gootip" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "RevokeEgressOnlyFromTaggedFoundationSecurityGroups"
      ]).Condition.StringEquals["aws:ResourceTag/env"] == "dev" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "RevokeEgressOnlyFromTaggedFoundationSecurityGroups"
      ]).Condition.StringEquals["aws:ResourceTag/managed_by"] == "terraform"
    )
    error_message = "Default egress revocation must be restricted to tagged foundation security groups."
  }

  assert {
    condition = (
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "RevokeIngressAndDeleteTaggedFoundationSecurityGroups"
      ]).Action) == toset(["ec2:DeleteSecurityGroup", "ec2:RevokeSecurityGroupIngress"]) &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "RevokeIngressAndDeleteTaggedFoundationSecurityGroups"
      ]).Resource == "arn:aws:ec2:us-east-2:${var.aws_account_id}:security-group/*" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "RevokeIngressAndDeleteTaggedFoundationSecurityGroups"
      ]).Condition.StringEquals["aws:ResourceTag/managed_by"] == "terraform"
    )
    error_message = "Security-group ingress revocation and deletion must stay restricted to tagged foundation groups."
  }

  assert {
    condition = (
      contains(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "ReadAndAssociateFoundationNetworkResources"
      ]).Action, "ec2:DescribePrefixLists") &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement
        if statement.Sid == "ReadFoundationRdsAccountAttributes"
      ]).Action == "rds:DescribeAccountAttributes" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement
        if statement.Sid == "ReadFoundationRdsAccountAttributes"
      ]).Condition.StringEquals["aws:RequestedRegion"] == "us-east-2"
    )
    error_message = "Foundation reconciliation reads must remain limited to the required EC2 and RDS metadata actions in us-east-2."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement
        if statement.Sid == "DescribeExactSecretsManagerManagedKmsKey"
      ]).Action == "kms:DescribeKey" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement
        if statement.Sid == "DescribeExactSecretsManagerManagedKmsKey"
      ]).Resource == "arn:aws:kms:us-east-2:${var.aws_account_id}:key/00000000-0000-0000-0000-000000000000"
    )
    error_message = "RDS master-secret setup may only describe the exact AWS-managed Secrets Manager KMS key observed in CloudTrail."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement
        if statement.Sid == "CreateOnlyRdsManagedMasterSecret"
      ]).Action == "secretsmanager:CreateSecret" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement
        if statement.Sid == "CreateOnlyRdsManagedMasterSecret"
      ]).Resource == "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:rds!db-*" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement
        if statement.Sid == "CreateOnlyRdsManagedMasterSecret"
      ]).Condition.StringLike["secretsmanager:Name"] == "rds!db-*"
    )
    error_message = "RDS may create only an RDS-managed DB secret with the rds!db- name prefix in the configured account and Region."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement
        if statement.Sid == "TagOnlyRdsManagedMasterSecrets"
      ]).Action == "secretsmanager:TagResource" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement
        if statement.Sid == "TagOnlyRdsManagedMasterSecrets"
      ]).Resource == "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:rds!db-*"
    )
    error_message = "RDS may tag only RDS-managed DB secrets in the configured account and Region."
  }

  assert {
    condition = (
      !contains(flatten([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement.Action
      ]), "rds:CreateDBInstanceReadReplica") &&
      !contains(flatten([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement.Action
      ]), "rds:RestoreDBInstanceFromDBSnapshot") &&
      !contains(flatten([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement.Action
      ]), "rds:RestoreDBInstanceFromS3") &&
      !contains(flatten([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_database_permissions[0].json).Statement : statement.Action
      ]), "rds:RestoreDBInstanceToPointInTime")
    )
    error_message = "The foundation expansion must not anticipate replica or restore capabilities."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_foundation_read_permissions[0].json).Statement : statement
        if statement.Sid == "PublishExactRdsCaLayer"
      ]).Resource == "arn:aws:lambda:us-east-2:${var.aws_account_id}:layer:gootip-dev-rds-ca" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_foundation_read_permissions[0].json).Statement : statement
        if statement.Sid == "ReadExactRdsCaLayerVersions"
      ]).Resource == "arn:aws:lambda:us-east-2:${var.aws_account_id}:layer:gootip-dev-rds-ca:*"
    )
    error_message = "CA-layer permissions must remain limited to the one foundation layer name and its versions."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_foundation_read_permissions[0].json).Statement : statement
        if statement.Sid == "ReadFoundationServiceQuotas"
      ]).Action == "servicequotas:ListServiceQuotas" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_foundation_read_permissions[0].json).Statement : statement
        if statement.Sid == "ReadFoundationServiceQuotas"
      ]).Resource == "*"
    )
    error_message = "The quota gate must use only the required read-only Service Quotas action."
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(data.aws_iam_policy_document.deployment_foundation_read_permissions[0].json).Statement : contains(
        jsondecode(data.aws_iam_policy_document.deployment_permissions.json).Statement,
        statement,
      )
    ])
    error_message = "Foundation-read actions, resources, and conditions must be preserved exactly in the deployment core policy."
  }
}

run "deployment_has_no_anticipated_runtime_permissions" {
  command = plan

  # The deployment policy is close to the 6144-character managed-policy limit, so
  # the SPEC 03 PassRole expansion lives in its own attached policy. Neither the
  # grant nor any other runtime permission may reappear in the deployment document.
  assert {
    condition = length([
      for statement in jsondecode(data.aws_iam_policy_document.deployment_permissions.json).Statement : statement
      if contains(flatten([statement.Action]), "iam:PassRole")
    ]) == 0
    error_message = "The deployment policy must not carry PassRole; SPEC 03 grants it through its own attached policy."
  }

  assert {
    condition = toset([
      for statement in jsondecode(data.aws_iam_policy_document.deployment_administrative_pass_role.json).Statement : statement.Sid
      if contains(flatten([statement.Action]), "iam:PassRole")
    ]) == toset(["PassExactPrivateFunctionRoles"])
    error_message = "PassRole may be granted only through the exact SPEC 03 and SPEC 04 private-function statement."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_administrative_pass_role.json).Statement : statement
        if statement.Sid == "PassExactPrivateFunctionRoles"
      ]).Condition.StringEquals["iam:PassedToService"] == "lambda.amazonaws.com" &&
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_administrative_pass_role.json).Statement : statement
        if statement.Sid == "PassExactPrivateFunctionRoles"
        ]).Resource) == toset([
        "arn:aws:iam::${var.aws_account_id}:role/gootip/administrative/gootip-db-config-dev-lambda",
        "arn:aws:iam::${var.aws_account_id}:role/gootip/application/gootip-dev-auth-migrations-lambda",
        "arn:aws:iam::${var.aws_account_id}:role/gootip/application/gootip-dev-core-migrations-lambda",
        "arn:aws:iam::${var.aws_account_id}:role/gootip/application/gootip-auth-dev-lambda",
        "arn:aws:iam::${var.aws_account_id}:role/gootip/application/gootip-core-dev-lambda",
      ])
    )
    error_message = "PassRole must target only the exact private execution roles and Lambda service."
  }

  assert {
    condition = (
      contains(
        one([
          for statement in jsondecode(data.aws_iam_policy_document.deployment_permissions.json).Statement : statement
          if statement.Sid == "DenySecretsManagerMutationAndValues"
        ]).Action,
        "secretsmanager:GetSecretValue"
      ) &&
      contains(
        one([
          for statement in jsondecode(data.aws_iam_policy_document.deployment_permissions.json).Statement : statement
          if statement.Sid == "DenySecretsManagerMutationAndValues"
        ]).Action,
        "secretsmanager:PutSecretValue"
      ) &&
      !contains(
        one([
          for statement in jsondecode(data.aws_iam_policy_document.deployment_permissions.json).Statement : statement
          if statement.Sid == "DenySecretsManagerMutationAndValues"
        ]).Action,
        "secretsmanager:CreateSecret"
      )
    )
    error_message = "Deployment must explicitly deny secret-value access while leaving only RDS-managed secret creation outside that deny."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_permissions.json).Statement : statement
        if statement.Sid == "DenyNonRdsSecretsManagerCreateAndTag"
      ]).Effect == "Deny" &&
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_permissions.json).Statement : statement
        if statement.Sid == "DenyNonRdsSecretsManagerCreateAndTag"
      ]).Action) == toset(["secretsmanager:CreateSecret", "secretsmanager:TagResource"]) &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_permissions.json).Statement : statement
        if statement.Sid == "DenyNonRdsSecretsManagerCreateAndTag"
      ]).NotResource == "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:rds!db-*"
    )
    error_message = "Secret creation and tagging must stay denied for every secret except the RDS-managed DB secret pattern."
  }
}

run "db_config_deployment_capability_is_exact" {
  command = plan

  assert {
    condition = (
      length(jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement) == 11 &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement if statement.Sid == "CreateExactDbConfigRole"]).Action == "iam:CreateRole" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement if statement.Sid == "CreateExactDbConfigRole"]).Resource == "arn:aws:iam::${var.aws_account_id}:role/gootip/administrative/gootip-db-config-dev-lambda" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement if statement.Sid == "CreateExactDbConfigRole"]).Condition.StringEquals["iam:PermissionsBoundary"] == "arn:aws:iam::${var.aws_account_id}:policy/gootip/bootstrap/GootipApplicationRuntimeBoundary" &&
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement if statement.Sid == "ReadAndTagExactDbConfigRole"]).Action) == toset(["iam:GetRole", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole", "iam:ListRolePolicies", "iam:TagRole"]) &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement if statement.Sid == "ReadAndTagExactDbConfigRole"]).Resource == "arn:aws:iam::${var.aws_account_id}:role/gootip/administrative/gootip-db-config-dev-lambda" &&
      try(one([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement if statement.Sid == "ReadAndTagExactDbConfigRole"]).Condition, null) == null &&
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement if statement.Sid == "DeleteExactDbConfigRole"]).Action) == toset(["iam:DeleteRole", "iam:DetachRolePolicy"]) &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement if statement.Sid == "DeleteExactDbConfigRole"]).Resource == "arn:aws:iam::${var.aws_account_id}:role/gootip/administrative/gootip-db-config-dev-lambda"
    )
    error_message = "The db-config role capability must use the exact role and boundary only for CreateRole."
  }

  assert {
    condition = (
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement if statement.Sid == "CreateReadAndTagExactDbConfigSecretsPolicy"]).Action) == toset(["iam:CreatePolicy", "iam:CreatePolicyVersion", "iam:DeletePolicyVersion", "iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyVersions", "iam:SetDefaultPolicyVersion", "iam:TagPolicy"]) &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement if statement.Sid == "CreateReadAndTagExactDbConfigSecretsPolicy"]).Resource == "arn:aws:iam::${var.aws_account_id}:policy/gootip-db-config-dev-secrets-read" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement if statement.Sid == "DeleteExactDbConfigSecretsPolicy"]).Action == "iam:DeletePolicy" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement if statement.Sid == "DeleteExactDbConfigSecretsPolicy"]).Resource == "arn:aws:iam::${var.aws_account_id}:policy/gootip-db-config-dev-secrets-read" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement if statement.Sid == "AttachOnlyReviewedDbConfigPolicies"]).Action == "iam:AttachRolePolicy" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement if statement.Sid == "AttachOnlyReviewedDbConfigPolicies"]).Resource == "arn:aws:iam::${var.aws_account_id}:role/gootip/administrative/gootip-db-config-dev-lambda" &&
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement if statement.Sid == "AttachOnlyReviewedDbConfigPolicies"]).Condition.ArnEquals["iam:PolicyARN"]) == toset(["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole", "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole", "arn:aws:iam::${var.aws_account_id}:policy/gootip-db-config-dev-secrets-read", "arn:aws:iam::${var.aws_account_id}:policy/lambda_db_config-logs", "arn:aws:iam::${var.aws_account_id}:policy/lambda_db_config-vpc"]) &&
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement if statement.Sid == "ManageExactDbConfigHardeningPolicies"]).Action) == toset(["iam:CreatePolicy", "iam:CreatePolicyVersion", "iam:DeletePolicyVersion", "iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyTags", "iam:ListPolicyVersions", "iam:SetDefaultPolicyVersion", "iam:TagPolicy", "iam:UntagPolicy"]) &&
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement if statement.Sid == "ManageExactDbConfigHardeningPolicies"]).Resource) == toset(["arn:aws:iam::${var.aws_account_id}:policy/lambda_db_config-logs", "arn:aws:iam::${var.aws_account_id}:policy/lambda_db_config-vpc"]) &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement if statement.Sid == "DetachOnlyTransitionDbConfigPolicies"]).Action == "iam:DetachRolePolicy" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement if statement.Sid == "DetachOnlyTransitionDbConfigPolicies"]).Resource == "arn:aws:iam::${var.aws_account_id}:role/gootip/administrative/gootip-db-config-dev-lambda" &&
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement if statement.Sid == "DetachOnlyTransitionDbConfigPolicies"]).Condition.ArnEquals["iam:PolicyARN"]) == toset(["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole", "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"]) &&
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement if statement.Sid == "CreateReadAndTagExactDbConfigFunction"]).Action) == toset(["lambda:CreateFunction", "lambda:GetFunction", "lambda:GetFunctionCodeSigningConfig", "lambda:ListVersionsByFunction", "lambda:TagResource", "lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration"]) &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement if statement.Sid == "CreateReadAndTagExactDbConfigFunction"]).Resource == "arn:aws:lambda:us-east-2:${var.aws_account_id}:function:lambda_db_config" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement if statement.Sid == "ReadExactDbConfigFunctionConfiguration"]).Action == "lambda:GetFunctionConfiguration" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement if statement.Sid == "ReadExactDbConfigFunctionConfiguration"]).Resource == "arn:aws:lambda:us-east-2:${var.aws_account_id}:function:lambda_db_config" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement if statement.Sid == "DeleteExactDbConfigFunction"]).Action == "lambda:DeleteFunction" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement if statement.Sid == "DeleteExactDbConfigFunction"]).Resource == "arn:aws:lambda:us-east-2:${var.aws_account_id}:function:lambda_db_config"
    )
    error_message = "The db-config policy, attachment allowlist, and Lambda ARN must be exact."
  }

  assert {
    condition = (
      !contains(flatten([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement.Action]), "iam:PassRole") &&
      !contains(flatten([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement.Action]), "logs:CreateLogGroup") &&
      !contains(flatten([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement.Action]), "ec2:CreateSecurityGroup") &&
      !contains(flatten([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement.Action]), "secretsmanager:GetSecretValue") &&
      !contains(flatten([for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement.Resource]), "*")
    )
    error_message = "The db-config capability must exclude wildcards and unrelated service, update, delete, and secret actions."
  }
}

run "db_config_network_interface_revocation_is_exact" {
  command = plan

  variables {
    eligibility_gate_passed             = true
    account_resource_phase_enabled      = true
    foundation_policy_expansion_enabled = true
    secrets_manager_kms_key_arn         = "arn:aws:kms:us-east-2:${var.aws_account_id}:key/00000000-0000-0000-0000-000000000000"
    db_config_network_interface_arns = [
      "arn:aws:ec2:us-east-2:${var.aws_account_id}:network-interface/eni-0123456789abcdef0",
      "arn:aws:ec2:us-east-2:${var.aws_account_id}:network-interface/eni-0fedcba9876543210",
    ]
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "DeleteExactDbConfigNetworkInterfaces"
      ]).Action == "ec2:DeleteNetworkInterface" &&
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_network_permissions[0].json).Statement : statement
        if statement.Sid == "DeleteExactDbConfigNetworkInterfaces"
      ]).Resource) == toset(var.db_config_network_interface_arns)
    )
    error_message = "Db-config ENI cleanup must name only the reviewed exact network-interface ARNs."
  }
}

run "auth_migrations_log_group_creation_exception_is_exact" {
  command = plan

  assert {
    condition = (
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement if statement.Sid == "CreateTaggedAuthMigrationsLogGroup"]).Action == "logs:CreateLogGroup" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement if statement.Sid == "CreateTaggedAuthMigrationsLogGroup"]).Resource == "*" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement if statement.Sid == "CreateTaggedAuthMigrationsLogGroup"]).Condition.StringEquals["aws:RequestedRegion"] == "us-east-2" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement if statement.Sid == "CreateTaggedAuthMigrationsLogGroup"]).Condition.StringEquals["aws:RequestTag/Name"] == "gootip-dev-auth-migrations" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement if statement.Sid == "CreateTaggedAuthMigrationsLogGroup"]).Condition.StringEquals["aws:RequestTag/project"] == "gootip" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement if statement.Sid == "CreateTaggedAuthMigrationsLogGroup"]).Condition.StringEquals["aws:RequestTag/env"] == "dev" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement if statement.Sid == "CreateTaggedAuthMigrationsLogGroup"]).Condition.StringEquals["aws:RequestTag/managed_by"] == "terraform" &&
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement if statement.Sid == "CreateTaggedAuthMigrationsLogGroup"]).Condition["ForAllValues:StringEquals"]["aws:TagKeys"]) == toset(["Name", "project", "env", "managed_by"]) &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement if statement.Sid == "CreateTaggedAuthMigrationsLogGroup"]).Condition.Null["aws:TagKeys"] == "false" &&
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement if statement.Sid == "ManageDevLogTags"]).Action) == toset(["logs:TagResource", "logs:UntagResource"]) &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement if statement.Sid == "ManageDevLogTags"]).Resource == "*" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement if statement.Sid == "ManageDevLogTags"]).Condition.StringEquals["aws:RequestedRegion"] == "us-east-2" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement if statement.Sid == "DescribeDevLogGroups"]).Action == "logs:DescribeLogGroups" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement if statement.Sid == "DescribeDevLogGroups"]).Resource == "*" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement if statement.Sid == "DescribeDevLogGroups"]).Condition.StringEquals["aws:RequestedRegion"] == "us-east-2" &&
      length([for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement if statement.Resource == "*"]) == 3 &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement if statement.Sid == "ReadExactAuthMigrationsVersions"]).Action == "lambda:GetFunctionConfiguration" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement if statement.Sid == "ReadExactAuthMigrationsVersions"]).Resource == "arn:aws:lambda:us-east-2:${var.aws_account_id}:function:gootip-dev-auth-migrations:*" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement if statement.Sid == "CreateExactAuthMigrationsAliases"]).Action == "lambda:CreateAlias" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement if statement.Sid == "CreateExactAuthMigrationsAliases"]).Resource == "arn:aws:lambda:us-east-2:${var.aws_account_id}:function:gootip-dev-auth-migrations" &&
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement if statement.Sid == "ManageExactAuthMigrationsAliases"]).Action) == toset(["lambda:GetAlias", "lambda:UpdateAlias"]) &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement if statement.Sid == "ManageExactAuthMigrationsAliases"]).Resource == "arn:aws:lambda:us-east-2:${var.aws_account_id}:function:gootip-dev-auth-migrations" &&
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement if statement.Sid == "ManageExactAuthMigrationsLogGroup"]).Action) == toset(["logs:FilterLogEvents", "logs:ListTagsForResource", "logs:PutRetentionPolicy", "logs:TagResource", "logs:UntagResource"]) &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement if statement.Sid == "ManageExactAuthMigrationsLogGroup"]).Resource == "arn:aws:logs:us-east-2:${var.aws_account_id}:log-group:/aws/lambda/gootip-dev-auth-migrations"
    )
    error_message = "The only migration capability wildcard must be tagged, regional CreateLogGroup; later log-group management must use its exact ARN."
  }

  assert {
    condition = (
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement if statement.Sid == "ManageExactAuthMigrationsHardeningPolicies"]).Resource) == toset(["arn:aws:iam::${var.aws_account_id}:policy/gootip-dev-auth-migrations-logs", "arn:aws:iam::${var.aws_account_id}:policy/gootip-dev-auth-migrations-vpc"]) &&
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement if statement.Sid == "AttachOnlyReviewedAuthMigrationsPolicies"]).Condition.ArnEquals["iam:PolicyARN"]) == toset([
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
        "arn:aws:iam::${var.aws_account_id}:policy/gootip-dev-auth-migrations-secrets-read",
        "arn:aws:iam::${var.aws_account_id}:policy/gootip-dev-auth-migrations-logs",
        "arn:aws:iam::${var.aws_account_id}:policy/gootip-dev-auth-migrations-vpc",
      ]) &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement if statement.Sid == "DetachOnlyTransitionAuthMigrationsPolicies"]).Action == "iam:DetachRolePolicy" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement if statement.Sid == "DetachOnlyTransitionAuthMigrationsPolicies"]).Resource == "arn:aws:iam::${var.aws_account_id}:role/gootip/application/gootip-dev-auth-migrations-lambda" &&
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.deployment_auth_migrations_permissions.json).Statement : statement if statement.Sid == "DetachOnlyTransitionAuthMigrationsPolicies"]).Condition.ArnEquals["iam:PolicyARN"]) == toset(["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole", "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"])
    )
    error_message = "Auth migration hardening policies and temporary detach permissions must be bound to its exact policy and role ARNs."
  }
}

run "core_migrations_deployment_capability_is_exact" {
  command = plan

  assert {
    condition = (
      aws_iam_policy.deployment_core_migrations_permissions.name == "GootipTerraformDeployCoreMigrationsPermissions" &&
      aws_iam_policy.deployment_core_migrations_permissions.path == "/gootip/deployment/" &&
      aws_iam_role_policy_attachment.deployment_core_migrations_permissions.role == "GootipTerraformDeploy" &&
      length(jsondecode(data.aws_iam_policy_document.deployment_core_migrations_permissions.json).Statement) == 15 &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_core_migrations_permissions.json).Statement : statement if statement.Sid == "CreateExactCoreMigrationsRole"]).Action == "iam:CreateRole" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_core_migrations_permissions.json).Statement : statement if statement.Sid == "CreateExactCoreMigrationsRole"]).Resource == "arn:aws:iam::${var.aws_account_id}:role/gootip/application/gootip-dev-core-migrations-lambda" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_core_migrations_permissions.json).Statement : statement if statement.Sid == "CreateExactCoreMigrationsRole"]).Condition.StringEquals["iam:PermissionsBoundary"] == "arn:aws:iam::${var.aws_account_id}:policy/gootip/bootstrap/GootipApplicationRuntimeBoundary"
    )
    error_message = "Core migrations role creation must be restricted to its exact role ARN and runtime boundary."
  }

  assert {
    condition = (
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.deployment_core_migrations_permissions.json).Statement : statement if statement.Sid == "AttachOnlyReviewedCoreMigrationsPolicies"]).Condition.ArnEquals["iam:PolicyARN"]) == toset([
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
        "arn:aws:iam::${var.aws_account_id}:policy/gootip-dev-core-migrations-secrets-read",
        "arn:aws:iam::${var.aws_account_id}:policy/gootip-dev-core-migrations-logs",
        "arn:aws:iam::${var.aws_account_id}:policy/gootip-dev-core-migrations-vpc",
      ]) &&
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.deployment_core_migrations_permissions.json).Statement : statement if statement.Sid == "ManageExactCoreMigrationsHardeningPolicies"]).Resource) == toset(["arn:aws:iam::${var.aws_account_id}:policy/gootip-dev-core-migrations-logs", "arn:aws:iam::${var.aws_account_id}:policy/gootip-dev-core-migrations-vpc"]) &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_core_migrations_permissions.json).Statement : statement if statement.Sid == "DetachOnlyTransitionCoreMigrationsPolicies"]).Action == "iam:DetachRolePolicy" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_core_migrations_permissions.json).Statement : statement if statement.Sid == "DetachOnlyTransitionCoreMigrationsPolicies"]).Resource == "arn:aws:iam::${var.aws_account_id}:role/gootip/application/gootip-dev-core-migrations-lambda" &&
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.deployment_core_migrations_permissions.json).Statement : statement if statement.Sid == "DetachOnlyTransitionCoreMigrationsPolicies"]).Condition.ArnEquals["iam:PolicyARN"]) == toset(["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole", "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"]) &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_core_migrations_permissions.json).Statement : statement if statement.Sid == "ManageExactCoreMigrationsSecretsPolicy"]).Resource == "arn:aws:iam::${var.aws_account_id}:policy/gootip-dev-core-migrations-secrets-read" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_core_migrations_permissions.json).Statement : statement if statement.Sid == "ManageExactCoreMigrationsFunction"]).Resource == "arn:aws:lambda:us-east-2:${var.aws_account_id}:function:gootip-dev-core-migrations" &&
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.deployment_core_migrations_permissions.json).Statement : statement if statement.Sid == "ManageExactCoreMigrationsFunction"]).Action) == toset(["lambda:CreateFunction", "lambda:GetFunction", "lambda:GetFunctionCodeSigningConfig", "lambda:GetFunctionConfiguration", "lambda:GetFunctionConcurrency", "lambda:ListTags", "lambda:ListVersionsByFunction", "lambda:PublishVersion", "lambda:PutFunctionConcurrency", "lambda:TagResource", "lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration"]) &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_core_migrations_permissions.json).Statement : statement if statement.Sid == "ReadExactRdsCaLayerVersionsForCoreMigrations"]).Resource == "arn:aws:lambda:us-east-2:${var.aws_account_id}:layer:gootip-dev-rds-ca:*" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_core_migrations_permissions.json).Statement : statement if statement.Sid == "InvokeExactCoreMigrationsDeploymentAlias"]).Resource == "arn:aws:lambda:us-east-2:${var.aws_account_id}:function:gootip-dev-core-migrations:deployment"
    )
    error_message = "The Core capability must use only its reviewed role policies, function, CA layer, and deployment alias."
  }

  assert {
    condition = (
      length([for statement in jsondecode(data.aws_iam_policy_document.deployment_core_migrations_permissions.json).Statement : statement if statement.Resource == "*"]) == 2 &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_core_migrations_permissions.json).Statement : statement if statement.Sid == "CreateTaggedCoreMigrationsLogGroup"]).Action == "logs:CreateLogGroup" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_core_migrations_permissions.json).Statement : statement if statement.Sid == "CreateTaggedCoreMigrationsLogGroup"]).Condition.StringEquals["aws:RequestedRegion"] == "us-east-2" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_core_migrations_permissions.json).Statement : statement if statement.Sid == "CreateTaggedCoreMigrationsLogGroup"]).Condition.StringEquals["aws:RequestTag/Name"] == "gootip-dev-core-migrations" &&
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.deployment_core_migrations_permissions.json).Statement : statement if statement.Sid == "CreateTaggedCoreMigrationsLogGroup"]).Condition["ForAllValues:StringEquals"]["aws:TagKeys"]) == toset(["Name", "project", "env", "managed_by"]) &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_core_migrations_permissions.json).Statement : statement if statement.Sid == "CreateTaggedCoreMigrationsLogGroup"]).Condition.Null["aws:TagKeys"] == "false" &&
      !contains(flatten([for statement in jsondecode(data.aws_iam_policy_document.deployment_core_migrations_permissions.json).Statement : statement.Action]), "iam:PassRole") &&
      !contains(flatten([for statement in jsondecode(data.aws_iam_policy_document.deployment_core_migrations_permissions.json).Statement : statement.Action]), "lambda:DeleteFunction")
    )
    error_message = "The only wildcard resources must be regional log-group creation and log discovery; unrelated privileges are forbidden."
  }
}

run "observability_deployment_capability_is_exact_and_tag_guarded" {
  command = plan

  variables {
    eligibility_gate_passed             = true
    account_resource_phase_enabled      = true
    foundation_policy_expansion_enabled = true
    secrets_manager_kms_key_arn         = "arn:aws:kms:us-east-2:${var.aws_account_id}:key/00000000-0000-0000-0000-000000000000"
  }

  assert {
    condition = (
      aws_iam_policy.deployment_observability_permissions.name == "GootipTerraformDeployObservabilityPermissions" &&
      aws_iam_policy.deployment_observability_permissions.path == "/gootip/deployment/" &&
      aws_iam_role_policy_attachment.deployment_observability_permissions.role == "GootipTerraformDeploy"
    )
    error_message = "The permanent observability policy must be attached only to the exact Terraform deployment role."
  }

  assert {
    condition = (
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "CreateObsLogGroups"]).Action == "logs:CreateLogGroup" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "CreateObsLogGroups"]).Resource == "*" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "CreateObsLogGroups"]).Condition.StringEquals["aws:RequestedRegion"] == "us-east-2" &&
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "CreateObsLogGroups"]).Condition.StringEquals["aws:RequestTag/Name"]) == toset(["gootip-auth-dev", "lambda-db-config", "gootip-dev-auth-api-access"]) &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "CreateObsLogGroups"]).Condition.StringEquals["aws:RequestTag/project"] == "gootip" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "CreateObsLogGroups"]).Condition.StringEquals["aws:RequestTag/env"] == "dev" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "CreateObsLogGroups"]).Condition.StringEquals["aws:RequestTag/managed_by"] == "terraform" &&
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "CreateObsLogGroups"]).Condition["ForAllValues:StringEquals"]["aws:TagKeys"]) == toset(["Name", "project", "env", "managed_by"]) &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "CreateObsLogGroups"]).Condition.Null["aws:TagKeys"] == "false" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "CreateObsTopic"]).Condition.StringEquals["aws:RequestTag/Name"] == "gootip-dev-operational-alarms" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "CreateObsTopic"]).Condition.StringEquals["aws:RequestTag/project"] == "gootip" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "CreateObsTopic"]).Condition.StringEquals["aws:RequestTag/env"] == "dev" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "CreateObsTopic"]).Condition.StringEquals["aws:RequestTag/managed_by"] == "terraform" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "CreateObsTopic"]).Condition.Null["aws:TagKeys"] == "false" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "TagBudget"]).Condition.StringEquals["aws:RequestTag/Name"] == "gootip-dev-monthly-actual-cost" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "TagBudget"]).Condition.StringEquals["aws:RequestTag/project"] == "gootip" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "TagBudget"]).Condition.StringEquals["aws:RequestTag/env"] == "dev" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "TagBudget"]).Condition.StringEquals["aws:RequestTag/managed_by"] == "terraform" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "TagBudget"]).Condition.Null["aws:TagKeys"] == "false"
    )
    error_message = "Resource * is permitted only for regional log-group creation with exact Gootip names and required tags."
  }

  assert {
    condition = (
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "ManageObsLogs"]).Resource) == toset(local.observability_log_group_arns) &&
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "AlarmOps"]).Resource) == toset(local.observability_alarm_arns) &&
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "PutAlarms"]).Resource) == toset(local.observability_alarm_arns) &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "CreateObsTopic"]).Resource == local.observability_topic_arn &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "ManageBudget"]).Resource == local.observability_budget_arn &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "TagBudget"]).Resource == local.observability_budget_arn &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "ManageObsEmail"]).Resource == local.observability_topic_subscription_arn &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "ManageObsEmail"]).Action == "sns:Unsubscribe" &&
      contains(one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "ManageObsTopic"]).Action, "sns:GetSubscriptionAttributes") &&
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "UntagObs"]).Resource) == toset(concat(local.observability_log_group_arns, local.observability_alarm_arns, [local.observability_topic_arn, local.observability_budget_arn]))
    )
    error_message = "Logs, alarms, SNS topic, and subscription permissions must use only exact Gootip resource ARNs."
  }

  assert {
    condition = (
      length([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Resource == "*"]) == 2 &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "ReadBillingPrefs"]).Action == "billing:GetBillingPreferences" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : statement if statement.Sid == "ReadBillingPrefs"]).Condition.StringEquals["aws:RequestedRegion"] == "us-east-1" &&
      alltrue([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : alltrue([for action in flatten([statement.Action]) : !strcontains(action, "*")])]) &&
      toset(flatten([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : flatten([statement.Action])])) == toset([
        "logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:ListTagsForResource", "logs:PutRetentionPolicy", "logs:TagLogGroup", "logs:TagResource", "logs:UntagLogGroup", "logs:UntagResource",
        "cloudwatch:DeleteAlarms", "cloudwatch:DescribeAlarms", "cloudwatch:ListTagsForResource", "cloudwatch:PutMetricAlarm", "cloudwatch:TagResource", "cloudwatch:UntagResource",
        "sns:CreateTopic", "sns:DeleteTopic", "sns:GetSubscriptionAttributes", "sns:GetTopicAttributes", "sns:ListSubscriptionsByTopic", "sns:ListTagsForResource", "sns:SetTopicAttributes", "sns:Subscribe", "sns:TagResource", "sns:Unsubscribe", "sns:UntagResource",
        "budgets:ListTagsForResource", "budgets:ModifyBudget", "budgets:TagResource", "budgets:UntagResource", "budgets:ViewBudget",
        "billing:GetBillingPreferences",
      ]) &&
      !contains(flatten([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : flatten([statement.Action])]), "iam:PassRole") &&
      !anytrue([for action in flatten([for statement in jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json).Statement : flatten([statement.Action])]) : startswith(action, "secretsmanager:")])
    )
    error_message = "The observability policy must contain no wildcard action, no extra Resource *, no PassRole, and no Secrets Manager access."
  }

  assert {
    condition = (
      contains(one([for statement in jsondecode(data.aws_iam_policy_document.bootstrap_deployment_policy_admin_permissions.json).Statement : statement if statement.Sid == "ManageExactDeploymentPolicies"]).Action, "iam:CreatePolicy") &&
      contains(one([for statement in jsondecode(data.aws_iam_policy_document.bootstrap_deployment_policy_admin_permissions.json).Statement : statement if statement.Sid == "ManageExactDeploymentPolicies"]).Resource, local.deployment_observability_policy_arn) &&
      length(data.aws_iam_policy_document.bootstrap_deployment_policy_admin_permissions.json) < 6144
    )
    error_message = "Bootstrap may create and manage only the exact permanent observability deployment policy."
  }

  assert {
    condition = (
      1 +
      1 +
      1 +
      1 +
      1 +
      1 +
      length(aws_iam_role_policy_attachment.deployment_network_permissions) +
      length(aws_iam_role_policy_attachment.deployment_database_permissions) +
      1 +
      1 <= 10
    )
    error_message = "The Terraform deployment role must remain within AWS's ten managed-policy attachment limit."
  }
}

run "deployment_api_observability_permissions_are_exact_and_bounded" {
  command = plan

  variables {
    eligibility_gate_passed             = true
    account_resource_phase_enabled      = true
    foundation_policy_expansion_enabled = true
    secrets_manager_kms_key_arn         = "arn:aws:kms:us-east-2:${var.aws_account_id}:key/00000000-0000-0000-0000-000000000000"
  }

  assert {
    condition = (
      aws_iam_policy.deployment_application_permissions.name == "GootipTerraformDeployApplicationPermissions" &&
      aws_iam_role_policy_attachment.deployment_application_permissions.role == "GootipTerraformDeploy" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_api_observability_permissions.json).Statement : statement if statement.Sid == "CreateApiObsLogGroups"]).Action == "logs:CreateLogGroup" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_api_observability_permissions.json).Statement : statement if statement.Sid == "CreateApiObsLogGroups"]).Resource == "*" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_api_observability_permissions.json).Statement : statement if statement.Sid == "CreateApiObsLogGroups"]).Condition.StringEquals["aws:RequestedRegion"] == var.aws_region &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_api_observability_permissions.json).Statement : statement if statement.Sid == "CreateApiObsLogGroups"]).Condition.StringEquals["aws:RequestTag/Name"] == "gootip-core-dev" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_api_observability_permissions.json).Statement : statement if statement.Sid == "CreateApiObsLogGroups"]).Condition.Null["aws:TagKeys"] == "false" &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_api_observability_permissions.json).Statement : statement if statement.Sid == "ManageApiObsLogs"]).Resource == one(local.api_observability_log_group_arns) &&
      one([for statement in jsondecode(data.aws_iam_policy_document.deployment_api_observability_permissions.json).Statement : statement if statement.Sid == "UntagApiObsLogs"]).Resource == one(local.api_observability_log_group_arns) &&
      alltrue([for statement in jsondecode(data.aws_iam_policy_document.deployment_api_observability_permissions.json).Statement : alltrue([for action in flatten([statement.Action]) : !strcontains(action, "*")])])
    )
    error_message = "The Core API observability policy must be attached to deployment only, remain under quota, and use exact resources except for tag-constrained regional log-group creation."
  }

  assert {
    condition     = length(jsonencode(jsondecode(data.aws_iam_policy_document.deployment_observability_permissions.json))) < 6144
    error_message = "The observability policy must remain below IAM's 6,144-character quota."
  }

  assert {
    condition     = length(jsonencode(jsondecode(data.aws_iam_policy_document.deployment_api_observability_permissions.json))) < 6144
    error_message = "The exact Core API log permissions must remain below IAM's 6,144-character quota."
  }

  assert {
    condition     = length(jsonencode(jsondecode(data.aws_iam_policy_document.deployment_application_permissions.json))) < 6144
    error_message = "The application policy, including exact Core API log permissions, must remain below IAM's 6,144-character quota."
  }
}

run "source_user_cutover_remains_disabled_by_default" {
  command = plan

  variables {
    db_operator_secret_arn = "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:gootip-dev-db-operator-Ij5Kl6"
  }

  assert {
    condition     = aws_iam_user.source.name == "gootip"
    error_message = "The imported source IAM user must retain its exact name."
  }

  assert {
    condition     = length(aws_iam_user_policy_attachment.source_user_assume_only) == 0
    error_message = "The source-user assume-only attachment must stay disabled before cutover."
  }

  assert {
    condition     = aws_iam_user.source.permissions_boundary == null
    error_message = "The source-user assume-only boundary must stay detached before cutover."
  }

  assert {
    condition = toset(jsondecode(data.aws_iam_policy_document.source_user_assume_only.json).Statement[0].Resource) == toset([
      "arn:aws:iam::${var.aws_account_id}:role/gootip/bootstrap/GootipBootstrapAdmin",
      "arn:aws:iam::${var.aws_account_id}:role/gootip/deployment/GootipTerraformDeploy",
      "arn:aws:iam::${var.aws_account_id}:role/gootip/operations/GootipDatabaseOperator",
    ])
    error_message = "The source-user policy must name only the three approved human roles."
  }

  assert {
    condition = toset(one([
      for statement in jsondecode(data.aws_iam_policy_document.source_user_assume_only_boundary.json).Statement : statement
      if statement.Sid == "AllowOnlyApprovedHumanRoleAssumptions"
      ]).Resource) == toset([
      "arn:aws:iam::${var.aws_account_id}:role/gootip/bootstrap/GootipBootstrapAdmin",
      "arn:aws:iam::${var.aws_account_id}:role/gootip/deployment/GootipTerraformDeploy",
      "arn:aws:iam::${var.aws_account_id}:role/gootip/operations/GootipDatabaseOperator",
    ])
    error_message = "The source-user boundary must allow only the three approved human roles."
  }

  assert {
    condition = (
      length(aws_iam_policy.database_operator_permissions) == 1 &&
      length([for statement in jsondecode(data.aws_iam_policy_document.database_operator_permissions.json).Statement : statement if statement.Sid == "ReadExactDatabaseOperatorSecret"]) == 1 &&
      toset(one([for statement in jsondecode(data.aws_iam_policy_document.database_operator_permissions.json).Statement : statement if statement.Sid == "ReadExactDatabaseOperatorSecret"]).Action) == toset([
        "secretsmanager:DescribeSecret",
        "secretsmanager:GetSecretValue",
      ]) &&
      one([for statement in jsondecode(data.aws_iam_policy_document.database_operator_permissions.json).Statement : statement if statement.Sid == "ReadExactDatabaseOperatorSecret"]).Resource == var.db_operator_secret_arn &&
      one(aws_iam_policy.database_operator_permissions).path == "/gootip/operations/" &&
      one(aws_iam_policy.database_operator_permissions).name == "GootipDatabaseOperatorPermissions" &&
      one(aws_iam_role_policy_attachment.database_operator_permissions).role == "GootipDatabaseOperator"
    )
    error_message = "The database operator must read only the exact operator secret through its single operations policy."
  }

  assert {
    condition = (
      contains(
        one([
          for statement in jsondecode(data.aws_iam_policy_document.application_runtime_boundary.json).Statement : statement
          if statement.Sid == "DenyIamAndStsEscalation"
        ]).Action,
        "iam:PassRole"
      ) &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.application_runtime_boundary.json).Statement : statement
        if statement.Sid == "DenyHumanAndStateBucketAccess"
      ]).Effect == "Deny"
    )
    error_message = "The runtime boundary must deny IAM escalation and state-bucket access."
  }

  assert {
    condition = (
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.application_runtime_boundary.json).Statement : statement
        if statement.Sid == "AllowLambdaVpcInterfaceOperationsInConfiguredRegion"
        ]).Action) == toset([
        "ec2:CreateNetworkInterface",
        "ec2:DescribeNetworkInterfaces",
        "ec2:DescribeSubnets",
        "ec2:DeleteNetworkInterface",
        "ec2:AssignPrivateIpAddresses",
        "ec2:UnassignPrivateIpAddresses",
      ]) &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.application_runtime_boundary.json).Statement : statement
        if statement.Sid == "AllowLambdaVpcInterfaceOperationsInConfiguredRegion"
      ]).Condition.StringEquals["aws:RequestedRegion"] == var.aws_region &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.application_runtime_boundary.json).Statement : statement
        if statement.Sid == "AllowLambdaVpcInterfaceOperationsInConfiguredRegion"
      ]).Resource == "*"
    )
    error_message = "The runtime boundary must preserve all six AWS-documented Lambda VPC actions on * in the configured Region."
  }
}

run "runtime_boundary_denies_every_unapproved_secret" {
  command = plan

  variables {
    application_secret_arn   = "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:gootip-auth-dev-AbCd12"
    rds_master_secret_arn    = "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:rds!db-example-Def123"
    auth_runtime_secret_arn  = null
    auth_migrator_secret_arn = null
    core_migrator_secret_arn = null
    db_operator_secret_arn   = null
  }

  assert {
    condition = (
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.application_runtime_boundary.json).Statement : statement
        if statement.Sid == "AllowOnlyExactRuntimeSecrets"
      ]).Resource) == toset([var.application_secret_arn, var.rds_master_secret_arn]) &&
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.application_runtime_boundary.json).Statement : statement
        if statement.Sid == "DenyEveryOtherSecret"
      ]).NotResource) == toset([var.application_secret_arn, var.rds_master_secret_arn])
    )
    error_message = "The runtime boundary must allow and deny secret reads using the same two exact ARNs."
  }
}

run "runtime_boundary_allows_only_exact_core_role_secrets" {
  command = plan

  variables {
    core_runtime_secret_arn  = "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:gootip-dev-core-runtime-Zx1Wv2"
    core_migrator_secret_arn = "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:gootip-dev-core-migrator-AbCd12"
  }

  assert {
    condition = (
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.application_runtime_boundary.json).Statement : statement
        if statement.Sid == "AllowOnlyExactRuntimeSecrets"
      ]).Resource) == toset([var.core_runtime_secret_arn, var.core_migrator_secret_arn]) &&
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.application_runtime_boundary.json).Statement : statement
        if statement.Sid == "DenyEveryOtherSecret"
      ]).NotResource) == toset([var.core_runtime_secret_arn, var.core_migrator_secret_arn])
    )
    error_message = "The runtime boundary must allow and deny using only the exact Core role-secret ARNs."
  }

  assert {
    condition = !contains(
      one([
        for statement in jsondecode(data.aws_iam_policy_document.application_runtime_boundary.json).Statement : statement
        if statement.Sid == "AllowOnlyApprovedRuntimeLogStreams"
      ]).Resource,
      "arn:aws:logs:us-east-2:${var.aws_account_id}:log-group:/aws/lambda/gootip-dev-core-migrations:*"
    )
    error_message = "Core migration log access must remain disabled until its separate deployment phase."
  }

  assert {
    condition = contains(
      one([
        for statement in jsondecode(data.aws_iam_policy_document.application_runtime_boundary.json).Statement : statement
        if statement.Sid == "AllowOnlyApprovedRuntimeLogStreams"
      ]).Resource,
      "arn:aws:logs:us-east-2:${var.aws_account_id}:log-group:/aws/lambda/gootip-core-dev:*"
    )
    error_message = "Core API logging must be allowed only for its exact Lambda log group."
  }
}

run "runtime_boundary_enables_core_logs_only_in_core_phase" {
  command = plan

  variables {
    core_migrator_secret_arn           = "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:gootip-dev-core-migrator-AbCd12"
    core_migrations_log_access_enabled = true
  }

  assert {
    condition = contains(
      one([
        for statement in jsondecode(data.aws_iam_policy_document.application_runtime_boundary.json).Statement : statement
        if statement.Sid == "AllowOnlyApprovedRuntimeLogStreams"
      ]).Resource,
      "arn:aws:logs:us-east-2:${var.aws_account_id}:log-group:/aws/lambda/gootip-dev-core-migrations:*"
    )
    error_message = "Core migration log access must be exact and explicitly enabled for its separate deployment phase."
  }
}

run "core_role_secret_creation_is_temporary_and_exact" {
  command = plan

  variables {
    eligibility_gate_passed           = true
    account_resource_phase_enabled    = true
    core_role_secret_creation_enabled = true
    application_secret_arn            = "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:gootip-auth-dev-AbCd12"
    secrets_manager_kms_key_arn       = "arn:aws:kms:us-east-2:${var.aws_account_id}:key/e0638b06-ad54-4317-9670-694aaa5fc422"
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(aws_iam_role_policy.core_role_secret_creation[0].policy).Statement : statement
        if statement.Sid == "CreateOnlyCoreRoleSecretContainers"
      ]).Action == "secretsmanager:CreateSecret" &&
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.core_role_secret_creation[0].policy).Statement : statement
        if statement.Sid == "CreateOnlyCoreRoleSecretContainers"
      ]).Resource) == toset(local.core_role_secret_arn_patterns) &&
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.core_role_secret_creation[0].policy).Statement : statement
        if statement.Sid == "CreateOnlyCoreRoleSecretContainers"
      ]).Condition.StringEquals["secretsmanager:Name"]) == toset(local.core_role_secret_names) &&
      one([
        for statement in jsondecode(aws_iam_role_policy.core_role_secret_creation[0].policy).Statement : statement
        if statement.Sid == "CreateOnlyCoreRoleSecretContainers"
      ]).Condition.StringEquals["aws:RequestedRegion"] == "us-east-2" &&
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.core_role_secret_creation[0].policy).Statement : statement
        if statement.Sid == "CreateOnlyCoreRoleSecretContainers"
      ]).Condition.StringEquals["aws:RequestTag/Name"]) == toset(local.core_role_secret_names) &&
      one([
        for statement in jsondecode(aws_iam_role_policy.core_role_secret_creation[0].policy).Statement : statement
        if statement.Sid == "CreateOnlyCoreRoleSecretContainers"
      ]).Condition.StringEquals["aws:RequestTag/project"] == "gootip" &&
      one([
        for statement in jsondecode(aws_iam_role_policy.core_role_secret_creation[0].policy).Statement : statement
        if statement.Sid == "CreateOnlyCoreRoleSecretContainers"
      ]).Condition.StringEquals["aws:RequestTag/env"] == "dev" &&
      one([
        for statement in jsondecode(aws_iam_role_policy.core_role_secret_creation[0].policy).Statement : statement
        if statement.Sid == "CreateOnlyCoreRoleSecretContainers"
      ]).Condition.StringEquals["aws:RequestTag/managed_by"] == "terraform" &&
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.core_role_secret_creation[0].policy).Statement : statement
        if statement.Sid == "CreateOnlyCoreRoleSecretContainers"
      ]).Condition["ForAllValues:StringEquals"]["aws:TagKeys"]) == toset(["Name", "project", "env", "managed_by"]) &&
      one([
        for statement in jsondecode(aws_iam_role_policy.core_role_secret_creation[0].policy).Statement : statement
        if statement.Sid == "CreateOnlyCoreRoleSecretContainers"
      ]).Condition.Null["aws:TagKeys"] == "false"
    )
    error_message = "The temporary creation exception must name only the two Core containers, Region, and required tags."
  }

  assert {
    condition = (
      var.core_role_secret_creation_enabled &&
      !local.core_role_secret_arns_approved &&
      var.core_runtime_secret_arn == null &&
      var.core_migrator_secret_arn == null
    )
    error_message = "The first phase must create empty Core containers without exact ARNs or value access."
  }
}

run "core_role_secret_value_access_requires_both_exact_arns" {
  command = plan

  variables {
    eligibility_gate_passed        = true
    account_resource_phase_enabled = true
    application_secret_arn         = "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:gootip-auth-dev-AbCd12"
    core_runtime_secret_arn        = "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:gootip-dev-core-runtime-Zx1Wv2"
    core_migrator_secret_arn       = "arn:aws:secretsmanager:us-east-2:${var.aws_account_id}:secret:gootip-dev-core-migrator-AbCd12"
    secrets_manager_kms_key_arn    = "arn:aws:kms:us-east-2:${var.aws_account_id}:key/e0638b06-ad54-4317-9670-694aaa5fc422"
  }

  assert {
    condition = (
      length(aws_iam_role_policy.core_role_secret_creation) == 0 &&
      local.core_role_secret_arns_approved &&
      !var.core_role_secret_creation_enabled &&
      var.core_runtime_secret_arn != null &&
      var.core_migrator_secret_arn != null
    )
    error_message = "The second phase must remove CreateSecret and require both exact Core ARNs before value access is enabled."
  }
}

run "bootstrap_diagnostics_inventory_is_read_only" {
  command = plan

  # SPEC 02.3 scope: these statements render only when the SPEC 02.3 flag is on,
  # so no SPEC 03.1 apply introduces them.
  variables {
    eligibility_gate_passed        = true
    account_resource_phase_enabled = true
    diagnostics_inventory_enabled  = true
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_diagnostics_permissions.json).Statement : statement
        if statement.Sid == "ValidateGootipPoliciesInConfiguredRegion"
      ]).Action == "access-analyzer:ValidatePolicy" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_diagnostics_permissions.json).Statement : statement
        if statement.Sid == "ValidateGootipPoliciesInConfiguredRegion"
      ]).Resource == "*" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_diagnostics_permissions.json).Statement : statement
        if statement.Sid == "ValidateGootipPoliciesInConfiguredRegion"
      ]).Condition.StringEquals["aws:RequestedRegion"] == "us-east-2"
    )
    error_message = "Policy validation must remain a Region-scoped read-only Access Analyzer call."
  }

  assert {
    condition = (
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_diagnostics_permissions.json).Statement : statement
        if statement.Sid == "ReadGootipManagedPolicyVersions"
      ]).Action) == toset(["iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyVersions"]) &&
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_diagnostics_permissions.json).Statement : statement
        if statement.Sid == "ReadGootipManagedPolicyVersions"
        ]).Resource) == toset([
        "arn:aws:iam::${var.aws_account_id}:policy/gootip/bootstrap/GootipBootstrapAdminPermissions",
        "arn:aws:iam::${var.aws_account_id}:policy/gootip/bootstrap/GootipBootstrapPolicyAdminPermissions",
        "arn:aws:iam::${var.aws_account_id}:policy/gootip/bootstrap/GootipBootstrapStatePermissions",
        "arn:aws:iam::${var.aws_account_id}:policy/gootip/bootstrap/GootipBootstrapDiagnosticsPermissions",
        "arn:aws:iam::${var.aws_account_id}:policy/gootip/deployment/GootipTerraformDeployPermissions",
        "arn:aws:iam::${var.aws_account_id}:policy/gootip/deployment/GootipTerraformDeployAdministrativePassRole",
        "arn:aws:iam::${var.aws_account_id}:policy/gootip/deployment/GootipTerraformDeployNetworkPermissions",
        "arn:aws:iam::${var.aws_account_id}:policy/gootip/deployment/GootipTerraformDeployDatabasePermissions",
        "arn:aws:iam::${var.aws_account_id}:policy/gootip/deployment/GootipTerraformDeployDbConfigPermissions",
        "arn:aws:iam::${var.aws_account_id}:policy/gootip/operations/GootipDatabaseOperatorPermissions",
        "arn:aws:iam::${var.aws_account_id}:policy/gootip/bootstrap/GootipApplicationRuntimeBoundary",
        "arn:aws:iam::${var.aws_account_id}:policy/gootip/bootstrap/GootipSourceUserAssumeOnlyBoundary",
        "arn:aws:iam::${var.aws_account_id}:policy/gootip/bootstrap/GootipSourceUserAssumeOnly",
      ])
    )
    error_message = "The managed-policy inventory must cover exactly the Terraform-owned Gootip policies, including every SPEC 03.1 split policy."
  }

  assert {
    condition = (
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_diagnostics_permissions.json).Statement : statement
        if statement.Sid == "ReadGootipRoleAttachments"
      ]).Action) == toset(["iam:GetRole", "iam:ListAttachedRolePolicies", "iam:ListRolePolicies"]) &&
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.bootstrap_diagnostics_permissions.json).Statement : statement
        if statement.Sid == "ReadGootipRoleAttachments"
        ]).Resource) == toset([
        "arn:aws:iam::${var.aws_account_id}:role/gootip/bootstrap/GootipBootstrapAdmin",
        "arn:aws:iam::${var.aws_account_id}:role/gootip/deployment/GootipTerraformDeploy",
        "arn:aws:iam::${var.aws_account_id}:role/gootip/operations/GootipDatabaseOperator",
      ])
    )
    error_message = "The role-attachment inventory must cover exactly the Terraform-owned Gootip roles."
  }
}

# SPEC 03.1 scope: with the SPEC 02.3 flag off, the diagnostics policy must
# render exactly as it already exists in AWS, so none of the SPEC 03.1 applies
# carries a diagnostics delta.
run "bootstrap_diagnostics_inventory_is_deferred" {
  command = plan

  assert {
    condition = (
      length(jsondecode(data.aws_iam_policy_document.bootstrap_diagnostics_permissions.json).Statement) == 1 &&
      jsondecode(data.aws_iam_policy_document.bootstrap_diagnostics_permissions.json).Statement[0].Sid == "LookupFoundationCloudTrailEventsInRegion"
    )
    error_message = "SPEC 03.1 must render the diagnostics policy exactly as it exists in AWS: the CloudTrail lookup and nothing else."
  }

  assert {
    condition = length([
      for statement in jsondecode(data.aws_iam_policy_document.bootstrap_diagnostics_permissions.json).Statement : statement
      if contains(flatten([statement.Action]), "access-analyzer:ValidatePolicy")
    ]) == 0
    error_message = "The SPEC 02.3 policy-validation authorization must not be introduced by any SPEC 03.1 apply."
  }
}

run "split_policies_are_attached_with_exact_identity" {
  command = plan

  variables {
    eligibility_gate_passed             = true
    account_resource_phase_enabled      = true
    foundation_policy_expansion_enabled = true
    secrets_manager_kms_key_arn         = "arn:aws:kms:us-east-2:${var.aws_account_id}:key/00000000-0000-0000-0000-000000000000"
  }

  assert {
    condition = (
      aws_iam_policy.deployment_network_permissions[0].name == "GootipTerraformDeployNetworkPermissions" &&
      aws_iam_policy.deployment_network_permissions[0].path == "/gootip/deployment/" &&
      aws_iam_policy.deployment_database_permissions[0].name == "GootipTerraformDeployDatabasePermissions" &&
      aws_iam_policy.deployment_database_permissions[0].path == "/gootip/deployment/" &&
      aws_iam_policy.bootstrap_policy_admin_permissions.name == "GootipBootstrapPolicyAdminPermissions" &&
      aws_iam_policy.bootstrap_policy_admin_permissions.path == "/gootip/bootstrap/"
    )
    error_message = "Every split policy must use its exact managed-policy name and path."
  }

  assert {
    condition = (
      aws_iam_role_policy_attachment.deployment_network_permissions[0].role == "GootipTerraformDeploy" &&
      aws_iam_role_policy_attachment.deployment_database_permissions[0].role == "GootipTerraformDeploy" &&
      aws_iam_role_policy_attachment.bootstrap_policy_admin_permissions.role == "GootipBootstrapAdmin"
    )
    error_message = "The split policies must attach only to their owning role."
  }
}

run "spec10_api_capabilities_are_closed_without_prepared_api_id" {
  command = plan

  variables {
    api_gateway_id                       = null
    api_gateway_read_id                  = null
    api_gateway_core_permissions_enabled = false
  }

  assert {
    condition = (
      length([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement
        if !contains([
          "CreateOnlyTaggedGootipHttpApi",
          "TagOnlyNewGootipHttpApi",
          "ReadExactCoreLambdaLogEvents",
          "ListExactCoreFunctionUrlConfigs",
        ], statement.Sid)
      ]) == 0 &&
      length([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement
        if statement.Sid == "ReadOnlyExactPreparedGootipHttpApi"
      ]) == 0 &&
      length([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_application_permissions.json).Statement : statement
        if statement.Sid == "ManageOnlyPreparedApiRoutePermissions"
      ]) == 0 &&
      length([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_application_permissions.json).Statement : statement
        if statement.Sid == "ManageAuthApiLogDeliveryInRegion"
      ]) == 0 &&
      !contains(flatten([for statement in jsondecode(data.aws_iam_policy_document.deployment_application_permissions.json).Statement : statement.Action]), "lambda:RemovePermission")
    )
    error_message = "Without an exact prepared API ID, stage/routes and Lambda invocation grants must remain closed."
  }

  assert {
    condition = (
      length(jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement) < 8 &&
      length(jsonencode(jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json))) < 6144 &&
      length(jsonencode(jsondecode(data.aws_iam_policy_document.deployment_application_permissions.json))) < 6144
    )
    error_message = "The exact API capability policies must stay within IAM managed-policy size limits."
  }
}

run "spec10_core_verification_reads_are_exact" {
  command = plan

  variables {
    api_gateway_id                       = "a1b2c3d4e5"
    api_gateway_read_id                  = "a1b2c3d4e5"
    api_gateway_core_permissions_enabled = false
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement
        if statement.Sid == "ReadExactCoreLambdaLogEvents"
      ]).Resource == local.api_observability_log_group_arns[0] &&
      contains(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement
        if statement.Sid == "ReadExactCoreLambdaLogEvents"
      ]).Action, "logs:FilterLogEvents") &&
      contains(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement
        if statement.Sid == "ReadExactCoreLambdaLogEvents"
      ]).Action, "logs:Unmask") &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement
        if statement.Sid == "ListExactCoreFunctionUrlConfigs"
      ]).Resource == local.core_api_function_arn &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement
        if statement.Sid == "ListExactCoreFunctionUrlConfigs"
      ]).Action == "lambda:ListFunctionUrlConfigs"
    )
    error_message = "SPEC 10 live reads must remain limited to the exact Core log group and Core function."
  }

  assert {
    condition     = length(jsonencode(jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json))) < 6144
    error_message = "The exact Core verification read policy must stay within IAM managed-policy size limits."
  }
}

run "spec10_api_capabilities_bind_to_exact_prepared_api_id" {
  command = plan

  variables {
    api_gateway_id                       = "a1b2c3d4e5"
    api_gateway_read_id                  = "a1b2c3d4e5"
    api_gateway_core_permissions_enabled = false
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement
        if statement.Sid == "ReadOnlyExactPreparedGootipHttpApi"
      ]).Action == "apigateway:GET" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement
        if statement.Sid == "ReadOnlyExactPreparedGootipHttpApi"
      ]).Resource == "arn:aws:apigateway:us-east-2::/apis/a1b2c3d4e5" &&
      contains(flatten([for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement.Action]), "apigateway:POST") &&
      alltrue([
        for resource in flatten([for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement.Resource]) :
        resource == "arn:aws:apigateway:us-east-2::/apis" ||
        resource == "arn:aws:apigateway:us-east-2::/tags/arn%3Aaws%3Aapigateway%3Aus-east-2%3A%3A%2Fv2%2Fapis%2F*" ||
        resource == local.api_observability_log_group_arns[0] ||
        resource == local.core_api_function_arn ||
        can(regex("^arn:aws:apigateway:us-east-2::/apis/a1b2c3d4e5(/|$)", resource))
      ]) &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement
        if statement.Sid == "TagOnlyNewGootipHttpApi"
      ]).Action == "apigateway:POST" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement
        if statement.Sid == "TagOnlyNewGootipHttpApi"
      ]).Resource == "arn:aws:apigateway:us-east-2::/tags/arn%3Aaws%3Aapigateway%3Aus-east-2%3A%3A%2Fv2%2Fapis%2F*" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement
        if statement.Sid == "TagOnlyNewGootipHttpApi"
      ]).Condition.StringEquals["aws:RequestTag/Name"] == "gootip-auth-dev" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement
        if statement.Sid == "TagOnlyNewGootipHttpApi"
      ]).Condition.StringEquals["aws:RequestTag/project"] == "gootip" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement
        if statement.Sid == "TagOnlyNewGootipHttpApi"
      ]).Condition.StringEquals["aws:RequestTag/env"] == "dev" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement
        if statement.Sid == "TagOnlyNewGootipHttpApi"
      ]).Condition.StringEquals["aws:RequestTag/managed_by"] == "terraform" &&
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement
        if statement.Sid == "TagOnlyNewGootipHttpApi"
      ]).Condition["ForAllValues:StringEquals"]["aws:TagKeys"]) == toset(["Name", "project", "env", "managed_by"]) &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement
        if statement.Sid == "TagOnlyNewGootipHttpApi"
      ]).Condition.Null["aws:TagKeys"] == "false"
    )
    error_message = "API Gateway operations must target only the exact prepared API ID."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement
        if statement.Sid == "TagOnlyDefaultStageOnPreparedApi"
      ]).Action == "apigateway:TagResource" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement
        if statement.Sid == "TagOnlyDefaultStageOnPreparedApi"
      ]).Resource == "arn:aws:apigateway:us-east-2::/apis/a1b2c3d4e5/stages" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement
        if statement.Sid == "TagOnlyDefaultStageOnPreparedApi"
      ]).Condition.StringEquals["aws:RequestTag/Name"] == "gootip-auth-dev-default" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement
        if statement.Sid == "TagOnlyDefaultStageOnPreparedApi"
      ]).Condition.Null["aws:TagKeys"] == "false"
    )
    error_message = "Stage tagging must target only the exact prepared API stage collection with required tags."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_application_permissions.json).Statement : statement
        if statement.Sid == "ManageOnlyPreparedApiRoutePermissions"
      ]).Resource == "arn:aws:lambda:us-east-2:${var.aws_account_id}:function:gootip-auth-dev" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_application_permissions.json).Statement : statement
        if statement.Sid == "ManageOnlyPreparedApiRoutePermissions"
      ]).Condition.StringEquals["lambda:Principal"] == "apigateway.amazonaws.com" &&
      !can(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_application_permissions.json).Statement : statement
        if statement.Sid == "ManageOnlyPreparedApiRoutePermissions"
      ]).Condition.ArnLike["lambda:SourceArn"]) &&
      length([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_application_permissions.json).Statement : statement
        if statement.Sid == "ManageOnlyPreparedCoreApiRoutePermissions"
      ]) == 0
    )
    error_message = "Auth preparation must not grant Lambda invocation management for Core routes."
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_application_permissions.json).Statement : statement
        if statement.Sid == "ReadExactApiFunctionVersions"
      ]).Action == "lambda:ListVersionsByFunction" &&
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_application_permissions.json).Statement : statement
        if statement.Sid == "ReadExactApiFunctionVersions"
        ]).Resource) == toset([
        "arn:aws:lambda:us-east-2:${var.aws_account_id}:function:gootip-auth-dev",
        "arn:aws:lambda:us-east-2:${var.aws_account_id}:function:gootip-core-dev",
      ]) &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_application_permissions.json).Statement : statement
        if statement.Sid == "ReadAuthMigrationAlias"
      ]).Resource == "arn:aws:lambda:us-east-2:${var.aws_account_id}:function:gootip-dev-auth-migrations:deployment" &&
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_application_permissions.json).Statement : statement
        if statement.Sid == "ReadExactAuthApiLogs"
        ]).Resource) == toset([
        "arn:aws:logs:us-east-2:${var.aws_account_id}:log-group:/aws/apigateway/gootip-dev-auth",
        "arn:aws:logs:us-east-2:${var.aws_account_id}:log-group:/aws/lambda/gootip-auth-dev",
      ]) &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_application_permissions.json).Statement : statement
        if statement.Sid == "ReadExactAuthApiLogStreams"
      ]).Action == "logs:GetLogEvents"
    )
    error_message = "Auth verification reads must be limited to the exact Auth API, migration alias, and Auth log groups."
  }

  assert {
    condition     = length(jsonencode(jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json))) < 6144
    error_message = "The API Gateway deployment capability must remain within the IAM policy size quota."
  }

  assert {
    condition     = length(jsonencode(jsondecode(data.aws_iam_policy_document.deployment_application_permissions.json))) < 6144
    error_message = "The application deployment capability must remain within the IAM policy size quota."
  }

  assert {
    condition = (
      toset(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_application_permissions.json).Statement : statement
        if statement.Sid == "ManageAuthApiLogDeliveryInRegion"
        ]).Action) == toset([
        "logs:CreateLogDelivery",
        "logs:DeleteLogDelivery",
        "logs:DescribeLogGroups",
        "logs:DescribeResourcePolicies",
        "logs:GetLogDelivery",
        "logs:ListLogDeliveries",
        "logs:PutResourcePolicy",
        "logs:UpdateLogDelivery",
      ]) &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_application_permissions.json).Statement : statement
        if statement.Sid == "ManageAuthApiLogDeliveryInRegion"
      ]).Resource == "*" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_application_permissions.json).Statement : statement
        if statement.Sid == "ManageAuthApiLogDeliveryInRegion"
      ]).Condition.StringEquals["aws:RequestedRegion"] == "us-east-2"
    )
    error_message = "Auth API log delivery must use only the reviewed actions and exact Region condition."
  }
}

run "spec10_api_read_grant_does_not_enable_api_management" {
  command = plan

  variables {
    api_gateway_id      = null
    api_gateway_read_id = "a1b2c3d4e5"
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement
        if statement.Sid == "ReadOnlyExactPreparedGootipHttpApi"
      ]).Action == "apigateway:GET" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement
        if statement.Sid == "ReadOnlyExactPreparedGootipHttpApi"
      ]).Resource == "arn:aws:apigateway:us-east-2::/apis/a1b2c3d4e5" &&
      length([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement
        if contains(["ManageOnlyPreparedGootipHttpApi", "CreateOnlyPreparedApiResources", "CreateOnlyJwtAuthorizersOnPreparedApi", "CreateOnlyTaggedDefaultStageOnPreparedApi"], statement.Sid)
      ]) == 0 &&
      !contains(flatten([for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement.Action]), "apigateway:PATCH")
    )
    error_message = "Read reconciliation must grant GET only on the exact API and must not enable API management."
  }
}

run "spec10_core_api_route_permissions_are_separately_opted_in" {
  command = plan

  variables {
    api_gateway_id                       = "a1b2c3d4e5"
    api_gateway_read_id                  = null
    api_gateway_core_permissions_enabled = true
  }

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement
        if statement.Sid == "ManageOnlyPreparedCoreApiRoutePermissions"
      ]).Action == "lambda:AddPermission" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement
        if statement.Sid == "ManageOnlyPreparedCoreApiRoutePermissions"
      ]).Resource == "arn:aws:lambda:us-east-2:${var.aws_account_id}:function:gootip-core-dev" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement
        if statement.Sid == "ManageOnlyPreparedCoreApiRoutePermissions"
      ]).Condition.StringEquals["lambda:Principal"] == "apigateway.amazonaws.com" &&
      !can(one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_api_gateway_permissions.json).Statement : statement
        if statement.Sid == "ManageOnlyPreparedCoreApiRoutePermissions"
      ]).Condition.ArnLike["lambda:SourceArn"])
    )
    error_message = "Core invocation grants must be a separate opt-in scoped to the exact API and Core function."
  }
}
