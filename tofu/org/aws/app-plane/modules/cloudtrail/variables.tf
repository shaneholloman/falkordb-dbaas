variable "region" {
  type        = string
  description = "AWS region for CloudTrail"
}

variable "assume_role_arn" {
  type        = string
  description = "ARN of the role to assume in the app-plane account"
}

variable "trail_name" {
  type        = string
  default     = "cloudtrail"
  description = "Name of the CloudTrail trail"
}

variable "s3_bucket_name" {
  type        = string
  description = "Name of the S3 bucket for CloudTrail logs"
}

variable "log_retention_days" {
  type        = number
  default     = 90
  description = "CloudWatch Logs retention in days"
}
