# Terragrunt shim for org/aws/app-plane
# (was tofu/aws/3-application_plane)
#
# Manages AWS application-plane resources (EKS clusters, VPCs, IAM).
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
        prefix = "aws/app-plane"
      }
    }
  EOF
}
