output "api_url" {
  description = "Shared HTTP API origin after route-less preparation or reviewed API activation."
  value       = try(aws_apigatewayv2_api.main[0].api_endpoint, null)
}

output "core_api_function_name" {
  description = "Physical name of the isolated Core API Lambda after its separately reviewed activation."
  value       = try(aws_lambda_function.gootip_core[0].function_name, null)
}

output "db_config_function_name" {
  description = "Physical name of the administrative database bootstrap function after its SPEC 03 deployment."
  value       = try(aws_lambda_function.gootip_db_config[0].function_name, null)
}

output "auth_migrations_deployment_alias_arn" {
  description = "Exact private auth migration deployment-alias ARN after SPEC 04 deployment."
  value       = try(aws_lambda_alias.auth_migrations_deployment[0].arn, null)
}

output "auth_migrations_baseline_alias_arn" {
  description = "Exact private auth migration baseline-alias ARN after SPEC 04 deployment."
  value       = try(aws_lambda_alias.auth_migrations_baseline[0].arn, null)
}

output "core_migrations_deployment_alias_arn" {
  description = "Exact private Core migration deployment-alias ARN when SPEC 06 is enabled."
  value       = try(aws_lambda_alias.core_migrations_deployment[0].arn, null)
}

output "db_tunnel_instance_id" {
  description = "Exact private database tunnel instance ID when SPEC 05.2 database access is enabled."
  value       = var.database_operator_access_enabled ? aws_instance.db_tunnel[0].id : null
}

output "db_instance_connect_endpoint_id" {
  description = "Exact private EC2 Instance Connect Endpoint ID when SPEC 05.2 database access is enabled."
  value       = var.database_operator_access_enabled ? aws_ec2_instance_connect_endpoint.db_tunnel[0].id : null
}

output "db_endpoint" {
  description = "Private RDS PostgreSQL endpoint when SPEC 05.2 database access is enabled."
  value       = var.database_operator_access_enabled ? aws_db_instance.main.endpoint : null
}

output "operational_alarms_topic_arn" {
  description = "SNS topic ARN for current operational alarm notifications and SPEC 10 handoff."
  value       = aws_sns_topic.operational_alarms.arn
}
