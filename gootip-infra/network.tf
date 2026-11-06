# Dev VPC with two private RDS subnets and no public egress path. The single
# Secrets Manager interface endpoint is deliberately placed in one selected AZ.
data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name_prefix = "${var.project}-${var.env}"
  azs         = slice(data.aws_availability_zones.available.names, 0, 2)

  lambda_client_security_groups = merge(
    { application = aws_security_group.application_client.id },
    var.core_runtime_deployment_enabled ? { core_api = aws_security_group.core_api[0].id } : {},
    var.db_config_deployment_enabled ? { db_config = aws_security_group.db_config[0].id } : {},
    var.auth_migrations_deployment_enabled ? { auth_migrations = aws_security_group.auth_migrations[0].id } : {},
    var.core_migrations_deployment_enabled ? { core_migrations = aws_security_group.core_migrations[0].id } : {},
  )

  lambda_egress_security_groups = merge(
    { application = aws_security_group.application_client.id },
    var.core_runtime_deployment_enabled ? { core_api = aws_security_group.core_api[0].id } : {},
    var.db_config_deployment_enabled ? { db_config = aws_security_group.db_config[0].id } : {},
    var.auth_migrations_deployment_enabled ? { auth_migrations = aws_security_group.auth_migrations[0].id } : {},
  )

  secretsmanager_endpoint_consumers = merge(
    var.application_runtime_deployment_enabled ? {
      auth = {
        role_arn = "arn:aws:iam::${var.aws_account_id}:role/gootip/application/gootip-auth-${var.env}-lambda"
        secrets  = [var.app_secret_arn, var.auth_runtime_secret_arn]
      }
    } : {},
    var.core_runtime_deployment_enabled ? {
      core_api = {
        role_arn = "arn:aws:iam::${var.aws_account_id}:role/gootip/application/gootip-core-${var.env}-lambda"
        secrets  = [var.core_runtime_secret_arn]
      }
    } : {},
    var.db_config_deployment_enabled ? {
      db_config = {
        role_arn = aws_iam_role.db_config[0].arn
        secrets = [
          var.db_master_secret_arn,
          var.auth_runtime_secret_arn,
          var.auth_migrator_secret_arn,
          var.core_runtime_secret_arn,
          var.core_migrator_secret_arn,
          var.db_operator_secret_arn,
        ]
      }
    } : {},
    var.auth_migrations_deployment_enabled ? {
      auth_migrations = {
        role_arn = aws_iam_role.auth_migrations[0].arn
        secrets  = [var.auth_migrator_secret_arn]
      }
    } : {},
    var.core_migrations_deployment_enabled ? {
      core_migrations = {
        role_arn = aws_iam_role.core_migrations[0].arn
        secrets  = [var.core_migrator_secret_arn]
      }
    } : {},
  )
}

data "aws_iam_policy_document" "secretsmanager_endpoint" {
  dynamic "statement" {
    for_each = local.secretsmanager_endpoint_consumers

    content {
      sid       = "Allow${replace(statement.key, "_", "")}SecretReads"
      effect    = "Allow"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = statement.value.secrets

      principals {
        type        = "*"
        identifiers = ["*"]
      }

      condition {
        test     = "ArnEquals"
        variable = "aws:PrincipalArn"
        values   = [statement.value.role_arn]
      }
    }
  }
}

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name       = local.name_prefix
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index + 11)
  availability_zone = local.azs[count.index]

  tags = {
    Name       = "${local.name_prefix}-private-${count.index + 1}"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name       = "${local.name_prefix}-private"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# Reserved client security group for the future gootip-auth Lambda, which remains
# undeployed until SPEC 10. Its destination-specific rules are managed separately.
resource "aws_security_group" "application_client" {
  name        = "${local.name_prefix}-application-client"
  description = "Reserved egress-only security group for approved private application clients."
  vpc_id      = aws_vpc.main.id

  egress = []

  # Standalone rules below own egress; ignore the API-populated SG view.
  lifecycle {
    ignore_changes = [egress]
  }

  tags = {
    Name       = "${local.name_prefix}-application-client"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_security_group" "core_api" {
  count = var.core_runtime_deployment_enabled ? 1 : 0

  name        = "${local.name_prefix}-core-api-client"
  description = "Egress-only security group for the private Core API Lambda."
  vpc_id      = aws_vpc.main.id
  egress      = []

  lifecycle {
    ignore_changes = [egress]
  }

  tags = {
    Name       = "${local.name_prefix}-core-api-client"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

# Independent egress-only security group for the administrative database
# bootstrap function. Standalone rules restrict it to the RDS and Secrets Manager
# endpoint security groups without creating a dependency cycle.
resource "aws_security_group" "db_config" {
  count = var.db_config_deployment_enabled || var.db_config_security_group_retained ? 1 : 0

  name        = "${local.name_prefix}-db-config"
  description = "Egress-only security group for the administrative database bootstrap function."
  vpc_id      = aws_vpc.main.id

  egress = []

  # Standalone rules below own egress; ignore the API-populated SG view.
  lifecycle {
    ignore_changes = [egress]
  }

  tags = {
    Name       = "${local.name_prefix}-db-config"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_security_group" "auth_migrations" {
  count = var.auth_migrations_deployment_enabled ? 1 : 0

  name        = "${local.name_prefix}-auth-migrations"
  description = "Egress-only security group for the private auth migration Lambda."
  vpc_id      = aws_vpc.main.id

  egress = []

  # Standalone rules below own egress; ignore the API-populated SG view.
  lifecycle {
    ignore_changes = [egress]
  }

  tags = {
    Name       = "${local.name_prefix}-auth-migrations"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_security_group" "core_migrations" {
  count = var.core_migrations_deployment_enabled ? 1 : 0

  name        = "${local.name_prefix}-core-migrations"
  description = "Egress-only security group for the private Core migration Lambda."
  vpc_id      = aws_vpc.main.id
  egress      = []

  # The two egress rules are managed by standalone resources; ignore the
  # API-populated view so refresh does not revoke those rules.
  lifecycle {
    ignore_changes = [egress]
  }

  tags = {
    Name       = "${local.name_prefix}-core-migrations"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

# Core's destination-specific egress rules already have dedicated Terraform
# addresses above, so it is omitted from the generated client-egress rules below.
resource "aws_vpc_security_group_egress_rule" "core_migrations_to_rds_postgres" {
  count = var.core_migrations_deployment_enabled ? 1 : 0

  security_group_id            = aws_security_group.core_migrations[0].id
  referenced_security_group_id = aws_security_group.rds.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL to the existing RDS security group."
}

resource "aws_vpc_security_group_egress_rule" "core_migrations_to_secretsmanager" {
  count = var.core_migrations_deployment_enabled ? 1 : 0

  security_group_id            = aws_security_group.core_migrations[0].id
  referenced_security_group_id = aws_security_group.endpoints.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "HTTPS to the existing Secrets Manager endpoint security group."
}

# RDS security group. PostgreSQL ingress is limited to explicitly approved client
# groups, with each Lambda group conditional on its capability being enabled.
resource "aws_security_group" "rds" {
  name        = "${local.name_prefix}-rds"
  description = "PostgreSQL access restricted to approved private application clients."
  vpc_id      = aws_vpc.main.id

  ingress = []
  egress  = []

  # All RDS ingress is managed by standalone rules to avoid mutual SG cycles.
  lifecycle {
    ignore_changes = [ingress]
  }

  # When the temporary db-config group is disabled, remove its ingress reference
  # before Terraform deletes the group and its Lambda-created network interfaces.
  depends_on = [aws_security_group.db_config]

  tags = {
    Name       = "${local.name_prefix}-rds"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

# Security group for the Secrets Manager interface endpoint. HTTPS ingress is
# limited to the reserved application client and enabled Lambda client groups.
resource "aws_security_group" "endpoints" {
  name        = "${local.name_prefix}-endpoints"
  description = "HTTPS access to the Secrets Manager endpoint from approved private application clients."
  vpc_id      = aws_vpc.main.id

  ingress = []
  egress  = []

  lifecycle {
    ignore_changes = [ingress]
  }

  tags = {
    Name       = "${local.name_prefix}-endpoints"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

# Client rules reference destination security groups instead of the VPC CIDR.
# Standalone rules avoid mutual SG references and preserve one edge per client.
resource "aws_vpc_security_group_egress_rule" "lambda_to_rds_postgres" {
  for_each = local.lambda_egress_security_groups

  security_group_id            = each.value
  referenced_security_group_id = aws_security_group.rds.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL to the existing RDS security group."
}

resource "aws_vpc_security_group_egress_rule" "lambda_to_secretsmanager" {
  for_each = local.lambda_egress_security_groups

  security_group_id            = each.value
  referenced_security_group_id = aws_security_group.endpoints.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "HTTPS to the Secrets Manager endpoint security group."
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_lambda_clients" {
  for_each = local.lambda_client_security_groups

  security_group_id            = aws_security_group.rds.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL from an approved private Lambda client."
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_database_operator" {
  for_each = var.database_operator_access_enabled ? { operator = true } : {}

  security_group_id            = aws_security_group.rds.id
  referenced_security_group_id = aws_security_group.db_tunnel[0].id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL from the private tunnel host only."
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_from_lambda_clients" {
  for_each = local.lambda_client_security_groups

  security_group_id            = aws_security_group.endpoints.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "HTTPS from an approved private Lambda client."
}

resource "aws_vpc_endpoint" "secretsmanager" {
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.aws_region}.secretsmanager"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.private[var.secretsmanager_endpoint_subnet_index].id]
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
  policy              = data.aws_iam_policy_document.secretsmanager_endpoint.json

  depends_on = [
    aws_iam_role.lambda,
    aws_iam_role.core_api,
  ]

  tags = {
    Name       = "${local.name_prefix}-secretsmanager"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}
