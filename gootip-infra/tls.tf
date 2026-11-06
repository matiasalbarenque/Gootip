locals {
  rds_ca_layer_archive_path  = "${path.module}/rds-ca-layer.zip"
  rds_ca_layer_checksum_path = "${path.module}/rds-ca-layer.zip.sha256"
}

# The archive is built from the official Region-derived trust store before the
# plan. Terraform only consumes the verified local bytes so apply cannot fetch
# a changed CA bundle. The ignored checksum file pins the reviewed archive.
resource "aws_lambda_layer_version" "rds_ca" {
  filename         = local.rds_ca_layer_archive_path
  layer_name       = "${var.project}-${var.env}-rds-ca"
  description      = "Official AWS RDS CA bundle for verified PostgreSQL TLS."
  source_code_hash = filebase64sha256(local.rds_ca_layer_archive_path)

  lifecycle {
    precondition {
      condition = can(filesha256(local.rds_ca_layer_archive_path)) && can(file(local.rds_ca_layer_checksum_path)) ? (
        filesha256(local.rds_ca_layer_archive_path) == split("  ", trimspace(file(local.rds_ca_layer_checksum_path)))[0]
      ) : false
      error_message = "Run scripts/package_rds_ca_layer.sh before planning, preserve rds-ca-layer.zip and its checksum unchanged, and verify them immediately before apply."
    }
  }
}
