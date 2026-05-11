# Terragrunt shim for org/aws/org
#
# Manages AWS Organization structure: Workloads OU and app-plane account.
# Apply manually; it is NOT part of the CI runtime pipeline.

include "root" {
  path   = find_in_parent_folders("terragrunt.hcl")
  expose = true
}

# Pin to the historical GCS prefix so no state migration is needed.
generate "backend" {
  path      = "backend_override.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<-EOF
    terraform {
      backend "gcs" {
        bucket = "${include.root.locals.tf_state_bucket}"
        prefix = "aws/org"
      }
    }
  EOF
}
