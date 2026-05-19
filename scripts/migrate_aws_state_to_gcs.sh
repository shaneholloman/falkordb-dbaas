#!/bin/bash
# Migrate AWS OpenTofu state from S3 to GCS.
#
# Prerequisites:
#   - AWS CLI configured with access to the S3 buckets
#   - gcloud CLI configured with access to the GCS buckets
#   - Run from the repo root
#
# Usage:
#   ./scripts/migrate_aws_state_to_gcs.sh <env>
#
# Examples:
#   ./scripts/migrate_aws_state_to_gcs.sh dev
#   ./scripts/migrate_aws_state_to_gcs.sh prod

set -euo pipefail

ENV="${1:-}"
if [[ -z "$ENV" ]]; then
  echo "Usage: $0 <dev|prod>"
  exit 1
fi

case "$ENV" in
  dev)
    S3_BUCKET="tf-state-6332481e"
    GCS_BUCKET="falkordb-dev-state-4620"
    AWS_PROFILE="dev-seed"
    ;;
  prod)
    S3_BUCKET="tf-state-72e1084a"
    GCS_BUCKET="falkordb-prod-state-c49b"
    AWS_PROFILE="prod-seed"
    ;;
  *)
    echo "Error: env must be 'dev' or 'prod', got '$ENV'"
    exit 1
    ;;
esac

export AWS_PROFILE

# S3 key → GCS prefix mapping
# S3 keys use "state.tf" as the state filename (historical)
S3_KEYS=("org/state.tf" "application_plane/state.tf" "bootstrap/state.tf")
GCS_PREFIXES=("aws/org" "aws/app-plane" "aws/bootstrap")

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

echo "=== Migrating AWS state from S3 to GCS ($ENV) ==="
echo "  S3 bucket:  s3://$S3_BUCKET"
echo "  GCS bucket: gs://$GCS_BUCKET"
echo ""

for i in "${!S3_KEYS[@]}"; do
  s3_key="${S3_KEYS[$i]}"
  gcs_prefix="${GCS_PREFIXES[$i]}"
  gcs_object="$gcs_prefix/default.tfstate"

  echo "── $s3_key → $gcs_prefix ──"

  # Download from S3
  local_file="$TMPDIR/$(echo "$s3_key" | tr '/' '_')"
  echo "  Downloading s3://$S3_BUCKET/$s3_key ..."
  if ! aws s3 cp "s3://$S3_BUCKET/$s3_key" "$local_file" 2>/dev/null; then
    echo "  ⚠️  Not found in S3 — skipping"
    echo ""
    continue
  fi

  # Verify it's valid JSON state
  if ! jq -e '.version' "$local_file" > /dev/null 2>&1; then
    echo "  ⚠️  Downloaded file is not valid terraform state — skipping"
    echo ""
    continue
  fi

  serial=$(jq -r '.serial' "$local_file")
  resources=$(jq -r '.resources | length' "$local_file")
  echo "  State serial: $serial, resources: $resources"

  # Check if GCS already has state (avoid overwriting)
  if gsutil -q stat "gs://$GCS_BUCKET/$gcs_object" 2>/dev/null; then
    existing_serial=$(gsutil cat "gs://$GCS_BUCKET/$gcs_object" | jq -r '.serial')
    echo "  ⚠️  GCS already has state (serial: $existing_serial)"
    if [[ "$existing_serial" -ge "$serial" ]]; then
      echo "  GCS serial >= S3 serial — skipping (already up to date)"
      echo ""
      continue
    fi
    echo "  S3 serial is newer — will overwrite"
  fi

  # Upload to GCS
  echo "  Uploading to gs://$GCS_BUCKET/$gcs_object ..."
  gsutil cp "$local_file" "gs://$GCS_BUCKET/$gcs_object"
  echo "  ✅ Done"
  echo ""
done

echo "=== Migration complete ==="
echo ""
echo "Next steps:"
echo "  1. Run './scripts/terragrunt_apply.sh <stack> terraform.${ENV}.tfvars plan' for each stack"
echo "     to verify the state was picked up correctly (should show no changes)."
echo "  2. Once verified, the S3 buckets can be decommissioned."
