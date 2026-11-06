# Portable, non-sensitive defaults only. Supply account-specific values through
# TF_VAR_* environment variables or another ignored local configuration.
aws_region                          = "us-east-2"
project                             = "gootip"
env                                 = "dev"
source_user_name                    = "gootip"
rds_master_secret_arn               = null
application_secret_arn              = null
auth_runtime_secret_arn             = null
auth_migrator_secret_arn            = null
secrets_manager_kms_key_arn         = null
role_secret_creation_enabled        = false
split_policy_creation_enabled       = false
eligibility_gate_passed             = false
account_resource_phase_enabled      = false
foundation_policy_expansion_enabled = true
cutover_prerequisites_verified      = false
source_user_cutover_enabled         = false
