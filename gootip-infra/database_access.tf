# SPEC 05.2: private, stopped-by-default database access through one EC2
# Instance Connect Endpoint and one tunnel host. Every resource is gated by
# database_operator_access_enabled and no public address or route is created.

resource "aws_security_group" "db_tunnel_endpoint" {
  count = var.database_operator_access_enabled ? 1 : 0

  name        = "${local.name_prefix}-db-eice"
  description = "Egress-only security group for the private dev Instance Connect Endpoint."
  vpc_id      = aws_vpc.main.id
  egress      = []

  # The mutual endpoint-to-tunnel and tunnel-to-RDS rules are standalone
  # resources to avoid a dependency cycle. Ignore the API-populated egress view
  # so refresh does not try to revoke those standalone rules.
  lifecycle {
    ignore_changes = [egress]
  }

  tags = {
    Name       = "${local.name_prefix}-db-eice"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_security_group" "db_tunnel" {
  count = var.database_operator_access_enabled ? 1 : 0

  name        = "${local.name_prefix}-db-tunnel"
  description = "SSH from the Instance Connect Endpoint and PostgreSQL to RDS only."
  vpc_id      = aws_vpc.main.id
  egress      = []

  # The mutual endpoint-to-tunnel and tunnel-to-RDS rules are standalone
  # resources to avoid a dependency cycle. Ignore the API-populated egress view
  # so refresh does not try to revoke those standalone rules.
  lifecycle {
    ignore_changes = [egress]
  }

  tags = {
    Name       = "${local.name_prefix}-db-tunnel"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_vpc_security_group_egress_rule" "endpoint_to_tunnel_ssh" {
  count = var.database_operator_access_enabled ? 1 : 0

  security_group_id            = aws_security_group.db_tunnel_endpoint[0].id
  referenced_security_group_id = aws_security_group.db_tunnel[0].id
  description                  = "SSH to the private tunnel host only."
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_ingress_rule" "tunnel_ssh_from_endpoint" {
  count = var.database_operator_access_enabled ? 1 : 0

  security_group_id            = aws_security_group.db_tunnel[0].id
  referenced_security_group_id = aws_security_group.db_tunnel_endpoint[0].id
  description                  = "SSH from the private Instance Connect Endpoint only."
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_egress_rule" "tunnel_to_rds_postgres" {
  count = var.database_operator_access_enabled ? 1 : 0

  security_group_id            = aws_security_group.db_tunnel[0].id
  referenced_security_group_id = aws_security_group.rds.id
  description                  = "PostgreSQL to the private RDS instance only."
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

# The RDS tunnel ingress is now part of the RDS security group so that its
# dynamic application-client rules remain managed. Forget the standalone state
# entry without deleting the live rule; the inline security group adopts it.
removed {
  from = aws_vpc_security_group_ingress_rule.rds_postgres_from_tunnel

  lifecycle {
    destroy = false
  }
}

resource "aws_ec2_instance_connect_endpoint" "db_tunnel" {
  count = var.database_operator_access_enabled ? 1 : 0

  subnet_id          = aws_subnet.private[0].id
  security_group_ids = [aws_security_group.db_tunnel_endpoint[0].id]
  preserve_client_ip = false
  ip_address_type    = "ipv4"

  tags = {
    Name       = "${local.name_prefix}-db-eice"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
    purpose    = "db-tunnel"
  }
}

resource "aws_instance" "db_tunnel" {
  count = var.database_operator_access_enabled ? 1 : 0

  ami                         = var.db_tunnel_ami_id
  instance_type               = var.db_tunnel_instance_type
  subnet_id                   = aws_subnet.private[0].id
  vpc_security_group_ids      = [aws_security_group.db_tunnel[0].id]
  associate_public_ip_address = false

  instance_initiated_shutdown_behavior = "stop"

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
  }

  volume_tags = {
    Name       = "${local.name_prefix}-db-tunnel"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
    purpose    = "db-tunnel"
  }

  tags = {
    Name       = "${local.name_prefix}-db-tunnel"
    project    = var.project
    env        = var.env
    managed_by = "terraform"
    purpose    = "db-tunnel"
  }
}

resource "aws_ec2_instance_state" "db_tunnel_stopped" {
  count = var.database_operator_access_enabled ? 1 : 0

  instance_id = aws_instance.db_tunnel[0].id
  state       = "stopped"
}
