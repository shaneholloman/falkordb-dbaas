# ── Org-level CloudTrail ───────────────────────────────────────────────
# Manages the organization trail "management-events" and its S3 bucket.
# The trail was originally created via the AWS Console; these resources
# are imported into state (see import blocks below).

locals {
  cloudtrail_bucket_name = "aws-cloudtrail-logs-${data.aws_caller_identity.current.account_id}-82a2d519"
  cloudtrail_trail_name  = "management-events"
  cloudtrail_region      = "us-east-2"
}

# ── S3 Bucket for CloudTrail Logs ─────────────────────────────────────

resource "aws_s3_bucket" "cloudtrail" {
  bucket = local.cloudtrail_bucket_name
}

resource "aws_s3_bucket_versioning" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "cloudtrail" {
  bucket                                = aws_s3_bucket.cloudtrail.id
  transition_default_minimum_object_size = "varies_by_storage_class"

  rule {
    id     = "Delete version after 14 days"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 14
    }
  }
}

resource "aws_s3_bucket_public_access_block" "cloudtrail" {
  bucket                  = aws_s3_bucket.cloudtrail.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_policy" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyHTTPAccess"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = "arn:aws:s3:::${local.cloudtrail_bucket_name}"
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      },
      {
        Sid       = "AWSCloudTrailAclCheck"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:GetBucketAcl"
        Resource  = "arn:aws:s3:::${local.cloudtrail_bucket_name}"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = "arn:aws:cloudtrail:${local.cloudtrail_region}:${data.aws_caller_identity.current.account_id}:trail/${local.cloudtrail_trail_name}"
          }
        }
      },
      {
        Sid       = "AWSCloudTrailWriteAccount"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "arn:aws:s3:::${local.cloudtrail_bucket_name}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"
        Condition = {
          StringEquals = {
            "s3:x-amz-acl" = "bucket-owner-full-control"
            "AWS:SourceArn" = "arn:aws:cloudtrail:${local.cloudtrail_region}:${data.aws_caller_identity.current.account_id}:trail/${local.cloudtrail_trail_name}"
          }
        }
      },
      {
        Sid       = "AWSCloudTrailWriteOrg"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "arn:aws:s3:::${local.cloudtrail_bucket_name}/AWSLogs/o-0trof5nvcv/*"
        Condition = {
          StringEquals = {
            "s3:x-amz-acl" = "bucket-owner-full-control"
            "AWS:SourceArn" = "arn:aws:cloudtrail:${local.cloudtrail_region}:${data.aws_caller_identity.current.account_id}:trail/${local.cloudtrail_trail_name}"
          }
        }
      },
    ]
  })
}

# ── S3 Access Logging Bucket ─────────────────────────────────────────
# Prowler / CIS: CloudTrail S3 bucket must have access logging enabled.

resource "aws_s3_bucket" "cloudtrail_access_logs" {
  bucket = "${local.cloudtrail_bucket_name}-access-logs"
}

resource "aws_s3_bucket_versioning" "cloudtrail_access_logs" {
  bucket = aws_s3_bucket.cloudtrail_access_logs.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "cloudtrail_access_logs" {
  bucket                  = aws_s3_bucket.cloudtrail_access_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cloudtrail_access_logs" {
  bucket = aws_s3_bucket.cloudtrail_access_logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "cloudtrail_access_logs" {
  bucket = aws_s3_bucket.cloudtrail_access_logs.id

  rule {
    id     = "expire-access-logs"
    status = "Enabled"

    filter {}

    expiration {
      days = 90
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

resource "aws_s3_bucket_logging" "cloudtrail" {
  bucket        = aws_s3_bucket.cloudtrail.id
  target_bucket = aws_s3_bucket.cloudtrail_access_logs.id
  target_prefix = "access-logs/"
}

# ── CloudTrail Trail ──────────────────────────────────────────────────

resource "aws_cloudtrail" "org" {
  name                          = local.cloudtrail_trail_name
  s3_bucket_name                = aws_s3_bucket.cloudtrail.id
  include_global_service_events = true
  is_multi_region_trail         = true
  is_organization_trail         = true
  enable_log_file_validation    = true
  enable_logging                = true
}

# ── Imports ───────────────────────────────────────────────────────────
# Import existing resources created via AWS Console.

import {
  to = aws_s3_bucket.cloudtrail
  id = "aws-cloudtrail-logs-119146126346-82a2d519"
}

import {
  to = aws_s3_bucket_versioning.cloudtrail
  id = "aws-cloudtrail-logs-119146126346-82a2d519"
}

import {
  to = aws_s3_bucket_lifecycle_configuration.cloudtrail
  id = "aws-cloudtrail-logs-119146126346-82a2d519"
}

import {
  to = aws_s3_bucket_public_access_block.cloudtrail
  id = "aws-cloudtrail-logs-119146126346-82a2d519"
}

import {
  to = aws_s3_bucket_server_side_encryption_configuration.cloudtrail
  id = "aws-cloudtrail-logs-119146126346-82a2d519"
}

import {
  to = aws_s3_bucket_policy.cloudtrail
  id = "aws-cloudtrail-logs-119146126346-82a2d519"
}

import {
  to = aws_cloudtrail.org
  id = "arn:aws:cloudtrail:us-east-2:119146126346:trail/management-events"
}

import {
  to = aws_s3_bucket.cloudtrail_access_logs
  id = "aws-cloudtrail-logs-119146126346-82a2d519-access-logs"
}

import {
  to = aws_s3_bucket_versioning.cloudtrail_access_logs
  id = "aws-cloudtrail-logs-119146126346-82a2d519-access-logs"
}

import {
  to = aws_s3_bucket_public_access_block.cloudtrail_access_logs
  id = "aws-cloudtrail-logs-119146126346-82a2d519-access-logs"
}

import {
  to = aws_s3_bucket_server_side_encryption_configuration.cloudtrail_access_logs
  id = "aws-cloudtrail-logs-119146126346-82a2d519-access-logs"
}

import {
  to = aws_s3_bucket_lifecycle_configuration.cloudtrail_access_logs
  id = "aws-cloudtrail-logs-119146126346-82a2d519-access-logs"
}

import {
  to = aws_s3_bucket_logging.cloudtrail
  id = "aws-cloudtrail-logs-119146126346-82a2d519"
}
