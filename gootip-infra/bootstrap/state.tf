data "aws_iam_policy_document" "state_bucket_tls_only" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      local.state_bucket_arn,
      "${local.state_bucket_arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket" "state" {
  count = var.account_resource_phase_enabled ? 1 : 0

  bucket = local.state_bucket_name

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name       = local.state_bucket_name
    project    = var.project
    env        = var.env
    managed_by = "terraform"
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  count = var.account_resource_phase_enabled ? 1 : 0

  bucket                  = aws_s3_bucket.state[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  count = var.account_resource_phase_enabled ? 1 : 0

  bucket = aws_s3_bucket.state[0].id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "state" {
  count = var.account_resource_phase_enabled ? 1 : 0

  bucket = aws_s3_bucket.state[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  count = var.account_resource_phase_enabled ? 1 : 0

  bucket = aws_s3_bucket.state[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  count = var.account_resource_phase_enabled ? 1 : 0

  bucket = aws_s3_bucket.state[0].id
  policy = data.aws_iam_policy_document.state_bucket_tls_only.json

  depends_on = [aws_s3_bucket_public_access_block.state]
}
