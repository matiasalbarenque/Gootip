variable "aws_account_id" {
  description = "Independently confirmed twelve-digit AWS account ID. Supply it at runtime; do not commit it."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must contain exactly twelve digits."
  }
}

variable "aws_region" {
  description = "AWS Region for the Gootip development account."
  type        = string
  default     = "us-east-2"

  validation {
    condition     = var.aws_region == "us-east-2"
    error_message = "Only us-east-2 is supported by this bootstrap contract."
  }
}

variable "aws_billing_region" {
  description = "AWS Budgets and Billing API endpoint Region used by the SPEC 06 deployment capability."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = var.aws_billing_region == "us-east-1"
    error_message = "AWS Budgets and Billing APIs use us-east-1 in this project."
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
  description = "Environment managed by this bootstrap root."
  type        = string
  default     = "dev"

  validation {
    condition     = var.env == "dev"
    error_message = "Only the dev environment is supported."
  }
}

variable "source_user_name" {
  description = "Existing IAM user imported as the local source identity."
  type        = string
  default     = "gootip"

  validation {
    condition     = var.source_user_name == "gootip"
    error_message = "The source IAM user must be gootip."
  }
}

variable "secretsmanager_vpc_endpoint_id" {
  description = "Exact existing Secrets Manager VPC endpoint ID, used only to authorize its endpoint-policy update."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.secretsmanager_vpc_endpoint_id == null || can(regex(
      "^vpce-[0-9a-f]+$",
      var.secretsmanager_vpc_endpoint_id
    ))
    error_message = "secretsmanager_vpc_endpoint_id must be null or an exact VPC endpoint ID."
  }
}

# Consumed by the exact RDS-secret deny after the reviewed RDS handoff.
# tflint-ignore: terraform_unused_declarations
variable "rds_master_secret_arn" {
  description = "Exact non-sensitive ARN of the RDS-managed master secret after RDS creation."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.rds_master_secret_arn == null || can(regex(
      "^arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:rds!db-[A-Za-z0-9][A-Za-z0-9-]*-[A-Za-z0-9]{6}$",
      var.rds_master_secret_arn
    ))
    error_message = "rds_master_secret_arn must be null or a complete RDS-managed secret ARN in the configured account and Region."
  }
}

variable "application_secret_arn" {
  description = "Exact non-sensitive ARN of the bootstrap-owned application secret after container creation or import."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.application_secret_arn == null || can(regex(
      "^arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:${var.project}-auth-${var.env}-[A-Za-z0-9]{6}$",
      var.application_secret_arn
    ))
    error_message = "application_secret_arn must be null or the complete current application-secret ARN in the configured account and Region."
  }
}

variable "api_gateway_id" {
  description = "Exact HTTP API ID from the route-less preparation apply; null keeps API-specific stage and route permissions closed."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.api_gateway_id == null || can(regex("^[A-Za-z0-9]{10}$", var.api_gateway_id))
    error_message = "api_gateway_id must be null or the exact 10-character HTTP API ID from the reviewed preparation output."
  }
}

variable "api_gateway_read_id" {
  description = "Exact HTTP API ID for read-only reconciliation; does not enable API management, routes, integrations, or stages."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.api_gateway_read_id == null || can(regex("^[A-Za-z0-9]{10}$", var.api_gateway_read_id))
    error_message = "api_gateway_read_id must be null or the exact 10-character HTTP API ID to read."
  }
}

variable "api_gateway_core_permissions_enabled" {
  description = "Whether to add Lambda invoke grants for the explicit Core route set on the prepared API."
  type        = bool
  default     = false

  validation {
    condition     = !var.api_gateway_core_permissions_enabled || var.api_gateway_id != null
    error_message = "Core API route permissions require the exact prepared API ID."
  }
}

variable "role_secret_creation_enabled" {
  description = "Whether the reviewed container-creation apply may grant temporary name-and-tag-constrained CreateSecret for the two role-secret containers. Set false immediately after they exist."
  type        = bool
  default     = false

  validation {
    condition     = !var.role_secret_creation_enabled || var.account_resource_phase_enabled
    error_message = "role_secret_creation_enabled requires account_resource_phase_enabled."
  }
}

variable "database_operator_secret_creation_enabled" {
  description = "Whether the reviewed container-creation apply may grant temporary name-and-tag-constrained CreateSecret for the gootip-dev-db-operator container. Set false immediately after it exists."
  type        = bool
  default     = false

  validation {
    condition     = !var.database_operator_secret_creation_enabled || var.account_resource_phase_enabled
    error_message = "database_operator_secret_creation_enabled requires account_resource_phase_enabled."
  }
}

variable "credential_provisioner_role_enabled" {
  description = "Whether bootstrap may provision the MFA-backed role that can read only the exact RDS master secret for approved operator installation and login activation."
  type        = bool
  default     = false

  validation {
    condition = !var.credential_provisioner_role_enabled || (
      var.eligibility_gate_passed &&
      var.account_resource_phase_enabled &&
      var.credential_role_lifecycle_enabled &&
      var.rds_master_secret_arn != null
    )
    error_message = "credential_provisioner_role_enabled requires the eligibility gate, account-resource phase, and exact RDS master-secret ARN."
  }
}

variable "credential_role_lifecycle_enabled" {
  description = "Whether bootstrap temporarily receives exact-ARN lifecycle permissions for the credential roles and their managed policies. Enable alone for the permission-first plan; disable only after both roles are removed."
  type        = bool
  default     = false

  validation {
    condition = !var.credential_role_lifecycle_enabled || (
      var.eligibility_gate_passed &&
      var.account_resource_phase_enabled
    )
    error_message = "credential_role_lifecycle_enabled requires the eligibility gate and account-resource phase."
  }
}

variable "credential_operator_role_enabled" {
  description = "Whether bootstrap may provision the MFA-backed role that can read and publish only the exact Auth and Core runtime secrets for an approved credential transition."
  type        = bool
  default     = false

  validation {
    condition = !var.credential_operator_role_enabled || (
      var.eligibility_gate_passed &&
      var.account_resource_phase_enabled &&
      var.credential_role_lifecycle_enabled &&
      var.auth_runtime_secret_arn != null &&
      var.core_runtime_secret_arn != null
    )
    error_message = "credential_operator_role_enabled requires the eligibility gate, account-resource phase, and exact Auth/Core runtime secret ARNs."
  }
}

variable "core_role_secret_creation_enabled" {
  description = "Whether a reviewed apply may temporarily create only the two Core role-secret containers. Disable it when supplying their exact ARNs."
  type        = bool
  default     = false

  validation {
    condition     = !var.core_role_secret_creation_enabled || var.account_resource_phase_enabled
    error_message = "core_role_secret_creation_enabled requires account_resource_phase_enabled."
  }
}

variable "core_migrations_log_access_enabled" {
  description = "Whether the application runtime boundary may write to the Core migrations log group; keep disabled until the separate Core SPEC 06 deployment phase."
  type        = bool
  default     = false
}

variable "core_runtime_secret_arn" {
  description = "Exact ARN of the Core runtime credential container after creation."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.core_runtime_secret_arn == null || can(regex(
      "^arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:${var.project}-${var.env}-core-runtime-[A-Za-z0-9]{6}$",
      var.core_runtime_secret_arn
    ))
    error_message = "core_runtime_secret_arn must be null or a complete Core runtime secret ARN in this account and Region."
  }
}

variable "auth_runtime_secret_arn" {
  description = "Exact non-sensitive ARN of the gootip-dev-auth-runtime container after creation. Required by the reviewed second apply."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.auth_runtime_secret_arn == null || can(regex(
      "^arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:${var.project}-${var.env}-auth-runtime-[A-Za-z0-9]{6}$",
      var.auth_runtime_secret_arn
    ))
    error_message = "auth_runtime_secret_arn must be null or the complete current role-secret container ARN in the configured account and Region."
  }
}

variable "auth_migrator_secret_arn" {
  description = "Exact non-sensitive ARN of the gootip-dev-auth-migrator container after creation. Required by the reviewed second apply."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.auth_migrator_secret_arn == null || can(regex(
      "^arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:${var.project}-${var.env}-auth-migrator-[A-Za-z0-9]{6}$",
      var.auth_migrator_secret_arn
    ))
    error_message = "auth_migrator_secret_arn must be null or the complete current role-secret container ARN in the configured account and Region."
  }
}

variable "core_migrator_secret_arn" {
  description = "Exact non-sensitive ARN of the Core migrator credential container after the administrative handoff."
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

variable "db_operator_secret_arn" {
  description = "Exact non-sensitive ARN of the gootip-dev-db-operator container after creation. Required by the reviewed operator applies."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.db_operator_secret_arn == null || can(regex(
      "^arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:${var.project}-${var.env}-db-operator-[A-Za-z0-9]{6}$",
      var.db_operator_secret_arn
    ))
    error_message = "db_operator_secret_arn must be null or the complete current database-operator secret ARN in the configured account and Region."
  }
}

variable "db_config_network_interface_arns" {
  description = "Exact temporary Lambda VPC network-interface ARNs that may be deleted while revoking the db-config function. Keep empty outside the reviewed revocation apply."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for arn in var.db_config_network_interface_arns : can(regex(
        "^arn:aws:ec2:${var.aws_region}:${var.aws_account_id}:network-interface/eni-[0-9a-f]+$",
        arn
      ))
    ])
    error_message = "db_config_network_interface_arns must contain only complete network-interface ARNs in the configured account and Region."
  }
}

variable "secrets_manager_kms_key_arn" {
  description = "Exact non-sensitive ARN of the AWS-managed Secrets Manager KMS key used by the RDS-managed master secret."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.secrets_manager_kms_key_arn == null || can(regex(
      "^arn:aws:kms:${var.aws_region}:${var.aws_account_id}:key/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
      var.secrets_manager_kms_key_arn
    ))
    error_message = "secrets_manager_kms_key_arn must be null or a complete KMS key ARN in the configured account and Region."
  }
}

variable "eligibility_gate_passed" {
  description = "Whether the current Free Plan eligibility and billing gate was recorded as passed."
  type        = bool
  default     = false
}

variable "account_resource_phase_enabled" {
  description = "Whether bootstrap may manage account resources such as S3 and Secrets Manager. Keep true after those resources exist."
  type        = bool
  default     = false

  validation {
    condition     = !var.account_resource_phase_enabled || var.eligibility_gate_passed
    error_message = "account_resource_phase_enabled requires eligibility_gate_passed to be true."
  }
}

variable "foundation_policy_expansion_enabled" {
  description = "Whether the separately reviewed SPEC 02.2 foundation-only deployment permissions are included in the deployment role policy."
  type        = bool
  default     = false

  validation {
    condition = !var.foundation_policy_expansion_enabled || (
      var.eligibility_gate_passed &&
      var.secrets_manager_kms_key_arn != null
    )
    error_message = "foundation_policy_expansion_enabled requires the eligibility gate and exact Secrets Manager KMS key ARN."
  }
}

variable "split_policy_creation_enabled" {
  description = "Whether the retained bootstrap core may grant temporary CreatePolicy for the SPEC 03.1 split policy ARNs. Set true only for the reviewed split-creation applies and return it to false as soon as every split policy exists."
  type        = bool
  default     = false

  validation {
    condition     = !var.split_policy_creation_enabled || var.account_resource_phase_enabled
    error_message = "split_policy_creation_enabled requires account_resource_phase_enabled."
  }
}

variable "diagnostics_inventory_enabled" {
  description = "Whether the bootstrap diagnostics policy carries the SPEC 02.3 read-only policy and role inventory. This authorization belongs to SPEC 02.3, not SPEC 03.1: keep it false so every SPEC 03.1 apply renders the diagnostics policy exactly as it already exists in AWS, and set it true only for the separately reviewed SPEC 02.3 apply that introduces those statements."
  type        = bool
  default     = false

  validation {
    condition     = !var.diagnostics_inventory_enabled || var.account_resource_phase_enabled
    error_message = "diagnostics_inventory_enabled requires account_resource_phase_enabled."
  }
}

variable "db_config_operator_invocation_enabled" {
  description = "Whether GootipBootstrapAdmin may temporarily invoke the exact unqualified db-config Lambda for the reviewed SPEC 03 bootstrap procedure."
  type        = bool
  default     = false
}

variable "instance_connect_service_linked_role_creation_enabled" {
  description = "Whether GootipBootstrapAdmin may temporarily create the exact EC2 Instance Connect service-linked role for SPEC 05.2. Set false immediately after the role exists."
  type        = bool
  default     = false
}

variable "cutover_prerequisites_verified" {
  description = "Whether both roles, remote state, bootstrap administration, and the authorization matrix passed fresh-session verification."
  type        = bool
  default     = false
}

variable "source_user_cutover_enabled" {
  description = "Whether bootstrap may replace direct source-user access with the assume-only boundary and policy."
  type        = bool
  default     = false

  validation {
    condition = !var.source_user_cutover_enabled || (
      var.eligibility_gate_passed &&
      var.account_resource_phase_enabled &&
      var.cutover_prerequisites_verified &&
      var.rds_master_secret_arn != null
    )
    error_message = "source_user_cutover_enabled requires the eligibility gate, account-resource phase, cutover prerequisites, and exact RDS master-secret ARN."
  }
}

variable "deployment_application_client_security_group_id" {
  description = "Application client security group ID from the reviewed dev deployment."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^sg-[0-9a-f]{8}([0-9a-f]{9})?$", var.deployment_application_client_security_group_id))
    error_message = "deployment_application_client_security_group_id must be an exact sg- identifier."
  }
}

variable "deployment_db_tunnel_ami_id" {
  description = "Database tunnel AMI ID from the reviewed dev deployment."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^ami-[0-9a-f]{8}([0-9a-f]{9})?$", var.deployment_db_tunnel_ami_id))
    error_message = "deployment_db_tunnel_ami_id must be an exact ami- identifier."
  }
}

variable "deployment_db_tunnel_subnet_id" {
  description = "Database tunnel subnet ID from the reviewed dev deployment."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^subnet-[0-9a-f]{8}([0-9a-f]{9})?$", var.deployment_db_tunnel_subnet_id))
    error_message = "deployment_db_tunnel_subnet_id must be an exact subnet- identifier."
  }
}
