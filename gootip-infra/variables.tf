variable "aws_account_id" {
  description = "Independently confirmed twelve-digit AWS account ID. Supply it at runtime; do not commit it."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must contain exactly twelve digits."
  }
}

variable "aws_region" {
  description = "AWS Region assigned to the Gootip project."
  type        = string
  default     = "us-east-2"

  validation {
    condition     = var.aws_region == "us-east-2"
    error_message = "Only us-east-2 is supported by this project contract."
  }
}

variable "aws_billing_region" {
  description = "AWS Budgets control-plane Region; Budgets uses us-east-1 for global billing data."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = var.aws_billing_region == "us-east-1"
    error_message = "AWS Budgets is managed through us-east-1 for this project."
  }
}

variable "project" {
  description = "Project name used in resource names and tags."
  type        = string
  default     = "gootip"

  validation {
    condition     = var.project == "gootip"
    error_message = "Only the gootip project is supported."
  }
}

variable "env" {
  description = "Environment name used in resource names and tags."
  type        = string
  default     = "dev"

  validation {
    condition     = var.env == "dev"
    error_message = "Only the dev environment is supported."
  }
}

variable "lambda_runtime" {
  description = "Lambda runtime for the app function."
  type        = string
  default     = "nodejs24.x"

  validation {
    condition     = var.lambda_runtime == "nodejs24.x"
    error_message = "Only nodejs24.x is supported."
  }
}

variable "lambda_memory" {
  description = "Lambda memory in MB."
  type        = number
  default     = 512

  validation {
    condition     = var.lambda_memory >= 512 && var.lambda_memory <= 1024
    error_message = "Lambda memory must be between 512 and 1024 MB."
  }
}

variable "lambda_timeout" {
  description = "Lambda timeout in seconds."
  type        = number
  default     = 30
}

variable "lambda_reserved_concurrent_executions" {
  description = "Maximum concurrent executions for the authentication Lambda; must fit the verified account quota."
  type        = number
  default     = 5

  validation {
    condition     = var.lambda_reserved_concurrent_executions > 0
    error_message = "lambda_reserved_concurrent_executions must be positive."
  }
}

variable "api_throttling_rate_limit" {
  description = "Default HTTP API stage request rate limit."
  type        = number
  default     = 10

  validation {
    condition     = var.api_throttling_rate_limit > 0
    error_message = "api_throttling_rate_limit must be positive."
  }
}

variable "api_throttling_burst_limit" {
  description = "Default HTTP API stage burst capacity."
  type        = number
  default     = 20

  validation {
    condition     = var.api_throttling_burst_limit > 0
    error_message = "api_throttling_burst_limit must be positive."
  }
}

variable "auth_pg_pool_max" {
  description = "Maximum PostgreSQL connections in the Better Auth pool per Lambda environment."
  type        = number
  default     = 2

  validation {
    condition     = var.auth_pg_pool_max > 0 && var.auth_pg_pool_max <= var.rds_max_connections
    error_message = "auth_pg_pool_max must be positive and below the observed RDS connection capacity."
  }
}

variable "auth_rate_limit_enabled" {
  description = "Whether shared database-backed Better Auth rate limiting is enabled."
  type        = bool
  default     = true
}

variable "auth_rate_limit_rules" {
  description = "Comma-separated Better Auth path:window-seconds:maximum rate-limit rules."
  type        = string
  default     = "/sign-in/*:10:3,/sign-up/*:10:3,/request-password-reset:60:3,/forget-password/*:60:3"
}

variable "rds_instance_class" {
  description = "RDS instance class for Postgres."
  type        = string
  default     = "db.t3.micro"

  validation {
    condition     = var.rds_instance_class == "db.t3.micro"
    error_message = "Only db.t3.micro is supported in dev."
  }
}

variable "rds_engine_version" {
  description = "PostgreSQL target version: major prefix (for example 18) or an exact minor used for a reviewed upgrade."
  type        = string
  default     = "18"

  validation {
    condition     = can(regex("^[0-9]+(\\.[0-9]+)?$", var.rds_engine_version))
    error_message = "rds_engine_version must be a PostgreSQL major-version prefix or an exact major.minor version."
  }
}

variable "rds_parameter_group_family" {
  description = "RDS parameter group family matching the selected PostgreSQL major version."
  type        = string
  default     = "postgres18"

  validation {
    condition     = can(regex("^postgres[0-9]+$", var.rds_parameter_group_family))
    error_message = "rds_parameter_group_family must be a PostgreSQL parameter group family."
  }
}

variable "rds_final_snapshot_identifier" {
  description = "Stable operator-selected identifier used for the required final RDS snapshot at authorized teardown."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,253}[a-z0-9]$", var.rds_final_snapshot_identifier)) && !strcontains(var.rds_final_snapshot_identifier, "--")
    error_message = "rds_final_snapshot_identifier must be 2-255 lowercase letters, numbers, or hyphens; start with a letter; end alphanumeric; and contain no consecutive hyphens."
  }
}

variable "application_runtime_deployment_enabled" {
  description = "Whether Auth runtime resources and its explicit public Auth routes may be planned after the separate activation review."
  type        = bool
  default     = false
}

variable "api_preparation_enabled" {
  description = "Whether to create only the shared route-less HTTP API shell to obtain its origin and ID."
  type        = bool
  default     = false
}

variable "api_stage_enabled" {
  description = "Whether to create the shared default stage after the API-specific deployment capability is reviewed."
  type        = bool
  default     = false

  validation {
    condition     = !var.api_stage_enabled || var.api_preparation_enabled || var.application_runtime_deployment_enabled || var.core_runtime_deployment_enabled
    error_message = "The default stage requires API preparation or an active application runtime."
  }
}

variable "core_runtime_deployment_enabled" {
  description = "Whether Core runtime resources and explicit Core routes may be planned after Auth activation and a separate review."
  type        = bool
  default     = false

  validation {
    condition     = !var.core_runtime_deployment_enabled || var.application_runtime_deployment_enabled
    error_message = "Core runtime activation requires Auth runtime activation to remain enabled."
  }
}

variable "core_lambda_reserved_concurrent_executions" {
  description = "Initial Core API reserved concurrency; the deployment gate verifies account quota before apply."
  type        = number
  default     = 5

  validation {
    condition     = var.core_lambda_reserved_concurrent_executions == 5
    error_message = "Core API reserved concurrency must remain at the reviewed initial value of 5."
  }
}

variable "core_pg_pool_max" {
  description = "Maximum PostgreSQL connections in the Core TypeORM pool per Lambda environment."
  type        = number
  default     = 2

  validation {
    condition     = var.core_pg_pool_max == 2
    error_message = "Core PostgreSQL pool maximum must remain at the reviewed initial value of 2."
  }
}

variable "secretsmanager_endpoint_subnet_index" {
  description = "Explicit zero-based private-subnet index hosting the single-AZ Secrets Manager interface endpoint."
  type        = number
  default     = 0

  validation {
    condition     = var.secretsmanager_endpoint_subnet_index >= 0 && var.secretsmanager_endpoint_subnet_index < 2
    error_message = "secretsmanager_endpoint_subnet_index must select one of the two private RDS subnets."
  }
}

variable "rds_db_name" {
  description = "Initial database name for the app."
  type        = string
  default     = "gootip"
}

variable "rds_db_user" {
  description = "Master username for RDS (password is RDS-managed, never in Terraform)."
  type        = string
  default     = "gootip_auth"
}

variable "jwt_audience" {
  description = "Expected JWT audience for the app."
  type        = string
  default     = "gootip-auth-dev"
}

variable "better_auth_url" {
  description = "Public application origin for Better Auth, without the /api/auth path."
  type        = string
  default     = ""

  validation {
    condition = (
      var.better_auth_url == "" ||
      can(regex("^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$", var.better_auth_url))
    )
    error_message = "better_auth_url must be empty before API preparation or an HTTPS origin without a path, query, or trailing slash."
  }

  validation {
    condition = (
      (!var.application_runtime_deployment_enabled && !var.core_runtime_deployment_enabled) ||
      can(regex("^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$", var.better_auth_url))
    )
    error_message = "Auth or Core activation requires the exact HTTPS API origin as better_auth_url."
  }
}

variable "frontend_url" {
  description = "Allowed CORS origin for the HTTP API."
  type        = string
  default     = "http://localhost:3000"
}

variable "app_secret_arn" {
  description = "Exact ARN of the bootstrap-owned application-secret container, required only when the deferred runtime is enabled."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.app_secret_arn == null || can(regex(
      "^arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:${var.project}-auth-${var.env}-[A-Za-z0-9]{6}$",
      var.app_secret_arn
    ))
    error_message = "app_secret_arn must be the complete current application-secret ARN in the configured account and Region."
  }
}

variable "application_runtime_boundary_arn" {
  description = "Exact ARN of the bootstrap-owned permissions boundary, required only when the deferred runtime is enabled."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.application_runtime_boundary_arn == null || can(regex(
      "^arn:aws:iam::${var.aws_account_id}:policy/gootip/bootstrap/GootipApplicationRuntimeBoundary$",
      var.application_runtime_boundary_arn
    ))
    error_message = "application_runtime_boundary_arn must be the exact bootstrap-owned runtime boundary in the configured account."
  }
}

variable "db_master_secret_arn" {
  description = "ARN of the existing RDS-managed master secret, for the administrative function only; the authentication runtime never receives it."
  type        = string
  default     = null
  nullable    = true
}

variable "db_config_deployment_enabled" {
  description = "Whether the administrative PostgreSQL bootstrap Lambda and its runtime IAM may be planned. SPEC 03 owns this deployment."
  type        = bool
  default     = false
}

variable "db_config_security_group_retained" {
  description = "Whether the empty db-config security group is temporarily retained for the reviewed two-phase teardown after the administrative function is removed."
  type        = bool
  default     = false
}

variable "auth_migrations_deployment_enabled" {
  description = "Whether the private auth migration Lambda, its aliases, IAM role, security group, and managed logs may be planned. SPEC 04 owns this deployment."
  type        = bool
  default     = false
}

variable "auth_migrations_baseline_version" {
  description = "Published migration-runner version retained by the operator-only baseline alias during normal deployment releases."
  type        = string
  default     = "2"

  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.auth_migrations_baseline_version))
    error_message = "auth_migrations_baseline_version must be a published positive Lambda version number."
  }
}

variable "auth_migrations_lambda_memory" {
  description = "Memory in MB for the private auth migration Lambda."
  type        = number
  default     = 512

  validation {
    condition     = var.auth_migrations_lambda_memory >= 512 && var.auth_migrations_lambda_memory <= 1024
    error_message = "auth_migrations_lambda_memory must be between 512 and 1024 MB."
  }
}

variable "auth_migrations_lambda_timeout" {
  description = "Lambda timeout in seconds for the private auth migration runner."
  type        = number
  default     = 600

  validation {
    condition     = var.auth_migrations_lambda_timeout >= 330 && var.auth_migrations_lambda_timeout <= 900
    error_message = "auth_migrations_lambda_timeout must be between 330 and 900 seconds."
  }
}

variable "core_migrations_deployment_enabled" {
  description = "Whether the private Core migration Lambda, alias, IAM role, security group, and log group may be planned. SPEC 06 keeps this disabled until the administrative handoff exists."
  type        = bool
  default     = false
}

variable "core_migrator_secret_arn" {
  description = "Exact non-sensitive ARN of the existing Core migrator credential container, required only when Core migrations are enabled."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.core_migrator_secret_arn == null || can(regex(
      "^arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:${var.project}-${var.env}-core-migrator-[A-Za-z0-9]{6}$",
      var.core_migrator_secret_arn
    ))
    error_message = "core_migrator_secret_arn must be null or the complete Core migrator secret ARN in the configured account and Region."
  }
}

variable "core_runtime_secret_arn" {
  description = "Exact non-sensitive ARN of the Core runtime credential container."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.core_runtime_secret_arn == null || can(regex(
      "^arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:${var.project}-${var.env}-core-runtime-[A-Za-z0-9]{6}$",
      var.core_runtime_secret_arn
    ))
    error_message = "core_runtime_secret_arn must be null or the complete Core runtime secret ARN in the configured account and Region."
  }
}

variable "core_migrations_runtime_boundary_arn" {
  description = "Exact ARN of the bootstrap-owned runtime permissions boundary, required only when Core migrations are enabled."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.core_migrations_runtime_boundary_arn == null || can(regex(
      "^arn:aws:iam::${var.aws_account_id}:policy/gootip/bootstrap/GootipApplicationRuntimeBoundary$",
      var.core_migrations_runtime_boundary_arn
    ))
    error_message = "core_migrations_runtime_boundary_arn must be the exact bootstrap-owned runtime boundary in the configured account."
  }
}

variable "core_migrations_lambda_memory" {
  description = "Memory in MB for the private Core migration Lambda."
  type        = number
  default     = 512

  validation {
    condition     = var.core_migrations_lambda_memory == 512
    error_message = "core_migrations_lambda_memory must remain at the reviewed initial value of 512 MB."
  }
}

variable "core_migrations_lambda_timeout" {
  description = "Timeout in seconds for the private Core migration Lambda."
  type        = number
  default     = 600

  validation {
    condition     = var.core_migrations_lambda_timeout == 600
    error_message = "core_migrations_lambda_timeout must remain at the reviewed initial value of 600 seconds."
  }
}


variable "db_config_lambda_runtime" {
  description = "Lambda runtime for the administrative database bootstrap function."
  type        = string
  default     = "python3.13"

  validation {
    condition     = var.db_config_lambda_runtime == "python3.13"
    error_message = "Only python3.13 is supported for the administrative function."
  }
}

variable "db_config_lambda_memory" {
  description = "Memory in MB for the administrative database bootstrap function."
  type        = number
  default     = 256

  validation {
    condition     = var.db_config_lambda_memory >= 128 && var.db_config_lambda_memory <= 1024
    error_message = "db_config_lambda_memory must be between 128 and 1024 MB."
  }
}

variable "db_config_lambda_timeout" {
  description = "Timeout in seconds for the administrative database bootstrap function."
  type        = number
  default     = 60
}

variable "auth_runtime_secret_arn" {
  description = "Exact non-sensitive ARN of the bootstrap-owned auth-runtime container, required by the administrative function and the authentication runtime."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.auth_runtime_secret_arn == null || can(regex(
      "^arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:${var.project}-${var.env}-auth-runtime-[A-Za-z0-9]{6}$",
      var.auth_runtime_secret_arn
    ))
    error_message = "auth_runtime_secret_arn must be null or the complete current auth-runtime container ARN in the configured account and Region."
  }
}

variable "auth_migrator_secret_arn" {
  description = "Exact non-sensitive ARN of the bootstrap-owned auth-migrator container, required only when the administrative function is enabled."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.auth_migrator_secret_arn == null || can(regex(
      "^arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:${var.project}-${var.env}-auth-migrator-[A-Za-z0-9]{6}$",
      var.auth_migrator_secret_arn
    ))
    error_message = "auth_migrator_secret_arn must be null or the complete current auth-migrator container ARN in the configured account and Region."
  }
}

variable "db_operator_secret_arn" {
  description = "Exact non-sensitive ARN of the bootstrap-owned database-operator container, required only while the temporary administrative function reconciles gootip_dev_operator."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.db_operator_secret_arn == null || can(regex(
      "^arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:${var.project}-${var.env}-db-operator-[A-Za-z0-9]{6}$",
      var.db_operator_secret_arn
    ))
    error_message = "db_operator_secret_arn must be null or the complete current database-operator container ARN in the configured account and Region."
  }
}

variable "database_operator_access_enabled" {
  description = "Whether the private EC2 Instance Connect database access path is enabled. SPEC 05.2 requires false outside environments/dev.tfvars."
  type        = bool
  default     = false

  validation {
    condition     = !var.database_operator_access_enabled || var.env == "dev"
    error_message = "Database operator access is supported only in the dev environment."
  }
}

variable "db_tunnel_ami_id" {
  description = "Explicit reviewed Amazon Linux 2023 ARM64 AMI ID in us-east-2. No automatic latest-AMI replacement."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.db_tunnel_ami_id == null || can(regex("^ami-[0-9a-f]+$", var.db_tunnel_ami_id))
    error_message = "db_tunnel_ami_id must be null or a lowercase ami- identifier."
  }

  validation {
    condition     = var.db_tunnel_ami_id != null || !var.database_operator_access_enabled
    error_message = "db_tunnel_ami_id must be pinned when database_operator_access_enabled is true."
  }
}

variable "db_tunnel_instance_type" {
  description = "Approved ARM instance type for the private database tunnel host."
  type        = string
  default     = "t4g.micro"

  validation {
    condition     = var.db_tunnel_instance_type == "t4g.micro"
    error_message = "Only the Free Tier eligible t4g.micro is approved for the dev database tunnel host."
  }
}

variable "alarm_notification_email" {
  description = "Email address subscribed to current operational CloudWatch alarms."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alarm_notification_email))
    error_message = "alarm_notification_email must be a valid email address."
  }
}

variable "auth_migrations_errors_threshold" {
  description = "Number of authentication migration Lambda errors that triggers the one-minute alarm."
  type        = number
  default     = 1

  validation {
    condition     = var.auth_migrations_errors_threshold >= 1
    error_message = "auth_migrations_errors_threshold must be at least 1."
  }
}

variable "rds_cpu_threshold" {
  description = "RDS average CPU percentage that triggers the five-minute alarm."
  type        = number
  default     = 80

  validation {
    condition     = var.rds_cpu_threshold > 0 && var.rds_cpu_threshold <= 100
    error_message = "rds_cpu_threshold must be greater than 0 and at most 100."
  }
}

variable "rds_database_connections_threshold" {
  description = "RDS DatabaseConnections alarm threshold; with GreaterThan, 57 triggers when this is 56."
  type        = number
  default     = 56

  validation {
    condition     = var.rds_database_connections_threshold >= 1 && var.rds_database_connections_threshold < var.rds_max_connections
    error_message = "rds_database_connections_threshold must be at least 1 and below rds_max_connections."
  }
}

variable "rds_max_connections" {
  description = "Effective PostgreSQL max_connections value inspected for the dev RDS instance."
  type        = number

  validation {
    condition     = var.rds_max_connections >= 2
    error_message = "rds_max_connections must be at least 2."
  }
}

variable "monthly_cost_budget_usd" {
  description = "Fixed monthly actual-cost budget in USD; underlying service consumption is measured before credits."
  type        = number

  validation {
    condition     = var.monthly_cost_budget_usd > 0
    error_message = "monthly_cost_budget_usd must be greater than zero."
  }
}

variable "monthly_cost_budget_actual_threshold_percent" {
  description = "Actual-cost budget threshold percentage that sends the email notification."
  type        = number

  validation {
    condition     = var.monthly_cost_budget_actual_threshold_percent > 0 && var.monthly_cost_budget_actual_threshold_percent <= 100
    error_message = "monthly_cost_budget_actual_threshold_percent must be greater than 0 and at most 100."
  }
}
