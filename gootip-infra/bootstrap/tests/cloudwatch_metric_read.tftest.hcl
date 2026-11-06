variables {
  deployment_application_client_security_group_id = "sg-0123456789abcdef0"
  deployment_db_tunnel_ami_id                     = "ami-0123456789abcdef0"
  deployment_db_tunnel_subnet_id                  = "subnet-0123456789abcdef0"
}

variable "aws_account_id" {
  type = string
}

run "cloudwatch_metric_read_is_regional_and_read_only" {
  command = plan

  variables {
    foundation_policy_expansion_enabled = true
    eligibility_gate_passed             = true
    secrets_manager_kms_key_arn         = "arn:aws:kms:us-east-2:${var.aws_account_id}:key/00000000-0000-0000-0000-000000000001"
  }

  assert {
    condition = one([
      for statement in jsondecode(data.aws_iam_policy_document.deployment_foundation_read_permissions[0].json).Statement : statement
      if statement.Sid == "ReadCloudWatchMetricDataInRegion"
      ]) == {
      Sid       = "ReadCloudWatchMetricDataInRegion"
      Effect    = "Allow"
      Action    = "cloudwatch:GetMetricData"
      Resource  = "*"
      Condition = { StringEquals = { "aws:RequestedRegion" = "us-east-2" } }
    }
    error_message = "Metric access must allow only GetMetricData in us-east-2."
  }
}
