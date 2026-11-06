variable "aws_account_id" {
  type = string
}

variable "rds_final_snapshot_identifier" {
  type = string
}

# SPEC 05.2: one private tunnel host and one EC2 Instance Connect Endpoint, with
# reference-only security-group edges and no public addressing or general egress.
run "private_database_access_resources" {
  command = plan

  variables {
    aws_account_id                   = var.aws_account_id
    rds_final_snapshot_identifier    = var.rds_final_snapshot_identifier
    database_operator_access_enabled = true
    db_tunnel_ami_id                 = "ami-0123456789abcdef0"
  }

  assert {
    condition = (
      aws_ec2_instance_connect_endpoint.db_tunnel[0].preserve_client_ip == false &&
      aws_ec2_instance_connect_endpoint.db_tunnel[0].tags["Name"] == "gootip-dev-db-eice" &&
      aws_security_group.db_tunnel_endpoint[0].tags["Name"] == "gootip-dev-db-eice"
    )
    error_message = "The Instance Connect Endpoint must be the reviewed private endpoint with client-IP preservation disabled."
  }

  assert {
    condition = (
      aws_instance.db_tunnel[0].ami == "ami-0123456789abcdef0" &&
      aws_instance.db_tunnel[0].instance_type == "t4g.micro" &&
      aws_instance.db_tunnel[0].associate_public_ip_address == false &&
      aws_instance.db_tunnel[0].instance_initiated_shutdown_behavior == "stop" &&
      aws_ec2_instance_state.db_tunnel_stopped[0].state == "stopped" &&
      aws_instance.db_tunnel[0].tags["Name"] == "gootip-dev-db-tunnel" &&
      aws_instance.db_tunnel[0].tags["purpose"] == "db-tunnel" &&
      aws_security_group.db_tunnel[0].tags["Name"] == "gootip-dev-db-tunnel"
    )
    error_message = "The tunnel host must be the pinned stopped-by-default private instance with no public IPv4."
  }

  assert {
    condition = (
      aws_instance.db_tunnel[0].metadata_options[0].http_endpoint == "enabled" &&
      aws_instance.db_tunnel[0].metadata_options[0].http_tokens == "required" &&
      aws_instance.db_tunnel[0].root_block_device[0].volume_size == 8 &&
      aws_instance.db_tunnel[0].root_block_device[0].volume_type == "gp3" &&
      aws_instance.db_tunnel[0].root_block_device[0].encrypted == true &&
      aws_instance.db_tunnel[0].root_block_device[0].delete_on_termination == true
    )
    error_message = "The tunnel host must require IMDSv2 and use only the encrypted 8 GiB gp3 root volume."
  }

  assert {
    condition = (
      aws_vpc_security_group_egress_rule.endpoint_to_tunnel_ssh[0].from_port == 22 &&
      aws_vpc_security_group_egress_rule.endpoint_to_tunnel_ssh[0].to_port == 22 &&
      aws_vpc_security_group_egress_rule.endpoint_to_tunnel_ssh[0].ip_protocol == "tcp" &&
      aws_vpc_security_group_egress_rule.endpoint_to_tunnel_ssh[0].cidr_ipv4 == null &&
      aws_vpc_security_group_ingress_rule.tunnel_ssh_from_endpoint[0].from_port == 22 &&
      aws_vpc_security_group_ingress_rule.tunnel_ssh_from_endpoint[0].to_port == 22 &&
      aws_vpc_security_group_ingress_rule.tunnel_ssh_from_endpoint[0].ip_protocol == "tcp" &&
      aws_vpc_security_group_ingress_rule.tunnel_ssh_from_endpoint[0].cidr_ipv4 == null
    )
    error_message = "Endpoint-to-host traffic must be limited to SSH and referenced by security group only."
  }

  assert {
    condition = (
      aws_vpc_security_group_egress_rule.tunnel_to_rds_postgres[0].from_port == 5432 &&
      aws_vpc_security_group_egress_rule.tunnel_to_rds_postgres[0].to_port == 5432 &&
      aws_vpc_security_group_egress_rule.tunnel_to_rds_postgres[0].ip_protocol == "tcp" &&
      aws_vpc_security_group_egress_rule.tunnel_to_rds_postgres[0].cidr_ipv4 == null &&
      one([
        for rule in aws_security_group.rds.ingress : rule
        if rule.description == "PostgreSQL from the private tunnel host only."
      ]).from_port == 5432 &&
      one([
        for rule in aws_security_group.rds.ingress : rule
        if rule.description == "PostgreSQL from the private tunnel host only."
      ]).to_port == 5432 &&
      one([
        for rule in aws_security_group.rds.ingress : rule
        if rule.description == "PostgreSQL from the private tunnel host only."
      ]).protocol == "tcp"
    )
    error_message = "Host-to-RDS traffic must be limited to PostgreSQL and referenced by security group only."
  }

  assert {
    condition     = aws_db_instance.main.publicly_accessible == false
    error_message = "RDS must remain private while the database access path is enabled."
  }
}

# The gate stays off outside the reviewed dev enablement.
run "database_access_is_disabled_by_default" {
  command = plan

  variables {
    aws_account_id                = var.aws_account_id
    rds_final_snapshot_identifier = var.rds_final_snapshot_identifier
  }

  assert {
    condition = (
      length(aws_ec2_instance_connect_endpoint.db_tunnel) == 0 &&
      length(aws_instance.db_tunnel) == 0 &&
      length(aws_ec2_instance_state.db_tunnel_stopped) == 0 &&
      length(aws_security_group.db_tunnel_endpoint) == 0 &&
      length(aws_security_group.db_tunnel) == 0 &&
      length(aws_vpc_security_group_egress_rule.endpoint_to_tunnel_ssh) == 0 &&
      length(aws_vpc_security_group_ingress_rule.tunnel_ssh_from_endpoint) == 0 &&
      length(aws_vpc_security_group_egress_rule.tunnel_to_rds_postgres) == 0 &&
      length([
        for rule in aws_security_group.rds.ingress : rule
        if rule.description == "PostgreSQL from the private tunnel host only."
      ]) == 0
    )
    error_message = "The database access path must remain absent unless database_operator_access_enabled is true."
  }

  assert {
    condition = (
      output.db_tunnel_instance_id == null &&
      output.db_instance_connect_endpoint_id == null &&
      output.db_endpoint == null
    )
    error_message = "The access outputs must stay null while the feature gate is disabled."
  }
}
