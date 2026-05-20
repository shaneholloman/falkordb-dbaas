# Terragrunt shim for bootstrap/aws
# (was tofu/aws/1-bootstrap)
#
# This stack is applied once to bootstrap the AWS org.
# Apply manually; it is NOT part of the CI runtime pipeline.

include "root" {
  path   = find_in_parent_folders("terragrunt.hcl")
  expose = true
}

generate "backend" {
  path      = "backend_override.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<-EOF
    terraform {
      backend "gcs" {
        bucket = "${include.root.locals.tf_state_bucket}"
        prefix = "aws/bootstrap"
      }
    }
  EOF
}
