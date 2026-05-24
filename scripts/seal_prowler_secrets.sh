#!/bin/sh
# Populate and seal Prowler secrets for ctrl-plane overlays.
# Usage: ./scripts/seal_prowler_secrets.sh <env>
#   env: dev or prod
#
# Prerequisites:
#   - AWS credentials configured for the management account
#   - Azure credentials configured for the runtime subscription
#   - kubeseal installed
set -e

ENV=${1:?Usage: $0 <dev|prod>}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$SCRIPT_DIR/.."
cd "$ROOT_DIR"

OVERLAY_DIR="argocd/kustomize/prowler/overlays/ctrl-plane-${ENV}"
CERT="certs/ctrl-plane/sealed-secrets/${ENV}/pub-cert.pem"
TFVARS="terraform.${ENV}.tfvars"

if [ ! -d "$OVERLAY_DIR" ]; then
  echo "ERROR: overlay directory not found: $OVERLAY_DIR"
  exit 1
fi
if [ ! -f "$CERT" ]; then
  echo "ERROR: cert not found: $CERT"
  exit 1
fi

echo "==> Fetching AWS outputs from aws-org stack (${ENV})..."
AWS_ROLE_ARN=$(./scripts/terragrunt_apply.sh aws-org "$TFVARS" output -raw prowler_role_arn | tail -1)
AWS_ACCESS_KEY_ID=$(./scripts/terragrunt_apply.sh aws-org "$TFVARS" output -raw prowler_operator_access_key_id | tail -1)
AWS_SECRET_ACCESS_KEY=$(./scripts/terragrunt_apply.sh aws-org "$TFVARS" output -raw prowler_operator_secret_access_key | tail -1)

echo "==> Fetching Azure outputs from azure stack (${ENV})..."
AZURE_CLIENT_ID=$(./scripts/terragrunt_apply.sh azure "$TFVARS" output -raw prowler_client_id | tail -1)
AZURE_CLIENT_SECRET=$(./scripts/terragrunt_apply.sh azure "$TFVARS" output -raw prowler_client_secret | tail -1)
AZURE_TENANT_ID=$(./scripts/terragrunt_apply.sh azure "$TFVARS" output -raw prowler_tenant_id | tail -1)
AZURE_SUBSCRIPTION_ID=$(./scripts/terragrunt_apply.sh azure "$TFVARS" output -raw prowler_subscription_id | tail -1)

# Default region for AWS scanning
AWS_REGION="us-east-1"

echo "==> Writing aws-credentials.env..."
cat > "${OVERLAY_DIR}/aws-credentials.env" <<EOF
# prowler-aws-credentials
role-arn=${AWS_ROLE_ARN}
access-key-id=${AWS_ACCESS_KEY_ID}
secret-access-key=${AWS_SECRET_ACCESS_KEY}
region=${AWS_REGION}
EOF

echo "==> Writing azure-credentials.env..."
cat > "${OVERLAY_DIR}/azure-credentials.env" <<EOF
# prowler-azure-credentials
client-id=${AZURE_CLIENT_ID}
client-secret=${AZURE_CLIENT_SECRET}
tenant-id=${AZURE_TENANT_ID}
subscription-id=${AZURE_SUBSCRIPTION_ID}
EOF

echo "==> Sealing AWS credentials with ${CERT}..."
./scripts/seal_env.sh "${OVERLAY_DIR}/aws-credentials.env" security "$CERT"

echo "==> Sealing Azure credentials with ${CERT}..."
./scripts/seal_env.sh "${OVERLAY_DIR}/azure-credentials.env" security "$CERT"

echo "==> Done! Sealed secrets written to:"
echo "    ${OVERLAY_DIR}/aws-credentials-env-secret.yaml"
echo "    ${OVERLAY_DIR}/azure-credentials-env-secret.yaml"
echo "    Source .env files kept in ${OVERLAY_DIR}/"
echo "    Review the files and commit (exclude .env from git if sensitive)."
