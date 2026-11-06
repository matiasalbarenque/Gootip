provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      project    = var.project
      env        = var.env
      managed_by = "terraform"
    }
  }
}

# The imported legacy source user retains its historical tags until a reviewed
# cutover reconciliation. All bootstrap-managed resources use the default
# provider above and receive the required common tags.
provider "aws" {
  alias               = "source_user"
  region              = var.aws_region
  allowed_account_ids = [var.aws_account_id]
}
