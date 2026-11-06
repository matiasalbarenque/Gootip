# Dev values. Non-sensitive only. Secret values live in Secrets Manager
# (loaded via console/CI put-secret-value) and never in this file.
# `auth_runtime_secret_arn` is the bootstrap-owned auth-runtime container from
# the SPEC 03 phase-2 apply: a reference only, whose value is loaded
# out-of-band by GootipBootstrapAdmin, never by Terraform.
aws_region                                 = "us-east-2"
aws_billing_region                         = "us-east-1"
project                                    = "gootip"
env                                        = "dev"
lambda_runtime                             = "nodejs24.x"
lambda_memory                              = 512
lambda_timeout                             = 30
api_throttling_rate_limit                  = 10
api_throttling_burst_limit                 = 20
lambda_reserved_concurrent_executions      = 5
auth_pg_pool_max                           = 2
core_lambda_reserved_concurrent_executions = 5
core_pg_pool_max                           = 2
api_preparation_enabled                    = false
core_runtime_deployment_enabled            = false
auth_rate_limit_enabled                    = true
auth_rate_limit_rules                      = "/sign-in/*:10:3,/sign-up/*:10:3,/request-password-reset:60:3,/forget-password/*:60:3"
rds_instance_class                         = "db.t3.micro"
# Keep the exact deployed version pinned, as requested after the upgrade.
rds_engine_version                     = "18.6"
rds_parameter_group_family             = "postgres18"
rds_final_snapshot_identifier          = "gootip-dev-final"
rds_db_name                            = "gootip"
rds_db_user                            = "gootip_auth"
jwt_audience                           = "gootip-auth-dev"
better_auth_url                        = ""
frontend_url                           = "http://localhost:3000"
application_runtime_deployment_enabled = false
# SPEC 12: keep the existing administrative Lambda and its IAM/SG during the
# PostgreSQL 18 upgrade and the 24-48h observation period. Its two-phase
# teardown is a separate, reviewed SPEC 03 operation after that window.
db_config_deployment_enabled         = true
auth_migrations_deployment_enabled   = true
auth_migrations_baseline_version     = "2"
auth_migrations_lambda_memory        = 512
auth_migrations_lambda_timeout       = 600
core_migrations_deployment_enabled   = true
secretsmanager_endpoint_subnet_index = 0
# AWS resource references for this environment are loaded from .env.aws-dev.

# SPEC 05.2: private, stopped-by-default database access. The gate remains false
# in every other environment. Keep the AMI pinned in .env.aws-dev to avoid
# replacing the host when a new image is published.
database_operator_access_enabled             = true
db_tunnel_instance_type                      = "t4g.micro"
auth_migrations_errors_threshold             = 1
rds_cpu_threshold                            = 80
rds_database_connections_threshold           = 56
rds_max_connections                          = 81
monthly_cost_budget_usd                      = 10
monthly_cost_budget_actual_threshold_percent = 80
