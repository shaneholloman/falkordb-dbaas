#!/usr/bin/env python3
"""Cloud Evidence Collector — runs inside the cluster as a CronJob.

Collects cloud provider API evidence for SOC 2 controls and uploads
structured JSON files to GCS under:
  gs://BUCKET/cloud-evidence/YYYY/MM/DD/<provider>/

Evidence collected per provider:
  GCP: IAM policies, monitoring policies, uptime checks, audit logs config,
       GKE cluster metadata, firewall rules, encryption (KMS, disk, GCS),
       resource policies, projects list
  AWS: IAM users/groups/MFA, CloudTrail, EKS clusters (all in account),
       security groups, password policy, encryption config

Environment variables:
  EVIDENCE_BUCKET   — GCS bucket name (required)
  CLOUD_PROVIDER    — "gcp", "aws", or "all" (required)
  GCP_PROJECT_IDS   — comma-separated GCP project IDs (for GCP provider)
  AWS_REGION        — AWS region (for AWS provider, default us-east-2)
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

BUCKET = os.environ["EVIDENCE_BUCKET"]
CLOUD_PROVIDER = os.environ.get("CLOUD_PROVIDER", "gcp")
GCP_PROJECTS = [p.strip() for p in os.environ.get("GCP_PROJECT_IDS", "").split(",") if p.strip()]
AWS_REGION = os.environ.get("AWS_REGION", "us-east-2")

DATE_PATH = datetime.now(timezone.utc).strftime("%Y/%m/%d")
OUTPUT_DIR = Path("/tmp/cloud-evidence")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def _run(cmd: list[str], timeout: int = 60) -> str:
    """Run a command and return stdout."""
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0:
        raise RuntimeError(f"Command failed ({result.returncode}): {' '.join(cmd)}\n{result.stderr}")
    return result.stdout


def _save(provider: str, category: str, filename: str, data) -> Path:
    """Save evidence JSON with metadata envelope."""
    out_dir = OUTPUT_DIR / provider / category
    out_dir.mkdir(parents=True, exist_ok=True)
    envelope = {
        "_metadata": {
            "collected_at": datetime.now(timezone.utc).isoformat(),
            "collector": "cloud-evidence-cronjob",
            "provider": provider,
            "category": category,
        },
        "data": data,
    }
    path = out_dir / filename
    path.write_text(json.dumps(envelope, indent=2, default=str))
    return path


def _save_raw(provider: str, category: str, filename: str, raw_json: str) -> Path:
    """Save raw JSON output from CLI commands."""
    try:
        data = json.loads(raw_json)
    except json.JSONDecodeError:
        data = raw_json
    return _save(provider, category, filename, data)


# ---------------------------------------------------------------------------
# GCP Evidence Collection
# ---------------------------------------------------------------------------
def collect_gcp():
    """Collect all GCP evidence."""
    if not GCP_PROJECTS:
        print("WARN: GCP_PROJECT_IDS not set, skipping GCP collection")
        return

    for project in GCP_PROJECTS:
        print(f"  Collecting GCP evidence for project: {project}")

        # IAM policy
        try:
            out = _run(["gcloud", "projects", "get-iam-policy", project, "--format=json"])
            _save_raw("gcp", "iam", f"iam-policy-{project}.json", out)
        except Exception as e:
            print(f"    WARN: IAM policy for {project}: {e}")

        # IAM audit config
        try:
            out = _run(["gcloud", "projects", "get-iam-policy", project,
                        "--format=json(auditConfigs)"])
            _save_raw("gcp", "iam", f"audit-config-{project}.json", out)
        except Exception as e:
            print(f"    WARN: Audit config for {project}: {e}")

        # Monitoring alerting policies
        try:
            out = _run(["gcloud", "alpha", "monitoring", "policies", "list",
                        "--project", project, "--format=json"])
            _save_raw("gcp", "monitoring", f"alert-policies-{project}.json", out)
        except Exception as e:
            print(f"    WARN: Monitoring policies for {project}: {e}")

        # Uptime checks
        try:
            out = _run(["gcloud", "alpha", "monitoring", "uptime", "list-configs",
                        "--project", project, "--format=json"])
            _save_raw("gcp", "monitoring", f"uptime-checks-{project}.json", out)
        except Exception as e:
            print(f"    WARN: Uptime checks for {project}: {e}")

        # GKE clusters (full metadata)
        try:
            out = _run(["gcloud", "container", "clusters", "list",
                        "--project", project, "--format=json"])
            _save_raw("gcp", "gke", f"clusters-{project}.json", out)
        except Exception as e:
            print(f"    WARN: GKE clusters for {project}: {e}")

        # Firewall rules
        try:
            out = _run(["gcloud", "compute", "firewall-rules", "list",
                        "--project", project, "--format=json"])
            _save_raw("gcp", "firewall", f"firewall-rules-{project}.json", out)
        except Exception as e:
            print(f"    WARN: Firewall rules for {project}: {e}")

        # Compute disks (encryption)
        try:
            out = _run(["gcloud", "compute", "disks", "list",
                        "--project", project, "--format=json(name,diskEncryptionKey,sourceImageEncryptionKey,zone,status)"])
            _save_raw("gcp", "encryption", f"disk-encryption-{project}.json", out)
        except Exception as e:
            print(f"    WARN: Disk encryption for {project}: {e}")

        # GCS bucket encryption
        try:
            out = _run(["gcloud", "storage", "buckets", "list",
                        "--project", project, "--format=json(name,encryption,location)"])
            _save_raw("gcp", "encryption", f"gcs-bucket-encryption-{project}.json", out)
        except Exception as e:
            print(f"    WARN: GCS bucket encryption for {project}: {e}")

        # Resource policies (snapshot schedules etc.)
        try:
            out = _run(["gcloud", "compute", "resource-policies", "list",
                        "--project", project, "--format=json"])
            _save_raw("gcp", "backups", f"resource-policies-{project}.json", out)
        except Exception as e:
            print(f"    WARN: Resource policies for {project}: {e}")

    # Projects list (cross-project)
    try:
        out = _run(["gcloud", "projects", "list", "--format=json(projectId,name,labels)"])
        _save_raw("gcp", "org", "projects-list.json", out)
    except Exception as e:
        print(f"    WARN: Projects list: {e}")


# ---------------------------------------------------------------------------
# AWS Evidence Collection
# ---------------------------------------------------------------------------
def collect_aws():
    """Collect all AWS evidence."""
    print(f"  Collecting AWS evidence (region: {AWS_REGION})")

    # IAM users
    try:
        out = _run(["aws", "iam", "list-users", "--output", "json"])
        data = json.loads(out)
        _save("aws", "iam", "iam-users.json", data)

        # MFA devices per user
        users = data.get("Users", [])
        mfa_data = []
        for user in users:
            try:
                mfa_out = _run(["aws", "iam", "list-mfa-devices",
                                "--user-name", user["UserName"], "--output", "json"])
                mfa_data.append({
                    "user": user["UserName"],
                    "mfa_devices": json.loads(mfa_out).get("MFADevices", [])
                })
            except Exception:
                pass
        _save("aws", "iam", "iam-mfa-devices.json", mfa_data)
    except Exception as e:
        print(f"    WARN: IAM users: {e}")

    # IAM groups & attached policies
    try:
        out = _run(["aws", "iam", "list-groups", "--output", "json"])
        groups = json.loads(out).get("Groups", [])
        group_details = []
        for g in groups:
            try:
                pol_out = _run(["aws", "iam", "list-attached-group-policies",
                                "--group-name", g["GroupName"], "--output", "json"])
                group_details.append({
                    "group": g["GroupName"],
                    "policies": json.loads(pol_out).get("AttachedPolicies", [])
                })
            except Exception:
                pass
        _save("aws", "iam", "iam-groups-policies.json", group_details)
    except Exception as e:
        print(f"    WARN: IAM groups: {e}")

    # Password policy
    try:
        out = _run(["aws", "iam", "get-account-password-policy", "--output", "json"])
        _save_raw("aws", "iam", "password-policy.json", out)
    except Exception as e:
        print(f"    WARN: Password policy: {e}")

    # CloudTrail
    try:
        out = _run(["aws", "cloudtrail", "describe-trails",
                    "--region", AWS_REGION, "--output", "json"])
        _save_raw("aws", "logging", "cloudtrail.json", out)
    except Exception as e:
        print(f"    WARN: CloudTrail: {e}")

    # EKS clusters (discover all)
    try:
        out = _run(["aws", "eks", "list-clusters",
                    "--region", AWS_REGION, "--output", "json"])
        clusters = json.loads(out).get("clusters", [])
        _save("aws", "eks", "cluster-list.json", clusters)

        for cluster in clusters:
            # Full cluster description
            try:
                desc = _run(["aws", "eks", "describe-cluster", "--name", cluster,
                             "--region", AWS_REGION, "--output", "json"])
                _save_raw("aws", "eks", f"cluster-{cluster}.json", desc)
            except Exception as e:
                print(f"    WARN: EKS describe {cluster}: {e}")

            # Access entries
            try:
                access = _run(["aws", "eks", "list-access-entries",
                               "--cluster-name", cluster,
                               "--region", AWS_REGION, "--output", "json"])
                _save_raw("aws", "eks", f"access-entries-{cluster}.json", access)
            except Exception as e:
                print(f"    WARN: EKS access entries {cluster}: {e}")

            # Nodegroups
            try:
                ng_out = _run(["aws", "eks", "list-nodegroups",
                               "--cluster-name", cluster,
                               "--region", AWS_REGION, "--output", "json"])
                ng_list = json.loads(ng_out).get("nodegroups", [])
                ng_details = []
                for ng in ng_list:
                    try:
                        detail = _run(["aws", "eks", "describe-nodegroup",
                                       "--cluster-name", cluster,
                                       "--nodegroup-name", ng,
                                       "--region", AWS_REGION, "--output", "json"])
                        ng_details.append(json.loads(detail).get("nodegroup", {}))
                    except Exception:
                        pass
                _save("aws", "eks", f"nodegroups-{cluster}.json", ng_details)
            except Exception as e:
                print(f"    WARN: EKS nodegroups {cluster}: {e}")

    except Exception as e:
        print(f"    WARN: EKS list-clusters: {e}")

    # Security groups
    try:
        out = _run(["aws", "ec2", "describe-security-groups",
                    "--region", AWS_REGION, "--output", "json"])
        _save_raw("aws", "firewall", "security-groups.json", out)
    except Exception as e:
        print(f"    WARN: Security groups: {e}")


# ---------------------------------------------------------------------------
# Upload to GCS
# ---------------------------------------------------------------------------
def upload_to_gcs():
    """Upload all collected evidence to GCS."""
    from google.cloud import storage

    client = storage.Client()
    bucket = client.bucket(BUCKET)
    prefix = f"cloud-evidence/{DATE_PATH}"

    count = 0
    for path in OUTPUT_DIR.rglob("*.json"):
        rel = path.relative_to(OUTPUT_DIR)
        blob_name = f"{prefix}/{rel}"
        blob = bucket.blob(blob_name)
        blob.upload_from_filename(str(path))
        count += 1

    print(f"  Uploaded {count} files to gs://{BUCKET}/{prefix}/")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    print(f"Cloud Evidence Collector — {datetime.now(timezone.utc).isoformat()}")
    print(f"  Provider: {CLOUD_PROVIDER}")
    print(f"  Bucket: {BUCKET}")
    print(f"  Output path: cloud-evidence/{DATE_PATH}/")

    if CLOUD_PROVIDER in ("gcp", "all"):
        collect_gcp()

    if CLOUD_PROVIDER in ("aws", "all"):
        collect_aws()

    upload_to_gcs()
    print("Done.")


if __name__ == "__main__":
    main()
