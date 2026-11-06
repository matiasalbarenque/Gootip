resource "aws_secretsmanager_secret" "application" {
  count = var.account_resource_phase_enabled ? 1 : 0

  name                    = "${var.project}-auth-${var.env}"
  description             = "Application runtime secrets for gootip-auth. Values are managed outside Terraform."
  recovery_window_in_days = 30

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name       = "${var.project}-auth-${var.env}"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

# Empty authentication-role containers. Terraform creates the containers only;
# the operator loads each username/password pair out of band, and the values are
# never readable through Terraform or the deployment role.
resource "aws_secretsmanager_secret" "auth_runtime" {
  count = var.account_resource_phase_enabled ? 1 : 0

  name                    = "${var.project}-${var.env}-auth-runtime"
  description             = "auth_runtime database credential for the administrative bootstrap. Values are managed outside Terraform."
  recovery_window_in_days = 30

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name       = "${var.project}-${var.env}-auth-runtime"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }

  depends_on = [aws_iam_role_policy.role_secret_creation]
}

resource "aws_secretsmanager_secret" "auth_migrator" {
  count = var.account_resource_phase_enabled ? 1 : 0

  name                    = "${var.project}-${var.env}-auth-migrator"
  description             = "auth_migrator database credential for the administrative bootstrap. Values are managed outside Terraform."
  recovery_window_in_days = 30

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name       = "${var.project}-${var.env}-auth-migrator"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }

  depends_on = [aws_iam_role_policy.role_secret_creation]
}

resource "aws_secretsmanager_secret" "core_runtime" {
  count = var.account_resource_phase_enabled && local.core_role_secret_in_scope ? 1 : 0

  name                    = "${var.project}-${var.env}-core-runtime"
  description             = "core_runtime database credential. Values are managed outside Terraform."
  recovery_window_in_days = 30

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name       = "${var.project}-${var.env}-core-runtime"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }

  depends_on = [aws_iam_role_policy.core_role_secret_creation]
}

resource "aws_secretsmanager_secret" "core_migrator" {
  count = var.account_resource_phase_enabled && local.core_role_secret_in_scope ? 1 : 0

  name                    = "${var.project}-${var.env}-core-migrator"
  description             = "core_migrator database credential. Values are managed outside Terraform."
  recovery_window_in_days = 30

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name       = "${var.project}-${var.env}-core-migrator"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }

  depends_on = [aws_iam_role_policy.core_role_secret_creation]
}

# SPEC 05.1 empty operator container. Terraform creates the container only; the
# operator loads the username/password pair out of band, and neither Terraform
# nor the deployment role can read the value. The container exists only while the
# operator-secret phase is active (its reviewed creation flag or its reviewed
# ARN), so it is absent from the earlier SPEC 03.1 transition configuration.
resource "aws_secretsmanager_secret" "database_operator" {
  count = var.account_resource_phase_enabled && local.database_operator_secret_in_scope ? 1 : 0

  name                    = local.database_operator_secret_name
  description             = "gootip_dev_operator database credential for interactive administration. Values are managed outside Terraform."
  recovery_window_in_days = 30

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name       = local.database_operator_secret_name
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }

  depends_on = [aws_iam_role_policy.database_operator_secret_creation]
}

data "aws_iam_policy_document" "bootstrap_application_secret_permissions" {
  count = var.account_resource_phase_enabled ? 1 : 0

  lifecycle {
    # Container creation and manual value access must never coexist. The reviewed
    # second apply flips role_secret_creation_enabled to false and supplies the
    # two exact ARNs in the same change. The operator container follows the same
    # rule through its own creation flag and ARN.
    precondition {
      condition = (
        (var.auth_runtime_secret_arn == null || var.auth_migrator_secret_arn == null || !var.role_secret_creation_enabled) &&
        (var.db_operator_secret_arn == null || !var.database_operator_secret_creation_enabled) &&
        (var.core_runtime_secret_arn == null || var.core_migrator_secret_arn == null || !var.core_role_secret_creation_enabled)
      )
      error_message = "A container-creation flag must be false before its reviewed secret ARN is supplied."
    }
  }

  # Container refresh and tag management for exactly the approved containers:
  # the application secret plus the two authentication-role secrets, and the
  # operator secret while its own phased workflow is active. While both reviewed
  # role-secret ARNs are unapproved the two containers are addressed by their
  # reviewed name patterns, so this statement never depends on the containers it
  # authorizes: the policy update is ordered before the container-creation apply,
  # and the AWS provider can read DescribeSecret and GetResourcePolicy
  # immediately after CreateSecret. The operator entry likewise appears as its
  # reviewed name pattern during its creation phase and as its exact ARN once
  # supplied.
  statement {
    sid    = "ManageExactApprovedSecretContainers"
    effect = "Allow"
    actions = [
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetResourcePolicy",
      "secretsmanager:TagResource",
      "secretsmanager:UntagResource",
    ]
    resources = concat(
      local.role_secret_arns_approved ? [var.auth_runtime_secret_arn, var.auth_migrator_secret_arn] : local.role_secret_arn_patterns,
      local.core_role_secret_in_scope ? (local.core_role_secret_arns_approved ? [var.core_runtime_secret_arn, var.core_migrator_secret_arn] : local.core_role_secret_arn_patterns) : [],
      local.database_operator_secret_in_scope ? (local.database_operator_secret_approved ? [var.db_operator_secret_arn] : [local.database_operator_secret_arn_pattern]) : [],
      [aws_secretsmanager_secret.application[0].arn],
    )
  }

  # Manual value operations on the approved containers. The role-secret and
  # operator entries appear only once their reviewed ARNs exist: each temporary
  # CreateSecret apply creates the empty containers without also granting
  # GetSecretValue or PutSecretValue on them. The reviewed variables are used
  # instead of the container resources so this statement never participates in a
  # policy/container dependency cycle. The RDS master secret is never loadable
  # here; it stays denied by the statement below.
  statement {
    sid     = "OperateExactApprovedSecretValues"
    effect  = "Allow"
    actions = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"]
    resources = concat(
      local.role_secret_arns_approved ? [var.auth_runtime_secret_arn, var.auth_migrator_secret_arn] : [],
      local.core_role_secret_arns_approved ? [var.core_runtime_secret_arn, var.core_migrator_secret_arn] : [],
      local.database_operator_secret_approved ? [var.db_operator_secret_arn] : [],
      [aws_secretsmanager_secret.application[0].arn],
    )
  }

  # The manual-value NotResource exception is the application secret only while
  # the role and operator containers are being created, and every approved
  # container once its reviewed ARN is supplied. Every other secret is denied for
  # the manual value actions. DescribeSecret is deliberately not denied here: Terraform
  # calls it (and GetResourcePolicy) immediately after creating a container and
  # on every refresh, so an explicit deny covering a container under creation
  # would fail the apply and every later plan. Container metadata stays with
  # ManageExactApprovedSecretContainers, and other secrets keep no allow at all.
  statement {
    sid    = "DenyEveryOtherSecret"
    effect = "Deny"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:PutSecretValue",
    ]
    not_resources = concat(
      local.role_secret_arns_approved ? [var.auth_runtime_secret_arn, var.auth_migrator_secret_arn] : [],
      local.core_role_secret_arns_approved ? [var.core_runtime_secret_arn, var.core_migrator_secret_arn] : [],
      local.database_operator_secret_approved ? [var.db_operator_secret_arn] : [],
      [aws_secretsmanager_secret.application[0].arn],
    )
  }

  dynamic "statement" {
    for_each = var.rds_master_secret_arn == null ? [] : [var.rds_master_secret_arn]

    content {
      sid    = "DenyRdsManagedMasterSecretOperations"
      effect = "Deny"
      actions = [
        "secretsmanager:DescribeSecret",
        "secretsmanager:GetSecretValue",
        "secretsmanager:BatchGetSecretValue",
        "secretsmanager:PutSecretValue",
        "secretsmanager:UpdateSecret",
        "secretsmanager:UpdateSecretVersionStage",
        "secretsmanager:RotateSecret",
        "secretsmanager:CancelRotateSecret",
        "secretsmanager:DeleteSecret",
        "secretsmanager:RestoreSecret",
        "secretsmanager:ReplicateSecretToRegions",
        "secretsmanager:RemoveRegionsFromReplication",
        "secretsmanager:GetResourcePolicy",
        "secretsmanager:PutResourcePolicy",
        "secretsmanager:DeleteResourcePolicy",
        "secretsmanager:TagResource",
        "secretsmanager:UntagResource",
      ]
      resources = [statement.value]
    }
  }
}
