# IAM role for Prowler to perform read-only SOC 2 compliance scanning
# in the AWS org account. Assumed from the ctrl-plane GKE cluster using
# GCP Workload Identity Federation (no long-lived AWS credentials).
#
# Trust model: The prowler-uploader GCP service account on the ctrl-plane
# cluster obtains a Google ID token via GKE Workload Identity. AWS trusts
# accounts.google.com as an OIDC provider and allows AssumeRoleWithWebIdentity
# when the token's `sub` matches the GCP SA unique ID.
#
# Attached policies:
#   - SecurityAudit (AWS managed) — read-only access to most AWS services
#   - ViewOnlyAccess (AWS managed) — additional read access for console resources

data "aws_caller_identity" "current" {}

# OIDC provider trusting Google — allows GCP service accounts to assume
# AWS roles via AssumeRoleWithWebIdentity.
resource "aws_iam_openid_connect_provider" "google" {
  url            = "https://accounts.google.com"
  client_id_list = ["102883644372444058074", "sts.amazonaws.com"]
}

resource "aws_iam_role" "prowler_scanner" {
  name = "prowler-soc2-scanner"
  path = "/security/"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = aws_iam_openid_connect_provider.google.arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "accounts.google.com:aud" = "sts.amazonaws.com"
            "accounts.google.com:sub" = var.prowler_gcp_sa_id
          }
        }
      }
    ]
  })

  tags = {
    Purpose     = "soc2-compliance-scanning"
    ManagedBy   = "tofu"
    Environment = var.environment
  }
}

resource "aws_iam_role_policy_attachment" "prowler_security_audit" {
  role       = aws_iam_role.prowler_scanner.name
  policy_arn = "arn:aws:iam::aws:policy/SecurityAudit"
}

resource "aws_iam_role_policy_attachment" "prowler_view_only" {
  role       = aws_iam_role.prowler_scanner.name
  policy_arn = "arn:aws:iam::aws:policy/job-function/ViewOnlyAccess"
}

# Additional inline policy for resources not covered by SecurityAudit
resource "aws_iam_role_policy" "prowler_additional" {
  name = "prowler-additional-permissions"
  role = aws_iam_role.prowler_scanner.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ProwlerAdditionalRead"
        Effect = "Allow"
        Action = [
          "account:Get*",
          "appstream:Describe*",
          "codeartifact:List*",
          "codebuild:BatchGet*",
          "ds:Get*",
          "ds:Describe*",
          "ds:List*",
          "ec2:GetEbsEncryptionByDefault",
          "ecr:Describe*",
          "ecr:GetRegistryPolicy",
          "elasticfilesystem:DescribeBackupPolicy",
          "glue:GetConnections",
          "glue:GetSecurityConfiguration*",
          "glue:SearchTables",
          "lambda:GetFunction*",
          "macie2:GetMacieSession",
          "s3:GetAccountPublicAccessBlock",
          "shield:DescribeProtection",
          "shield:GetSubscriptionState",
          "ssm-incidents:List*",
          "support:Describe*",
          "tag:GetTagKeys",
          "wellarchitected:List*",
        ]
        Resource = "*"
      }
    ]
  })
}

output "prowler_role_arn" {
  value       = aws_iam_role.prowler_scanner.arn
  description = "ARN of the Prowler IAM role to assume for scanning"
}
