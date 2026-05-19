# IAM role for Prowler to perform read-only SOC 2 compliance scanning
# in the AWS app-plane account. Assumed cross-account from the ctrl-plane
# GKE cluster where security CronJobs run.
#
# Trust model: A dedicated IAM user (prowler-operator) in the management
# account holds long-lived credentials stored in a SealedSecret on GKE.
# The CronJob uses boto3 sts:AssumeRole to get temporary creds for this role.
#
# Attached policies:
#   - SecurityAudit (AWS managed) — read-only access to most AWS services
#   - ViewOnlyAccess (AWS managed) — additional read access for console resources

data "aws_caller_identity" "current" {}

# IAM user in the management account — only permission is to assume the
# prowler-soc2-scanner role in app-plane accounts.
resource "aws_iam_user" "prowler_operator" {
  name = "prowler-operator"
  path = "/security/"
  tags = {
    Purpose     = "soc2-compliance-scanning"
    ManagedBy   = "tofu"
    Environment = var.environment
  }
}

resource "aws_iam_user_policy" "prowler_operator_assume" {
  name = "assume-prowler-scanner"
  user = aws_iam_user.prowler_operator.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "sts:AssumeRole"
        Resource = aws_iam_role.prowler_scanner.arn
      }
    ]
  })
}

resource "aws_iam_access_key" "prowler_operator" {
  user = aws_iam_user.prowler_operator.name
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
          AWS = aws_iam_user.prowler_operator.arn
        }
        Action = "sts:AssumeRole"
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

output "prowler_operator_user_name" {
  value       = aws_iam_user.prowler_operator.name
  description = "IAM user name for the prowler operator"
}

output "prowler_operator_access_key_id" {
  value       = aws_iam_access_key.prowler_operator.id
  description = "Access key ID for the prowler-operator IAM user"
}

output "prowler_operator_secret_access_key" {
  value       = aws_iam_access_key.prowler_operator.secret
  sensitive   = true
  description = "Secret access key for the prowler-operator IAM user"
}
