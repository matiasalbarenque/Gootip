variables {
  deployment_application_client_security_group_id = "sg-0123456789abcdef0"
  deployment_db_tunnel_ami_id                     = "ami-0123456789abcdef0"
  deployment_db_tunnel_subnet_id                  = "subnet-0123456789abcdef0"
}

variable "aws_account_id" {
  type = string
}

run "db_config_function_configuration_read_is_exact_and_unqualified" {
  command = plan

  assert {
    condition = (
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement
        if statement.Sid == "ReadExactDbConfigFunctionConfiguration"
      ]).Action == "lambda:GetFunctionConfiguration" &&
      one([
        for statement in jsondecode(data.aws_iam_policy_document.deployment_db_config_permissions.json).Statement : statement
        if statement.Sid == "ReadExactDbConfigFunctionConfiguration"
      ]).Resource == "arn:aws:lambda:us-east-2:${var.aws_account_id}:function:lambda_db_config"
    )
    error_message = "Function configuration read must be limited to the exact unqualified db-config Lambda ARN."
  }
}
