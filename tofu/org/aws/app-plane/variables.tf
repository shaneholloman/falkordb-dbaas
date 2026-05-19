variable "app_plane_account_id" {
  type        = string
  description = "The AWS account ID for the application plane"
}

variable "google_client_ids" {
  description = "The client IDs for Google authentication"
  type        = list(string)
}

variable "cluster_user_role_audience" {
  description = "The audience for the cluster user role"
  type        = string
}

variable "cluster_user_role_audiences" {
  description = "List of audiences for the cluster user role trust policy"
  type        = list(string)
}

variable "cloudtrail_region" {
  type        = string
  default     = "us-east-1"
  description = "AWS region where CloudTrail resources reside"
}

variable "cloudtrail_s3_bucket_name" {
  type        = string
  description = "Name of the S3 bucket for CloudTrail logs"
}
