output "bootstrap_role_arn" {
  description = "ARN of the MFA-protected bootstrap administration role."
  value       = aws_iam_role.bootstrap_admin.arn
}

output "deployment_role_arn" {
  description = "ARN of the MFA-protected Terraform deployment role."
  value       = aws_iam_role.terraform_deploy.arn
}

output "application_runtime_boundary_arn" {
  description = "ARN of the bootstrap-owned permissions boundary for application runtime roles."
  value       = aws_iam_policy.application_runtime_boundary.arn
}

output "state_bucket_name" {
  description = "Account-qualified Terraform state bucket name."
  value       = local.state_bucket_name
}

output "bootstrap_state_key" {
  description = "Canonical bootstrap state object key."
  value       = local.bootstrap_state_key
}

output "application_state_key" {
  description = "Canonical application state object key."
  value       = local.application_state_key
}

output "application_secret_arn" {
  description = "Exact ARN of the bootstrap-owned empty application-secret container."
  value       = one(aws_secretsmanager_secret.application[*].arn)
}

output "auth_runtime_secret_arn" {
  description = "Exact ARN of the bootstrap-owned empty auth-runtime role-secret container."
  value       = one(aws_secretsmanager_secret.auth_runtime[*].arn)
}

output "auth_migrator_secret_arn" {
  description = "Exact ARN of the bootstrap-owned empty auth-migrator role-secret container."
  value       = one(aws_secretsmanager_secret.auth_migrator[*].arn)
}

output "core_runtime_secret_arn" {
  description = "Exact ARN of the bootstrap-owned empty Core runtime role-secret container."
  value       = one(aws_secretsmanager_secret.core_runtime[*].arn)
}

output "core_migrator_secret_arn" {
  description = "Exact ARN of the bootstrap-owned empty Core migrator role-secret container."
  value       = one(aws_secretsmanager_secret.core_migrator[*].arn)
}

output "database_operator_secret_arn" {
  description = "Exact ARN of the bootstrap-owned empty database-operator secret container."
  value       = one(aws_secretsmanager_secret.database_operator[*].arn)
}
