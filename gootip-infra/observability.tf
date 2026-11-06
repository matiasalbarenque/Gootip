locals {
  operational_alarm_source_arns = concat(
    [
      "arn:aws:cloudwatch:${var.aws_region}:${var.aws_account_id}:alarm:${var.project}-${var.env}-auth-migrations-errors",
      "arn:aws:cloudwatch:${var.aws_region}:${var.aws_account_id}:alarm:${var.project}-${var.env}-rds-cpu",
      "arn:aws:cloudwatch:${var.aws_region}:${var.aws_account_id}:alarm:${var.project}-${var.env}-rds-database-connections",
    ],
    var.core_runtime_deployment_enabled ? [
      "arn:aws:cloudwatch:${var.aws_region}:${var.aws_account_id}:alarm:${var.project}-${var.env}-core-api-errors",
      "arn:aws:cloudwatch:${var.aws_region}:${var.aws_account_id}:alarm:${var.project}-${var.env}-core-api-throttles",
    ] : [],
    var.application_runtime_deployment_enabled || var.core_runtime_deployment_enabled ? [
      "arn:aws:cloudwatch:${var.aws_region}:${var.aws_account_id}:alarm:${var.project}-${var.env}-api-5xx",
    ] : [],
  )
}

resource "aws_cloudwatch_log_group" "auth_migrations" {
  count = var.auth_migrations_deployment_enabled ? 1 : 0

  name              = "/aws/lambda/${var.project}-${var.env}-auth-migrations"
  retention_in_days = 7

  tags = {
    Name       = "${var.project}-${var.env}-auth-migrations"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_cloudwatch_log_group" "core_migrations" {
  count = var.core_migrations_deployment_enabled ? 1 : 0

  name              = "/aws/lambda/${var.project}-${var.env}-core-migrations"
  retention_in_days = 7

  tags = {
    Name       = "${var.project}-${var.env}-core-migrations"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

data "aws_iam_policy_document" "operational_alarms_topic" {
  statement {
    sid       = "AllowCloudWatchAlarmsToPublish"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.operational_alarms.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.aws_account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = local.operational_alarm_source_arns
    }
  }
}

resource "aws_sns_topic" "operational_alarms" {
  name = "${var.project}-${var.env}-operational-alarms"

  tags = {
    Name       = "${var.project}-${var.env}-operational-alarms"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_sns_topic_policy" "operational_alarms" {
  arn    = aws_sns_topic.operational_alarms.arn
  policy = data.aws_iam_policy_document.operational_alarms_topic.json
}

resource "aws_sns_topic_subscription" "operational_alarms_email" {
  topic_arn = aws_sns_topic.operational_alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_notification_email
}

resource "aws_budgets_budget" "monthly_actual_cost" {
  provider = aws.billing

  name         = "${var.project}-${var.env}-monthly-actual-cost"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_cost_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_types {
    include_credit = false
    include_refund = false
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    notification_type          = "ACTUAL"
    threshold                  = var.monthly_cost_budget_actual_threshold_percent
    threshold_type             = "PERCENTAGE"
    subscriber_email_addresses = [var.alarm_notification_email]
  }

  tags = {
    Name       = "${var.project}-${var.env}-monthly-actual-cost"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_cloudwatch_metric_alarm" "auth_migrations_errors" {
  count = var.auth_migrations_deployment_enabled ? 1 : 0

  alarm_name          = "${var.project}-${var.env}-auth-migrations-errors"
  alarm_description   = "Authentication migration Lambda reported one or more errors in one minute."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = var.auth_migrations_errors_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.auth_migrations[0].function_name
  }

  alarm_actions = [aws_sns_topic.operational_alarms.arn]

  tags = {
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_cloudwatch_log_group" "core_api" {
  count = var.core_runtime_deployment_enabled ? 1 : 0

  name              = "/aws/lambda/gootip-core-${var.env}"
  retention_in_days = 7

  tags = {
    Name       = "gootip-core-${var.env}"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_cloudwatch_metric_alarm" "core_api_errors" {
  count = var.core_runtime_deployment_enabled ? 1 : 0

  alarm_name          = "${var.project}-${var.env}-core-api-errors"
  alarm_description   = "Core API Lambda reported one or more errors in one minute."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.gootip_core[0].function_name
  }

  alarm_actions = [aws_sns_topic.operational_alarms.arn]

  tags = {
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_cloudwatch_metric_alarm" "core_api_throttles" {
  count = var.core_runtime_deployment_enabled ? 1 : 0

  alarm_name          = "${var.project}-${var.env}-core-api-throttles"
  alarm_description   = "Core API Lambda was throttled in one minute."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.gootip_core[0].function_name
  }

  alarm_actions = [aws_sns_topic.operational_alarms.arn]

  tags = {
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  count = var.application_runtime_deployment_enabled || var.core_runtime_deployment_enabled ? 1 : 0

  alarm_name          = "${var.project}-${var.env}-api-5xx"
  alarm_description   = "The development HTTP API returned one or more 5xx responses in one minute."
  namespace           = "AWS/ApiGateway"
  metric_name         = "5xx"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    ApiId = aws_apigatewayv2_api.main[0].id
    Stage = "$default"
  }

  alarm_actions = [aws_sns_topic.operational_alarms.arn]

  tags = {
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${var.project}-${var.env}-rds-cpu"
  alarm_description   = "RDS average CPU utilization exceeded the configured threshold for two consecutive five-minute periods."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = var.rds_cpu_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.identifier
  }

  alarm_actions = [aws_sns_topic.operational_alarms.arn]

  tags = {
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_cloudwatch_metric_alarm" "rds_database_connections" {
  alarm_name          = "${var.project}-${var.env}-rds-database-connections"
  alarm_description   = "RDS connections exceeded the initial limit; the threshold retains ${var.rds_max_connections - var.rds_database_connections_threshold - 1} connections below effective max_connections."
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnections"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = var.rds_database_connections_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.identifier
  }

  alarm_actions = [aws_sns_topic.operational_alarms.arn]

  tags = {
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

# Project convention uses AWS-managed encryption and forbids new customer KMS
# keys; CloudWatch Logs applies its AWS-owned key by default.
#trivy:ignore:AVD-AWS-0017
resource "aws_cloudwatch_log_group" "gootip_auth" {
  name              = "/aws/lambda/gootip-auth-${var.env}"
  retention_in_days = 7

  tags = {
    Name       = "gootip-auth-${var.env}"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

# Project convention uses AWS-managed encryption and forbids new customer KMS
# keys; CloudWatch Logs applies its AWS-owned key by default.
#trivy:ignore:AVD-AWS-0017
resource "aws_cloudwatch_log_group" "db_config" {
  name              = "/aws/lambda/lambda_db_config"
  retention_in_days = 7

  tags = {
    Name       = "lambda-db-config"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

# Project convention uses AWS-managed encryption and forbids new customer KMS
# keys; CloudWatch Logs applies its AWS-owned key by default.
#trivy:ignore:AVD-AWS-0017
resource "aws_cloudwatch_log_group" "api_access" {
  name              = "/aws/apigateway/${var.project}-${var.env}-auth"
  retention_in_days = 7

  tags = {
    Name       = "${var.project}-${var.env}-auth-api-access"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}
