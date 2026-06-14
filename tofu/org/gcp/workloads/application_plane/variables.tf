
variable "org_id" {
  type = string
}

variable "project_id" {
  type = string
}

variable "project_name" {
  type = string
}

variable "project_parent_id" {
  type = string
}

variable "billing_account_id" {
  type = string
}

variable "provisioning_sa" {
  type = string
}

variable "velero_role_id" {
  type = string
}

variable "db_exporter_sa_email" {
  type = string
}
variable "metering_bucket_name" {
  type = string
}
variable "customer_rdb_bucket_name" {
  type = string
}
variable "argocd_sa_email" {
  type = string
}

variable "artifact_registry_region" {
  type    = string
  default = "us-central1"
}

variable "cloud_artifact_registry_writer_repo_name" {
  type        = string
  default     = "FalkorDB/falkordb-omnistrate"
  description = "GitHub repository allowed to impersonate the cloud Artifact Registry writer service account."
}

variable "gh_workload_identity_pool_name" {
  type        = string
  description = "Full resource name of the GitHub Actions workload identity pool from the control plane project"
}

variable "repo_name" {
  type        = string
  description = "GitHub repository name (org/repo) for workload identity attribute condition"
}
