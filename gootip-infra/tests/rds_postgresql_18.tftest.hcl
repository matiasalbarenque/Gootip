mock_provider "aws" {
  mock_data "aws_rds_engine_version" {
    defaults = {
      latest                 = true
      parameter_group_family = "postgres18"
      version                = "18.6"
    }
  }

  mock_data "aws_availability_zones" {
    defaults = {
      names = ["us-east-2a", "us-east-2b", "us-east-2c"]
    }
  }

  # This RDS test does not exercise the endpoint policy; give the mocked data
  # source valid, fail-closed JSON so the mock provider does not invent a string.
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"*\",\"Resource\":\"*\"}]}"
    }
  }
}

mock_provider "aws" {
  alias = "billing"
}

run "postgresql_18_lifecycle_contract" {
  command = plan

  variables {
    aws_account_id                               = "123456789012"
    rds_final_snapshot_identifier                = "gootip-dev-final"
    alarm_notification_email                     = "operator@example.com"
    rds_max_connections                          = 81
    monthly_cost_budget_usd                      = 10
    monthly_cost_budget_actual_threshold_percent = 80
    rds_engine_version                           = "18"
    rds_parameter_group_family                   = "postgres18"
  }

  assert {
    condition = (
      var.rds_engine_version == "18" &&
      data.aws_rds_engine_version.postgres.latest == true &&
      data.aws_rds_engine_version.postgres.parameter_group_family == "postgres18"
    )
    error_message = "RDS PostgreSQL must track major version 18 and resolve the latest engine metadata in the postgres18 family."
  }

  assert {
    condition = (
      aws_db_instance.main.identifier == "gootip-dev" &&
      aws_db_instance.main.engine_version == "18" &&
      aws_db_instance.main.instance_class == "db.t3.micro" &&
      aws_db_instance.main.multi_az == false &&
      aws_db_instance.main.publicly_accessible == false &&
      aws_db_instance.main.auto_minor_version_upgrade == true &&
      aws_db_instance.main.allow_major_version_upgrade == true &&
      aws_db_instance.main.apply_immediately == false &&
      aws_db_instance.main.maintenance_window == "sun:03:00-sun:04:00" &&
      aws_db_instance.main.backup_retention_period == 1 &&
      aws_db_instance.main.deletion_protection == true &&
      aws_db_instance.main.storage_encrypted == true
    )
    error_message = "The PostgreSQL 18 upgrade must preserve the private Single-AZ instance and protected backups while scheduling, not immediately applying, the upgrade."
  }

  assert {
    condition = (
      aws_db_parameter_group.postgres18.name == "gootip-dev-postgres18" &&
      aws_db_parameter_group.postgres18.family == "postgres18" &&
      one(aws_db_parameter_group.postgres18.parameter).name == "rds.force_ssl" &&
      one(aws_db_parameter_group.postgres18.parameter).value == "1" &&
      aws_db_instance.main.parameter_group_name == aws_db_parameter_group.postgres18.name
    )
    error_message = "The PostgreSQL 18 parameter group must preserve enforced TLS and be the instance's only parameter group."
  }

  assert {
    condition = (
      aws_db_parameter_group.main.name == "gootip-dev-postgres" &&
      aws_db_parameter_group.main.family == "postgres17" &&
      one(aws_db_parameter_group.main.parameter).name == "rds.force_ssl" &&
      one(aws_db_parameter_group.main.parameter).value == "1"
    )
    error_message = "The PostgreSQL 17 parameter group must stay managed and unchanged until the separate cleanup plan."
  }
}
