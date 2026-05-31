variable "environment" {
  type = string
}

variable "workloads_ou_name" {
  type        = string
  description = "Name of the OU for workloads"
}

variable "workloads_ou_parent_id" {
  type        = string
  description = "Parent OU ID for workloads"
}

variable "app_plane_account_name" {
  type        = string
  description = "Name of the application plane account"
}

variable "app_plane_account_email" {
  type        = string
  description = "Email of the application plane account"
}

variable "prowler_gcp_sa_id" {
  type        = string
  description = "Unique numeric ID of the prowler-uploader GCP service account (used as OIDC subject for AWS federation)"
}

variable "prowler_additional_gcp_sa_ids" {
  type        = list(string)
  default     = []
  description = "Additional GCP SA unique IDs allowed to assume the prowler role (e.g. other environment's prowler SA)"
}

variable "google_oidc_additional_audiences" {
  type        = list(string)
  default     = []
  description = "Additional GCP SA unique IDs to include in the Google OIDC provider client_id_list (for non-Prowler roles that also use WIF)"
}
