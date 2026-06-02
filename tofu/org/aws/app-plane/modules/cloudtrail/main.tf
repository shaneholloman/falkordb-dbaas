provider "aws" {
  alias  = "cloudtrail"
  region = var.region
  assume_role {
    role_arn = var.assume_role_arn
  }
}

data "aws_caller_identity" "current" {
  provider = aws.cloudtrail
}

data "aws_partition" "current" {
  provider = aws.cloudtrail
}

data "aws_region" "current" {
  provider = aws.cloudtrail
}

# ── CloudWatch Logs ───────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "cloudtrail" {
  provider = aws.cloudtrail

  name              = "${var.trail_name}-events"
  retention_in_days = var.log_retention_days
}

# ── IAM Role for CloudTrail → CloudWatch ──────────────────────────────

data "aws_iam_policy_document" "cloudtrail_assume_role" {
  provider = aws.cloudtrail

  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cloudtrail_cloudwatch_role" {
  provider = aws.cloudtrail

  name               = "cloudtrail-cloudwatch-logs-role"
  assume_role_policy = data.aws_iam_policy_document.cloudtrail_assume_role.json
}

data "aws_iam_policy_document" "cloudtrail_cloudwatch_logs" {
  provider = aws.cloudtrail

  statement {
    sid    = "WriteCloudWatchLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.cloudtrail.arn}:*"]
  }
}

resource "aws_iam_policy" "cloudtrail_cloudwatch_logs" {
  provider = aws.cloudtrail

  name   = "cloudtrail-cloudwatch-logs-policy"
  policy = data.aws_iam_policy_document.cloudtrail_cloudwatch_logs.json
}

resource "aws_iam_role_policy_attachment" "main" {
  provider = aws.cloudtrail

  role       = aws_iam_role.cloudtrail_cloudwatch_role.name
  policy_arn = aws_iam_policy.cloudtrail_cloudwatch_logs.arn
}

# ── S3 Bucket for CloudTrail Logs ─────────────────────────────────────

data "aws_iam_policy_document" "supplemental_policy" {
  provider = aws.cloudtrail

  statement {
    effect    = "Allow"
    actions   = ["s3:GetBucketAcl"]
    resources = ["arn:${data.aws_partition.current.partition}:s3:::${var.s3_bucket_name}"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
  }

  statement {
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["arn:${data.aws_partition.current.partition}:s3:::${var.s3_bucket_name}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
  }

  statement {
    sid       = "enforce-tls-requests-only"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = ["arn:${data.aws_partition.current.partition}:s3:::${var.s3_bucket_name}/*"]
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid       = "inventory-and-analytics"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["arn:${data.aws_partition.current.partition}:s3:::${var.s3_bucket_name}/*"]
    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:s3:::${var.s3_bucket_name}"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
  }
}

resource "aws_s3_bucket" "private_bucket" {
  provider = aws.cloudtrail

  bucket = var.s3_bucket_name
}

resource "aws_s3_bucket_versioning" "private_bucket" {
  provider = aws.cloudtrail

  bucket = aws_s3_bucket.private_bucket.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "private_bucket" {
  provider = aws.cloudtrail

  bucket                                = aws_s3_bucket.private_bucket.id
  transition_default_minimum_object_size = "varies_by_storage_class"

  rule {
    id     = "abort-incomplete-multipart-upload"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 14
    }

    expiration {
      expired_object_delete_marker = true
    }

    noncurrent_version_expiration {
      noncurrent_days = 365
    }

    noncurrent_version_transition {
      noncurrent_days = 30
      storage_class   = "STANDARD_IA"
    }
  }

  rule {
    id     = "aws-bucket-inventory"
    status = "Enabled"

    filter {
      prefix = "_AWSBucketInventory/"
    }

    expiration {
      days = 14
    }
  }

  rule {
    id     = "aws-bucket-analytics"
    status = "Enabled"

    filter {
      prefix = "_AWSBucketAnalytics/"
    }

    expiration {
      days = 30
    }
  }
}

resource "aws_s3_bucket_ownership_controls" "private_bucket" {
  provider = aws.cloudtrail

  bucket = aws_s3_bucket.private_bucket.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_policy" "private_bucket" {
  provider = aws.cloudtrail

  bucket = aws_s3_bucket.private_bucket.id
  policy = data.aws_iam_policy_document.supplemental_policy.json
}

resource "aws_s3_bucket_public_access_block" "public_access_block" {
  provider = aws.cloudtrail

  bucket                  = aws_s3_bucket.private_bucket.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "private_bucket" {
  provider = aws.cloudtrail

  bucket = aws_s3_bucket.private_bucket.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# ── S3 Access Logging Bucket ─────────────────────────────────────────
# Prowler / CIS: CloudTrail S3 bucket must have access logging enabled.

resource "aws_s3_bucket" "access_logs" {
  provider = aws.cloudtrail

  bucket = "${var.s3_bucket_name}-access-logs"
}

resource "aws_s3_bucket_versioning" "access_logs" {
  provider = aws.cloudtrail

  bucket = aws_s3_bucket.access_logs.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_ownership_controls" "access_logs" {
  provider = aws.cloudtrail

  bucket = aws_s3_bucket.access_logs.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "access_logs" {
  provider = aws.cloudtrail

  bucket                  = aws_s3_bucket.access_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "access_logs" {
  provider = aws.cloudtrail

  bucket = aws_s3_bucket.access_logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "access_logs" {
  provider = aws.cloudtrail

  bucket = aws_s3_bucket.access_logs.id

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

resource "aws_s3_bucket_logging" "cloudtrail_bucket" {
  provider = aws.cloudtrail

  bucket        = aws_s3_bucket.private_bucket.id
  target_bucket = aws_s3_bucket.access_logs.id
  target_prefix = "access-logs/"
}

# ── CloudTrail ────────────────────────────────────────────────────────

resource "aws_cloudtrail" "main" {
  provider = aws.cloudtrail

  name                          = var.trail_name
  s3_bucket_name                = aws_s3_bucket.private_bucket.id
  s3_key_prefix                 = "cloudtrail"
  include_global_service_events = true
  is_multi_region_trail         = true
  enable_log_file_validation    = true
  enable_logging                = false
  cloud_watch_logs_group_arn    = "${aws_cloudwatch_log_group.cloudtrail.arn}:*"
  cloud_watch_logs_role_arn     = aws_iam_role.cloudtrail_cloudwatch_role.arn
}
