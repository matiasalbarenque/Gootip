# Postgres in private subnets. The master password is generated and guarded
# by RDS (manage_master_user_password); Terraform never sees or stores it.
data "aws_rds_engine_version" "postgres" {
  engine                 = "postgres"
  version                = var.rds_engine_version
  latest                 = true
  parameter_group_family = var.rds_parameter_group_family
}

resource "aws_db_subnet_group" "main" {
  name       = "${var.project}-${var.env}"
  subnet_ids = aws_subnet.private[*].id

  tags = {
    Name       = "${var.project}-${var.env}"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

# Retained PostgreSQL 17 parameter group. The PostgreSQL 18 upgrade keeps it
# untouched so the first plan has no deletes; a separate reviewed cleanup plan
# removes it only after 18.6 is in-sync and the 24-48h observation passes.
resource "aws_db_parameter_group" "main" {
  name   = "${var.project}-${var.env}-postgres"
  family = "postgres17"

  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }

  tags = {
    Name       = "${var.project}-${var.env}-postgres"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_db_parameter_group" "postgres18" {
  name   = "${var.project}-${var.env}-postgres18"
  family = var.rds_parameter_group_family

  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }

  tags = {
    Name       = "${var.project}-${var.env}-postgres18"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

# SPEC 02.2 approves one-day backups for the active Free Plan; nonzero retention
# and deletion protection remain enabled.
# SPEC 06 explicitly defers Performance Insights for the low-cost dev baseline.
# SPEC 05.1 excludes RDS IAM database authentication; runtime uses its approved
# database credential model.
#trivy:ignore:AVD-AWS-0077
#trivy:ignore:AVD-AWS-0133
#trivy:ignore:AVD-AWS-0176
resource "aws_db_instance" "main" {
  identifier = "${var.project}-${var.env}"

  engine         = "postgres"
  engine_version = var.rds_engine_version
  instance_class = var.rds_instance_class

  db_name  = var.rds_db_name
  username = var.rds_db_user

  manage_master_user_password = true
  parameter_group_name        = aws_db_parameter_group.postgres18.name

  auto_minor_version_upgrade  = true
  allow_major_version_upgrade = true
  apply_immediately           = false
  maintenance_window          = "sun:03:00-sun:04:00"

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  multi_az               = false

  allocated_storage = 20
  storage_encrypted = true

  # The active AWS Free Plan limits this dev foundation to one day of
  # automated backups. Keep this nonzero so automated backups remain enabled.
  backup_retention_period   = 1
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = var.rds_final_snapshot_identifier

  lifecycle {
    precondition {
      condition     = data.aws_rds_engine_version.postgres.parameter_group_family == var.rds_parameter_group_family
      error_message = "The selected PostgreSQL engine version does not match rds_parameter_group_family in us-east-2."
    }
  }

  tags = {
    Name       = "${var.project}-${var.env}"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}
