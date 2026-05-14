#!/usr/bin/env python3
"""
SOC 2 Evidence Collector — automated evidence gathering for audit controls.

This script does NOT require gcloud/aws CLI or any cloud provider credentials.
All cloud infrastructure evidence is collected by in-cluster CronJobs that
upload to the GCS evidence locker. This script only needs:

  1. GCS read access  — to download pre-collected cloud evidence
  2. Git checkout     — to read ArgoCD manifests (source of truth for K8s config)
  3. GitHub API token — for repo settings / branch protection / org members

Sources:
  - GCS Evidence Locker:
      cloud-evidence/  — IAM, GKE, EKS, firewall, encryption (from CronJob)
      grype/           — vulnerability scan results
      prowler/         — compliance scan results
      kube-bench/      — CIS benchmark results
      kubescape/       — security posture results
      trufflehog/      — secret scan results
  - GitHub API (users, permissions, branch protection, releases, PRs)
  - Wazuh API (agent inventory, detection rules) — optional
  - Git repository (ArgoCD manifests = source of truth for K8s config)

Outputs a structured evidence package to GCS:
  gs://BUCKET/soc2-evidence/YYYY/MM/DD/
    ├── manifest.json
    ├── ctrl-12/  — release notes
    ├── ctrl-21/  — monitoring/alerting config
    ...

Usage:
  export GITHUB_TOKEN="ghp_..."
  export EVIDENCE_BUCKET="falkordb-evidence-locker-a89z"
  python3 scripts/collect_soc2_evidence.py --environment dev

  # Collect specific controls only:
  python3 scripts/collect_soc2_evidence.py --controls 21,25,41,44

Prerequisites:
  pip install google-cloud-storage requests
"""
from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import platform
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
EVIDENCE_BUCKET = os.environ.get("EVIDENCE_BUCKET", "falkordb-evidence-locker-a89z")
GITHUB_ORG = os.environ.get("GITHUB_ORG", "FalkorDB")
GITHUB_REPOS = os.environ.get("GITHUB_REPOS", "falkordb-dbaas,falkordb").split(",")
GITHUB_TOKEN = os.environ.get("PRIVATE_REPO_TOKEN") or os.environ.get("GITHUB_TOKEN", "")

WAZUH_API_URL = os.environ.get("WAZUH_API_URL", "")
WAZUH_API_USER = os.environ.get("WAZUH_API_USER", "wazuh-wui")
WAZUH_API_PASS = os.environ.get("WAZUH_API_PASS", "")

# Path to the repo root (for reading ArgoCD manifests)
REPO_ROOT = Path(os.environ.get("REPO_ROOT", Path(__file__).resolve().parent.parent))

# Controls that can be automated
AUTOMATABLE_CONTROLS = [
    12, 21, 22, 24, 25, 26, 27, 28, 29, 30, 33, 34, 37, 40, 41,
    44, 45, 46, 47, 48, 49, 52, 56, 57, 58,
]

# Cache for downloaded cloud evidence
_cloud_evidence_cache: dict[str, Any] | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _collector_identity() -> dict:
    """Return identity of who/what is running this collection."""
    return {
        "user": getpass.getuser(),
        "hostname": platform.node(),
        "platform": platform.platform(),
        "collected_at": _now_iso(),
    }


def _sha256(filepath: Path) -> str:
    """Compute SHA256 hash of a file."""
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def _github_get(endpoint: str, params: dict | None = None) -> Any:
    """GET from GitHub API with auth."""
    import requests

    url = f"https://api.github.com{endpoint}"
    headers = {
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "Accept": "application/vnd.github.v3+json",
    }
    resp = requests.get(url, headers=headers, params=params or {}, timeout=30)
    resp.raise_for_status()
    return resp.json()


def _github_get_paginated(endpoint: str, params: dict | None = None) -> list:
    """GET all pages from a GitHub API endpoint."""
    import requests

    url = f"https://api.github.com{endpoint}"
    headers = {
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "Accept": "application/vnd.github.v3+json",
    }
    params = dict(params or {})
    params.setdefault("per_page", "100")
    all_items = []
    page = 1
    while True:
        params["page"] = str(page)
        resp = requests.get(url, headers=headers, params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        if not data:
            break
        all_items.extend(data)
        if len(data) < 100:
            break
        page += 1
    return all_items


def _gcs_download_latest(bucket_name: str, scanner: str, output_dir: Path,
                         max_files: int = 50) -> dict:
    """Download latest scan results from GCS for a given scanner."""
    from google.cloud import storage

    client = storage.Client()
    bucket = client.bucket(bucket_name)
    today = datetime.now(timezone.utc)

    # Try today, then yesterday, then day before
    for days_ago in range(3):
        dt = today - timedelta(days=days_ago)
        prefix = f"{scanner}/{dt.strftime('%Y/%m/%d')}"
        blobs = list(bucket.list_blobs(prefix=prefix))
        blobs = [b for b in blobs if not b.name.endswith("/")]
        if blobs:
            scanner_dir = output_dir / scanner
            scanner_dir.mkdir(parents=True, exist_ok=True)
            downloaded = 0
            for blob in blobs[:max_files]:
                rel = blob.name.split("/", 4)[-1] if "/" in blob.name else blob.name
                local = scanner_dir / rel.replace("/", "_")
                blob.download_to_filename(str(local))
                downloaded += 1
            return {
                "source": f"gs://{bucket_name}/{prefix}",
                "date": dt.strftime("%Y-%m-%d"),
                "files_downloaded": downloaded,
            }

    return {"source": f"gs://{bucket_name}/{scanner}/", "date": "none_found", "files_downloaded": 0}


def _download_cloud_evidence() -> dict[str, Any]:
    """Download cloud-evidence from GCS (collected by in-cluster CronJob).

    Returns a dict keyed by relative path (e.g. "gcp/iam/iam-policy-proj.json")
    with the parsed JSON data from each file.
    """
    global _cloud_evidence_cache
    if _cloud_evidence_cache is not None:
        return _cloud_evidence_cache

    from google.cloud import storage

    client = storage.Client()
    bucket = client.bucket(EVIDENCE_BUCKET)
    today = datetime.now(timezone.utc)

    evidence: dict[str, Any] = {}

    # Try today, then last 7 days (CronJob runs weekly)
    for days_ago in range(8):
        dt = today - timedelta(days=days_ago)
        prefix = f"cloud-evidence/{dt.strftime('%Y/%m/%d')}"
        blobs = list(bucket.list_blobs(prefix=prefix))
        blobs = [b for b in blobs if b.name.endswith(".json") and not b.name.endswith("/")]
        if blobs:
            for blob in blobs:
                # Key is the path after the date: e.g. gcp/iam/iam-policy-proj.json
                parts = blob.name.split("/", 4)  # cloud-evidence/YYYY/MM/DD/rest
                if len(parts) >= 5:
                    rel_key = parts[4]
                else:
                    rel_key = blob.name.split("/")[-1]
                try:
                    content = blob.download_as_text()
                    data = json.loads(content)
                    # Unwrap envelope if present
                    if isinstance(data, dict) and "data" in data and "_metadata" in data:
                        evidence[rel_key] = data["data"]
                    else:
                        evidence[rel_key] = data
                except Exception:
                    pass
            print(f"     (loaded {len(evidence)} cloud-evidence files from {prefix})")
            break
    else:
        print("     WARN: No cloud-evidence found in GCS (checked last 8 days)")

    _cloud_evidence_cache = evidence
    return evidence


def _get_cloud_evidence(provider: str, category: str, filename_pattern: str = "") -> list[tuple[str, Any]]:
    """Get cloud evidence files matching provider/category/pattern.

    Returns list of (filename, data) tuples.
    """
    evidence = _download_cloud_evidence()
    prefix = f"{provider}/{category}/"
    results = []
    for key, data in evidence.items():
        if key.startswith(prefix):
            if not filename_pattern or filename_pattern in key:
                results.append((key, data))
    return results


def _wazuh_api_get(endpoint: str, params: dict | None = None) -> Any:
    """GET from Wazuh API (handles auth)."""
    import requests

    if not WAZUH_API_URL or not WAZUH_API_PASS:
        raise RuntimeError("WAZUH_API_URL and WAZUH_API_PASS required")

    # Authenticate
    resp = requests.post(
        f"{WAZUH_API_URL}/security/user/authenticate",
        auth=(WAZUH_API_USER, WAZUH_API_PASS),
        verify=False,
        timeout=10,
    )
    resp.raise_for_status()
    token = resp.json()["data"]["token"]

    # Call endpoint
    resp = requests.get(
        f"{WAZUH_API_URL}{endpoint}",
        headers={"Authorization": f"Bearer {token}"},
        params=params or {},
        verify=False,
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def _read_repo_files(glob_pattern: str) -> list[dict]:
    """Read files from the git repo matching a glob pattern. Returns list of {path, content}."""
    results = []
    for f in sorted(REPO_ROOT.glob(glob_pattern)):
        if f.is_file():
            try:
                content = f.read_text()
                results.append({"path": str(f.relative_to(REPO_ROOT)), "content": content})
            except Exception:
                pass
    return results


def _save_evidence(output_dir: Path, ctrl_num: int, filename: str, data: Any,
                   source: str = "", command: str = "") -> str:
    """Save evidence wrapped in an audit envelope. Returns relative path."""
    ctrl_dir = output_dir / f"ctrl-{ctrl_num:02d}"
    ctrl_dir.mkdir(parents=True, exist_ok=True)
    filepath = ctrl_dir / filename

    # Wrap in audit envelope with provenance metadata
    envelope = {
        "_metadata": {
            "collected_at": _now_iso(),
            "collector": getpass.getuser(),
            "hostname": platform.node(),
            "source": source,
            "command": command,
            "control_id": ctrl_num,
            "filename": filename,
        },
        "data": data,
    }

    if isinstance(data, (dict, list)):
        filepath.write_text(json.dumps(envelope, indent=2, default=str))
    else:
        # For plain text data, write a .meta sidecar
        filepath.write_text(str(data))
        meta_path = filepath.with_suffix(filepath.suffix + ".meta.json")
        meta_path.write_text(json.dumps(envelope["_metadata"], indent=2, default=str))

    return str(filepath.relative_to(output_dir))


# ---------------------------------------------------------------------------
# Evidence Collectors
# ---------------------------------------------------------------------------


def collect_ctrl_12_releases(output_dir: Path) -> dict:
    """Control 12: Release notes published to customers."""
    evidence = {"control": 12, "description": "Release notes", "artifacts": []}

    for repo in GITHUB_REPOS:
        repo_full = f"{GITHUB_ORG}/{repo}"
        try:
            releases = _github_get_paginated(
                f"/repos/{repo_full}/releases",
                params={"per_page": "20"},
            )
            release_summary = [
                {
                    "tag": r["tag_name"],
                    "name": r["name"],
                    "published_at": r["published_at"],
                    "body_length": len(r.get("body", "")),
                    "has_release_notes": bool(r.get("body", "").strip()),
                }
                for r in releases[:20]
            ]
            path = _save_evidence(output_dir, 12, f"releases-{repo}.json", release_summary,
                                  source=f"github/{repo_full}/releases",
                                  command=f"GET /repos/{repo_full}/releases")
            evidence["artifacts"].append({"type": "releases", "repo": repo, "file": path})
        except Exception as e:
            evidence["artifacts"].append({"type": "releases", "repo": repo, "error": str(e)})

    return evidence


def collect_ctrl_21_monitoring(output_dir: Path) -> dict:
    """Control 21: Monitoring tools — alert configs from git repo + GCS."""
    evidence = {"control": 21, "description": "Production monitoring tools", "artifacts": []}

    # Alert rules from git (ArgoCD kustomize = source of truth)
    alert_files = _read_repo_files("observability/rules/**/*.yaml")
    alert_files += _read_repo_files("observability/rules/**/*.yml")
    if alert_files:
        path = _save_evidence(output_dir, 21, "alert-rules-repo.json", alert_files,
                              source="git/observability/rules/",
                              command="read observability/rules/**/*.yaml from repo")
        evidence["artifacts"].append({"type": "alert_rules_config", "file": path})

    # AlertManager / notification config from git
    notif_files = _read_repo_files("argocd/kustomize/wazuh-rules/wazuh-google-chat-integration.yaml")
    notif_files += _read_repo_files("argocd/kustomize/alert-reactions/**/*.yaml")
    if notif_files:
        path = _save_evidence(output_dir, 21, "notification-config.json", notif_files,
                              source="git/argocd/kustomize/alert-reactions/",
                              command="read alert notification configs from repo")
        evidence["artifacts"].append({"type": "notification_config", "file": path})

    # Wazuh agent inventory (via API if available)
    if WAZUH_API_URL and WAZUH_API_PASS:
        try:
            agents = _wazuh_api_get("/agents", params={"limit": "500",
                                    "select": "id,name,ip,os.name,os.version,status,dateAdd,lastKeepAlive"})
            path = _save_evidence(output_dir, 21, "wazuh-agent-inventory.json", agents,
                                  source=f"wazuh-api/{WAZUH_API_URL}",
                                  command="GET /agents")
            evidence["artifacts"].append({"type": "agent_inventory", "file": path})
        except Exception as e:
            evidence["artifacts"].append({"type": "agent_inventory", "error": str(e)})

    # GCP monitoring alert policies (from cloud-evidence GCS)
    for key, data in _get_cloud_evidence("gcp", "monitoring", "alert-policies"):
        path = _save_evidence(output_dir, 21, f"gcp-alert-policies-{key.split('/')[-1]}", data,
                              source=f"gcs://cloud-evidence/{key}",
                              command="from cloud-evidence CronJob")
        evidence["artifacts"].append({"type": "gcp_alert_policies", "file": path})

    return evidence


def collect_ctrl_22_uptime(output_dir: Path) -> dict:
    """Control 22: Continuous website/app monitoring and uptime."""
    evidence = {"control": 22, "description": "Continuous uptime monitoring", "artifacts": []}

    # GCP Uptime checks (from cloud-evidence GCS)
    for key, data in _get_cloud_evidence("gcp", "monitoring", "uptime"):
        path = _save_evidence(output_dir, 22, f"gcp-uptime-{key.split('/')[-1]}", data,
                              source=f"gcs://cloud-evidence/{key}",
                              command="from cloud-evidence CronJob")
        evidence["artifacts"].append({"type": "uptime_checks", "file": path})

    return evidence


def collect_ctrl_24_log_review(output_dir: Path) -> dict:
    """Control 24: Production action logging and review."""
    evidence = {"control": 24, "description": "Production logging and review", "artifacts": []}

    # FluentBit config from git (source of truth)
    fb_files = _read_repo_files("argocd/kustomize/fluentbit/**/*.yaml")
    if fb_files:
        path = _save_evidence(output_dir, 24, "fluentbit-config.json", fb_files,
                              source="git/argocd/kustomize/fluentbit/",
                              command="read argocd/kustomize/fluentbit/**/*.yaml")
        evidence["artifacts"].append({"type": "logging_config", "file": path})

    # GCP audit log config (from cloud-evidence GCS)
    for key, data in _get_cloud_evidence("gcp", "iam", "audit-config"):
        path = _save_evidence(output_dir, 24, f"gcp-audit-log-{key.split('/')[-1]}", data,
                              source=f"gcs://cloud-evidence/{key}",
                              command="from cloud-evidence CronJob")
        evidence["artifacts"].append({"type": "audit_log_config", "file": path})

    # AWS CloudTrail (from cloud-evidence GCS)
    for key, data in _get_cloud_evidence("aws", "logging", "cloudtrail"):
        path = _save_evidence(output_dir, 24, f"aws-cloudtrail-{key.split('/')[-1]}", data,
                              source=f"gcs://cloud-evidence/{key}",
                              command="from cloud-evidence CronJob")
        evidence["artifacts"].append({"type": "aws_cloudtrail", "file": path})

    return evidence


def collect_ctrl_25_26_cloud_access(output_dir: Path) -> dict:
    """Controls 25-26: Cloud platform access (AWS/GCP IAM users + MFA)."""
    evidence = {"control": "25-26", "description": "Cloud platform access control", "artifacts": []}

    # GCP IAM (from cloud-evidence GCS)
    for key, data in _get_cloud_evidence("gcp", "iam", "iam-policy"):
        path = _save_evidence(output_dir, 25, f"gcp-iam-{key.split('/')[-1]}", data,
                              source=f"gcs://cloud-evidence/{key}",
                              command="from cloud-evidence CronJob")
        evidence["artifacts"].append({"type": "gcp_iam_policy", "file": path})

    # AWS IAM users (from cloud-evidence GCS)
    for key, data in _get_cloud_evidence("aws", "iam", "iam-users"):
        path = _save_evidence(output_dir, 25, "aws-iam-users.json", data,
                              source=f"gcs://cloud-evidence/{key}",
                              command="from cloud-evidence CronJob")
        evidence["artifacts"].append({"type": "aws_iam_users", "file": path})

    # AWS MFA status (from cloud-evidence GCS)
    for key, data in _get_cloud_evidence("aws", "iam", "iam-mfa"):
        path = _save_evidence(output_dir, 25, "aws-mfa-status.json", data,
                              source=f"gcs://cloud-evidence/{key}",
                              command="from cloud-evidence CronJob")
        evidence["artifacts"].append({"type": "aws_mfa_status", "file": path})

    # GitHub org members (Control 26)
    try:
        members = _github_get_paginated(f"/orgs/{GITHUB_ORG}/members")
        member_list = [{"login": m["login"], "id": m["id"], "type": m["type"]} for m in members]
        path = _save_evidence(output_dir, 26, "github-org-members.json", member_list,
                              source=f"github/orgs/{GITHUB_ORG}/members",
                              command=f"GET /orgs/{GITHUB_ORG}/members")
        evidence["artifacts"].append({"type": "github_members", "file": path})
    except Exception as e:
        evidence["artifacts"].append({"type": "github_members", "error": str(e)})

    return evidence


def collect_ctrl_27_admin_access(output_dir: Path) -> dict:
    """Control 27: Administrative access to production with SSO/MFA."""
    evidence = {"control": 27, "description": "Admin access to production", "artifacts": []}

    # GCP admin roles (from cloud-evidence — we filter the IAM policy for admin roles)
    for key, data in _get_cloud_evidence("gcp", "iam", "iam-policy"):
        if isinstance(data, dict):
            admin_bindings = [
                b for b in data.get("bindings", [])
                if any(role in b.get("role", "") for role in ["owner", "admin", "editor"])
            ]
        elif isinstance(data, list):
            admin_bindings = [
                b for b in data
                if isinstance(b, dict) and any(role in b.get("role", "") for role in ["owner", "admin", "editor"])
            ]
        else:
            admin_bindings = data
        project = key.split("/")[-1].replace("iam-policy-", "").replace(".json", "")
        path = _save_evidence(output_dir, 27, f"gcp-admin-roles-{project}.json", admin_bindings,
                              source=f"gcs://cloud-evidence/{key} (filtered)",
                              command="from cloud-evidence CronJob (admin/owner/editor filtered)")
        evidence["artifacts"].append({"type": "gcp_admin_roles", "file": path})

    # AWS IAM groups & policies (from cloud-evidence GCS)
    for key, data in _get_cloud_evidence("aws", "iam", "iam-groups"):
        path = _save_evidence(output_dir, 27, "aws-iam-groups-policies.json", data,
                              source=f"gcs://cloud-evidence/{key}",
                              command="from cloud-evidence CronJob")
        evidence["artifacts"].append({"type": "aws_iam_groups", "file": path})

    return evidence


def collect_ctrl_28_db_access(output_dir: Path) -> dict:
    """Control 28: Database user access — from GCS evidence + git config."""
    evidence = {"control": 28, "description": "Database user access", "artifacts": []}

    # Database access config from git repo (network policies, RBAC for DB namespaces)
    netpol_files = _read_repo_files("argocd/kustomize/**/network-polic*.yaml")
    netpol_files += _read_repo_files("tofu/runtime/**/firewall*.tf")
    if netpol_files:
        path = _save_evidence(output_dir, 28, "db-network-policies-repo.json", netpol_files,
                              source="git/argocd+tofu (network policies)",
                              command="read network policy and firewall files from repo")
        evidence["artifacts"].append({"type": "db_network_policies", "file": path})

    # GKE master authorized networks (from cloud-evidence)
    for key, data in _get_cloud_evidence("gcp", "gke", "clusters"):
        project = key.split("/")[-1].replace("clusters-", "").replace(".json", "")
        path = _save_evidence(output_dir, 28, f"gke-access-config-{project}.json", data,
                              source=f"gcs://cloud-evidence/{key}",
                              command="from cloud-evidence CronJob")
        evidence["artifacts"].append({"type": "gke_access_control", "file": path})

    # EKS cluster access config (from cloud-evidence)
    for key, data in _get_cloud_evidence("aws", "eks", "cluster-"):
        cluster = key.split("/")[-1].replace("cluster-", "").replace(".json", "")
        if cluster == "list":
            continue
        path = _save_evidence(output_dir, 28, f"eks-access-config-{cluster}.json", data,
                              source=f"gcs://cloud-evidence/{key}",
                              command="from cloud-evidence CronJob")
        evidence["artifacts"].append({"type": "eks_access_config", "cluster": cluster, "file": path})

    return evidence


def collect_ctrl_29_30_source_control(output_dir: Path) -> dict:
    """Controls 29-30: Source control and build tool access."""
    evidence = {"control": "29-30", "description": "Source control access", "artifacts": []}

    for repo in GITHUB_REPOS:
        repo_full = f"{GITHUB_ORG}/{repo}"
        try:
            collabs = _github_get_paginated(f"/repos/{repo_full}/collaborators")
            collab_perms = [
                {"login": c["login"], "permissions": c.get("permissions", {}), "role_name": c.get("role_name", "")}
                for c in collabs
            ]
            path = _save_evidence(output_dir, 29, f"github-collaborators-{repo}.json", collab_perms,
                                  source=f"github/{repo_full}/collaborators",
                                  command=f"GET /repos/{repo_full}/collaborators")
            evidence["artifacts"].append({"type": "repo_collaborators", "repo": repo, "file": path})
        except Exception as e:
            evidence["artifacts"].append({"type": "repo_collaborators", "repo": repo, "error": str(e)})

        try:
            teams = _github_get_paginated(f"/repos/{repo_full}/teams")
            path = _save_evidence(output_dir, 29, f"github-teams-{repo}.json", teams,
                                  source=f"github/{repo_full}/teams",
                                  command=f"GET /repos/{repo_full}/teams")
            evidence["artifacts"].append({"type": "repo_teams", "repo": repo, "file": path})
        except Exception as e:
            evidence["artifacts"].append({"type": "repo_teams", "repo": repo, "error": str(e)})

    return evidence


def collect_ctrl_33_sso(output_dir: Path) -> dict:
    """Control 33: SSO and password configuration."""
    evidence = {"control": 33, "description": "SSO and password settings", "artifacts": []}

    try:
        org_settings = _github_get(f"/orgs/{GITHUB_ORG}")
        sso_info = {
            "two_factor_requirement_enabled": org_settings.get("two_factor_requirement_enabled"),
            "default_repository_permission": org_settings.get("default_repository_permission"),
            "members_can_create_repositories": org_settings.get("members_can_create_repositories"),
        }
        path = _save_evidence(output_dir, 33, "github-org-security-settings.json", sso_info,
                              source=f"github/orgs/{GITHUB_ORG}",
                              command=f"GET /orgs/{GITHUB_ORG}")
        evidence["artifacts"].append({"type": "github_org_settings", "file": path})
    except Exception as e:
        evidence["artifacts"].append({"type": "github_org_settings", "error": str(e)})

    # AWS password policy (from cloud-evidence GCS)
    for key, data in _get_cloud_evidence("aws", "iam", "password-policy"):
        path = _save_evidence(output_dir, 33, "aws-password-policy.json", data,
                              source=f"gcs://cloud-evidence/{key}",
                              command="from cloud-evidence CronJob")
        evidence["artifacts"].append({"type": "aws_password_policy", "file": path})

    return evidence


def collect_ctrl_34_prod_segregation(output_dir: Path) -> dict:
    """Control 34: Production access limited and segregated."""
    evidence = {"control": 34, "description": "Production access segregation", "artifacts": []}

    # GCP projects list (from cloud-evidence)
    for key, data in _get_cloud_evidence("gcp", "org", "projects-list"):
        path = _save_evidence(output_dir, 34, "gcp-projects.json", data,
                              source=f"gcs://cloud-evidence/{key}",
                              command="from cloud-evidence CronJob")
        evidence["artifacts"].append({"type": "gcp_project_segregation", "file": path})

    # AWS EKS access entries (from cloud-evidence)
    for key, data in _get_cloud_evidence("aws", "eks", "access-entries"):
        cluster = key.split("/")[-1].replace("access-entries-", "").replace(".json", "")
        path = _save_evidence(output_dir, 34, f"eks-access-entries-{cluster}.json", data,
                              source=f"gcs://cloud-evidence/{key}",
                              command="from cloud-evidence CronJob")
        evidence["artifacts"].append({"type": "eks_access_entries", "cluster": cluster, "file": path})

    # GKE RBAC config from git (ArgoCD manifests)
    rbac_files = _read_repo_files("argocd/kustomize/**/rbac*.yaml")
    rbac_files += _read_repo_files("argocd/kustomize/**/clusterrole*.yaml")
    if rbac_files:
        path = _save_evidence(output_dir, 34, "k8s-rbac-config-repo.json", rbac_files,
                              source="git/argocd/kustomize (RBAC files)",
                              command="read rbac/clusterrole yamls from repo")
        evidence["artifacts"].append({"type": "k8s_rbac_config", "file": path})

    return evidence


def collect_ctrl_37_tls(output_dir: Path) -> dict:
    """Control 37: TLS/encrypted connections to production."""
    evidence = {"control": 37, "description": "TLS configuration", "artifacts": []}

    # TLS/cert config from git (cert-manager configs, ingress)
    cert_files = _read_repo_files("argocd/kustomize/**/certificate*.yaml")
    cert_files += _read_repo_files("argocd/kustomize/**/issuer*.yaml")
    cert_files += _read_repo_files("certs/**/*.yaml")
    if cert_files:
        path = _save_evidence(output_dir, 37, "tls-config-repo.json", cert_files,
                              source="git/argocd+certs (TLS configs)",
                              command="read certificate/issuer/certs yamls from repo")
        evidence["artifacts"].append({"type": "tls_config_gitops", "file": path})

    # GKE cluster TLS/HTTPS config (from cloud-evidence)
    for key, data in _get_cloud_evidence("gcp", "gke", "clusters"):
        project = key.split("/")[-1].replace("clusters-", "").replace(".json", "")
        path = _save_evidence(output_dir, 37, f"gke-tls-config-{project}.json", data,
                              source=f"gcs://cloud-evidence/{key}",
                              command="from cloud-evidence CronJob")
        evidence["artifacts"].append({"type": "gke_tls_config", "file": path})

    # EKS cluster config (from cloud-evidence — includes endpoint/TLS info)
    for key, data in _get_cloud_evidence("aws", "eks", "cluster-"):
        cluster = key.split("/")[-1].replace("cluster-", "").replace(".json", "")
        if cluster == "list":
            continue
        path = _save_evidence(output_dir, 37, f"eks-tls-config-{cluster}.json", data,
                              source=f"gcs://cloud-evidence/{key}",
                              command="from cloud-evidence CronJob")
        evidence["artifacts"].append({"type": "eks_tls_config", "cluster": cluster, "file": path})

    return evidence


def collect_ctrl_40_endpoint_protection(output_dir: Path) -> dict:
    """Control 40: Endpoint protection — config from git + Wazuh API."""
    evidence = {"control": 40, "description": "Endpoint protection (Wazuh + Falco)", "artifacts": []}

    # Wazuh agent config from git (source of truth)
    wazuh_files = _read_repo_files("argocd/kustomize/wazuh-agent/**/*.yaml")
    if wazuh_files:
        path = _save_evidence(output_dir, 40, "wazuh-agent-config-repo.json", wazuh_files,
                              source="git/argocd/kustomize/wazuh-agent/",
                              command="read wazuh-agent kustomize from repo")
        evidence["artifacts"].append({"type": "wazuh_agent_config", "file": path})

    # Falco config from git
    falco_files = _read_repo_files("argocd/kustomize/falco/**/*.yaml")
    if falco_files:
        path = _save_evidence(output_dir, 40, "falco-config-repo.json", falco_files,
                              source="git/argocd/kustomize/falco/",
                              command="read falco kustomize from repo")
        evidence["artifacts"].append({"type": "falco_config", "file": path})

    # Wazuh custom rules from git
    rules_files = _read_repo_files("argocd/kustomize/wazuh-rules/**/*.yaml")
    if rules_files:
        path = _save_evidence(output_dir, 40, "wazuh-rules-config-repo.json", rules_files,
                              source="git/argocd/kustomize/wazuh-rules/",
                              command="read wazuh-rules kustomize from repo")
        evidence["artifacts"].append({"type": "wazuh_rules", "file": path})

    # Wazuh API: active agent count + group list (if accessible)
    if WAZUH_API_URL and WAZUH_API_PASS:
        try:
            summary = _wazuh_api_get("/agents/summary/status")
            path = _save_evidence(output_dir, 40, "wazuh-agent-summary.json", summary,
                                  source=f"wazuh-api/{WAZUH_API_URL}",
                                  command="GET /agents/summary/status")
            evidence["artifacts"].append({"type": "wazuh_agent_status", "file": path})
        except Exception as e:
            evidence["artifacts"].append({"type": "wazuh_agent_status", "error": str(e)})

    return evidence


def collect_ctrl_41_vuln_scans(output_dir: Path) -> dict:
    """Control 41: Vulnerability scanning results from GCS."""
    evidence = {"control": 41, "description": "Vulnerability scanning", "artifacts": []}

    ctrl41_dir = output_dir / "ctrl-41"
    ctrl41_dir.mkdir(parents=True, exist_ok=True)

    for scanner in ["grype", "prowler", "kube-bench", "kubescape", "trufflehog"]:
        try:
            result = _gcs_download_latest(EVIDENCE_BUCKET, scanner, ctrl41_dir)
            evidence["artifacts"].append({
                "type": f"{scanner}_results",
                "source": result["source"],
                "date": result["date"],
                "files_downloaded": result["files_downloaded"],
            })
        except Exception as e:
            evidence["artifacts"].append({"type": f"{scanner}_results", "error": str(e)})

    # Scanner job configs from git (shows scheduling + scope)
    scanner_configs = _read_repo_files("argocd/kustomize/grype/**/*.yaml")
    scanner_configs += _read_repo_files("argocd/kustomize/prowler/**/*.yaml")
    scanner_configs += _read_repo_files("argocd/kustomize/kube-bench/**/*.yaml")
    scanner_configs += _read_repo_files("argocd/kustomize/kubescape/**/*.yaml")
    scanner_configs += _read_repo_files("argocd/kustomize/trufflehog/**/*.yaml")
    if scanner_configs:
        path = _save_evidence(output_dir, 41, "scanner-configs-repo.json", scanner_configs,
                              source="git/argocd/kustomize (scanner configs)",
                              command="read scanner kustomize configs from repo")
        evidence["artifacts"].append({"type": "scanner_configs", "file": path})

    return evidence


def collect_ctrl_44_45_code_review(output_dir: Path) -> dict:
    """Controls 44-45: Code review and test requirements."""
    evidence = {"control": "44-45", "description": "Code review and testing requirements", "artifacts": []}

    for repo in GITHUB_REPOS:
        repo_full = f"{GITHUB_ORG}/{repo}"

        try:
            protection = _github_get(f"/repos/{repo_full}/branches/main/protection")
            path = _save_evidence(output_dir, 44, f"branch-protection-{repo}.json", protection,
                                  source=f"github/{repo_full}/branches/main/protection",
                                  command=f"GET /repos/{repo_full}/branches/main/protection")
            evidence["artifacts"].append({"type": "branch_protection", "repo": repo, "file": path})
        except Exception as e:
            evidence["artifacts"].append({"type": "branch_protection", "repo": repo, "error": str(e)})

        # Recent merged PRs with review evidence
        try:
            prs = _github_get_paginated(
                f"/repos/{repo_full}/pulls",
                params={"state": "closed", "sort": "updated", "direction": "desc", "per_page": "10"},
            )
            pr_samples = []
            for pr in prs[:10]:
                if not pr.get("merged_at"):
                    continue
                try:
                    reviews = _github_get(f"/repos/{repo_full}/pulls/{pr['number']}/reviews")
                except Exception:
                    reviews = []
                pr_samples.append({
                    "number": pr["number"],
                    "title": pr["title"],
                    "merged_at": pr["merged_at"],
                    "user": pr["user"]["login"],
                    "reviews": [{"user": r["user"]["login"], "state": r["state"]} for r in reviews],
                })
            path = _save_evidence(output_dir, 44, f"merged-prs-with-reviews-{repo}.json", pr_samples,
                                  source=f"github/{repo_full}/pulls",
                                  command=f"GET /repos/{repo_full}/pulls (closed, with reviews)")
            evidence["artifacts"].append({"type": "pr_review_samples", "repo": repo, "file": path})
        except Exception as e:
            evidence["artifacts"].append({"type": "pr_review_samples", "repo": repo, "error": str(e)})

    # CI/CD workflows
    for repo in GITHUB_REPOS:
        repo_full = f"{GITHUB_ORG}/{repo}"
        try:
            workflows = _github_get(f"/repos/{repo_full}/actions/workflows")
            path = _save_evidence(output_dir, 45, f"ci-workflows-{repo}.json", workflows,
                                  source=f"github/{repo_full}/actions/workflows",
                                  command=f"GET /repos/{repo_full}/actions/workflows")
            evidence["artifacts"].append({"type": "ci_workflows", "repo": repo, "file": path})
        except Exception as e:
            evidence["artifacts"].append({"type": "ci_workflows", "repo": repo, "error": str(e)})

    return evidence


def collect_ctrl_46_47_deploy_access(output_dir: Path) -> dict:
    """Controls 46-47: Admin source control access and deploy permissions."""
    evidence = {"control": "46-47", "description": "Deploy and admin access", "artifacts": []}

    try:
        admins = _github_get_paginated(f"/orgs/{GITHUB_ORG}/members", params={"role": "admin"})
        admin_list = [{"login": a["login"], "id": a["id"]} for a in admins]
        path = _save_evidence(output_dir, 46, "github-org-admins.json", admin_list,
                              source=f"github/orgs/{GITHUB_ORG}/members?role=admin",
                              command=f"GET /orgs/{GITHUB_ORG}/members?role=admin")
        evidence["artifacts"].append({"type": "github_admins", "file": path})
    except Exception as e:
        evidence["artifacts"].append({"type": "github_admins", "error": str(e)})

    for repo in GITHUB_REPOS:
        repo_full = f"{GITHUB_ORG}/{repo}"
        try:
            environments = _github_get(f"/repos/{repo_full}/environments")
            path = _save_evidence(output_dir, 47, f"deploy-environments-{repo}.json", environments,
                                  source=f"github/{repo_full}/environments",
                                  command=f"GET /repos/{repo_full}/environments")
            evidence["artifacts"].append({"type": "deploy_environments", "repo": repo, "file": path})
        except Exception as e:
            evidence["artifacts"].append({"type": "deploy_environments", "repo": repo, "error": str(e)})

    # ArgoCD app definitions from git (shows deployment config)
    argocd_apps = _read_repo_files("argocd/apps/**/*.yaml")
    if argocd_apps:
        path = _save_evidence(output_dir, 47, "argocd-app-definitions.json", argocd_apps,
                              source="git/argocd/apps/",
                              command="read argocd/apps/**/*.yaml from repo")
        evidence["artifacts"].append({"type": "argocd_apps", "file": path})

    return evidence


def collect_ctrl_48_backups(output_dir: Path) -> dict:
    """Control 48: Backup configuration."""
    evidence = {"control": 48, "description": "Backup configuration", "artifacts": []}

    # GCP backup/resource policies (from cloud-evidence)
    for key, data in _get_cloud_evidence("gcp", "backups", "resource-policies"):
        project = key.split("/")[-1].replace("resource-policies-", "").replace(".json", "")
        path = _save_evidence(output_dir, 48, f"gcp-backup-policies-{project}.json", data,
                              source=f"gcs://cloud-evidence/{key}",
                              command="from cloud-evidence CronJob")
        evidence["artifacts"].append({"type": "gcp_backup_policies", "file": path})

    # Backup CronJob config from git
    backup_configs = _read_repo_files("tofu/runtime/**/backup*.tf")
    backup_configs += _read_repo_files("argocd/kustomize/**/backup*.yaml")
    if backup_configs:
        path = _save_evidence(output_dir, 48, "backup-configs-repo.json", backup_configs,
                              source="git/tofu+argocd (backup configs)",
                              command="read backup-related tf/yaml from repo")
        evidence["artifacts"].append({"type": "backup_configs", "file": path})

    return evidence


def collect_ctrl_49_availability(output_dir: Path) -> dict:
    """Control 49: Multi-AZ availability configuration."""
    evidence = {"control": 49, "description": "Availability zone configuration", "artifacts": []}

    # GKE cluster zone configuration (from cloud-evidence)
    for key, data in _get_cloud_evidence("gcp", "gke", "clusters"):
        project = key.split("/")[-1].replace("clusters-", "").replace(".json", "")
        path = _save_evidence(output_dir, 49, f"gke-cluster-zones-{project}.json", data,
                              source=f"gcs://cloud-evidence/{key}",
                              command="from cloud-evidence CronJob")
        evidence["artifacts"].append({"type": "gke_zones", "file": path})

    # EKS cluster networking (from cloud-evidence — full describe includes VPC/subnets)
    for key, data in _get_cloud_evidence("aws", "eks", "cluster-"):
        cluster = key.split("/")[-1].replace("cluster-", "").replace(".json", "")
        if cluster == "list":
            continue
        path = _save_evidence(output_dir, 49, f"eks-networking-{cluster}.json", data,
                              source=f"gcs://cloud-evidence/{key}",
                              command="from cloud-evidence CronJob")
        evidence["artifacts"].append({"type": "eks_networking", "cluster": cluster, "file": path})

    return evidence


def collect_ctrl_52_encryption(output_dir: Path) -> dict:
    """Control 52: Data encryption at rest."""
    evidence = {"control": 52, "description": "Encryption at rest", "artifacts": []}

    # GCP disk encryption (from cloud-evidence)
    for key, data in _get_cloud_evidence("gcp", "encryption", "disk-encryption"):
        project = key.split("/")[-1].replace("disk-encryption-", "").replace(".json", "")
        path = _save_evidence(output_dir, 52, f"gcp-disk-encryption-{project}.json", data,
                              source=f"gcs://cloud-evidence/{key}",
                              command="from cloud-evidence CronJob")
        evidence["artifacts"].append({"type": "gcp_disk_encryption", "file": path})

    # GCS bucket encryption (from cloud-evidence)
    for key, data in _get_cloud_evidence("gcp", "encryption", "gcs-bucket"):
        project = key.split("/")[-1].replace("gcs-bucket-encryption-", "").replace(".json", "")
        path = _save_evidence(output_dir, 52, f"gcs-bucket-encryption-{project}.json", data,
                              source=f"gcs://cloud-evidence/{key}",
                              command="from cloud-evidence CronJob")
        evidence["artifacts"].append({"type": "gcs_encryption", "file": path})

    # EKS encryption (from cloud-evidence — full describe includes encryptionConfig)
    for key, data in _get_cloud_evidence("aws", "eks", "cluster-"):
        cluster = key.split("/")[-1].replace("cluster-", "").replace(".json", "")
        if cluster == "list":
            continue
        path = _save_evidence(output_dir, 52, f"eks-encryption-{cluster}.json", data,
                              source=f"gcs://cloud-evidence/{key}",
                              command="from cloud-evidence CronJob")
        evidence["artifacts"].append({"type": "eks_encryption", "cluster": cluster, "file": path})

    return evidence


def collect_ctrl_56_firewall(output_dir: Path) -> dict:
    """Control 56: Firewall configuration."""
    evidence = {"control": 56, "description": "Firewall rules", "artifacts": []}

    # GCP firewall rules (from cloud-evidence)
    for key, data in _get_cloud_evidence("gcp", "firewall", "firewall-rules"):
        project = key.split("/")[-1].replace("firewall-rules-", "").replace(".json", "")
        path = _save_evidence(output_dir, 56, f"gcp-firewall-{project}.json", data,
                              source=f"gcs://cloud-evidence/{key}",
                              command="from cloud-evidence CronJob")
        evidence["artifacts"].append({"type": "gcp_firewall", "file": path})

    # AWS security groups (from cloud-evidence)
    for key, data in _get_cloud_evidence("aws", "firewall", "security-groups"):
        path = _save_evidence(output_dir, 56, "aws-security-groups.json", data,
                              source=f"gcs://cloud-evidence/{key}",
                              command="from cloud-evidence CronJob")
        evidence["artifacts"].append({"type": "aws_security_groups", "file": path})

    # Network policies from git (K8s NetworkPolicy definitions)
    netpol_files = _read_repo_files("argocd/kustomize/**/network-polic*.yaml")
    netpol_files += _read_repo_files("tofu/runtime/**/security_group*.tf")
    netpol_files += _read_repo_files("tofu/runtime/**/firewall*.tf")
    if netpol_files:
        path = _save_evidence(output_dir, 56, "network-policies-repo.json", netpol_files,
                              source="git/argocd+tofu (network/firewall configs)",
                              command="read network-policy and firewall files from repo")
        evidence["artifacts"].append({"type": "k8s_network_policies", "file": path})

    return evidence


def collect_ctrl_57_asset_inventory(output_dir: Path) -> dict:
    """Control 57: Cloud asset inventory."""
    evidence = {"control": 57, "description": "Cloud asset inventory", "artifacts": []}

    # GKE clusters (from cloud-evidence — includes nodePools)
    for key, data in _get_cloud_evidence("gcp", "gke", "clusters"):
        project = key.split("/")[-1].replace("clusters-", "").replace(".json", "")
        path = _save_evidence(output_dir, 57, f"gke-clusters-{project}.json", data,
                              source=f"gcs://cloud-evidence/{key}",
                              command="from cloud-evidence CronJob")
        evidence["artifacts"].append({"type": "gke_clusters", "file": path})

    # AWS EKS nodegroups (from cloud-evidence)
    for key, data in _get_cloud_evidence("aws", "eks", "nodegroups"):
        cluster = key.split("/")[-1].replace("nodegroups-", "").replace(".json", "")
        path = _save_evidence(output_dir, 57, f"eks-nodegroups-{cluster}.json", data,
                              source=f"gcs://cloud-evidence/{key}",
                              command="from cloud-evidence CronJob")
        evidence["artifacts"].append({"type": "eks_nodegroups", "cluster": cluster, "file": path})

    return evidence


def collect_ctrl_58_patch_mgmt(output_dir: Path) -> dict:
    """Control 58: Patch management — from GCS grype scans (image inventory)."""
    evidence = {"control": 58, "description": "Patch management", "artifacts": []}

    # Grype scan results contain full image inventories
    try:
        from google.cloud import storage

        client = storage.Client()
        bucket = client.bucket(EVIDENCE_BUCKET)
        today = datetime.now(timezone.utc)

        for days_ago in range(3):
            dt = today - timedelta(days=days_ago)
            prefix = f"grype/{dt.strftime('%Y/%m/%d')}"
            blobs = list(bucket.list_blobs(prefix=prefix))
            summary_blobs = [b for b in blobs if "summary" in b.name.lower() or b.name.endswith(".json")]
            if summary_blobs:
                ctrl58_dir = output_dir / "ctrl-58"
                ctrl58_dir.mkdir(parents=True, exist_ok=True)
                downloaded = 0
                for blob in summary_blobs[:20]:
                    if blob.name.endswith("/"):
                        continue
                    rel = blob.name.split("/")[-1]
                    local = ctrl58_dir / rel
                    blob.download_to_filename(str(local))
                    downloaded += 1
                evidence["artifacts"].append({
                    "type": "grype_image_inventory",
                    "source": f"gs://{EVIDENCE_BUCKET}/{prefix}",
                    "date": dt.strftime("%Y-%m-%d"),
                    "files_downloaded": downloaded,
                })
                break
        else:
            evidence["artifacts"].append({
                "type": "grype_image_inventory",
                "note": "No recent grype scans found in GCS (checked last 3 days)"
            })
    except Exception as e:
        evidence["artifacts"].append({"type": "grype_image_inventory", "error": str(e)})

    # GKE node versions (from cloud-evidence — clusters include nodePool versions)
    for key, data in _get_cloud_evidence("gcp", "gke", "clusters"):
        project = key.split("/")[-1].replace("clusters-", "").replace(".json", "")
        path = _save_evidence(output_dir, 58, f"gke-node-versions-{project}.json", data,
                              source=f"gcs://cloud-evidence/{key}",
                              command="from cloud-evidence CronJob")
        evidence["artifacts"].append({"type": "gke_node_versions", "file": path})

    # EKS nodegroup versions (from cloud-evidence)
    for key, data in _get_cloud_evidence("aws", "eks", "nodegroups"):
        cluster = key.split("/")[-1].replace("nodegroups-", "").replace(".json", "")
        path = _save_evidence(output_dir, 58, f"eks-node-versions-{cluster}.json", data,
                              source=f"gcs://cloud-evidence/{key}",
                              command="from cloud-evidence CronJob")
        evidence["artifacts"].append({"type": "eks_node_versions", "cluster": cluster, "file": path})

    return evidence


# ---------------------------------------------------------------------------
# Upload to GCS
# ---------------------------------------------------------------------------
def upload_evidence_to_gcs(output_dir: Path, bucket_name: str) -> str:
    """Upload the entire evidence directory to GCS. Returns the GCS prefix."""
    from google.cloud import storage

    client = storage.Client()
    bucket = client.bucket(bucket_name)
    now = datetime.now(timezone.utc)
    prefix = f"soc2-evidence/{now.strftime('%Y/%m/%d')}"

    uploaded = 0
    for filepath in output_dir.rglob("*"):
        if filepath.is_file():
            rel_path = filepath.relative_to(output_dir)
            blob_name = f"{prefix}/{rel_path}"
            blob = bucket.blob(blob_name)
            blob.upload_from_filename(str(filepath))
            uploaded += 1

    print(f"\nUploaded {uploaded} files to gs://{bucket_name}/{prefix}/")
    return f"gs://{bucket_name}/{prefix}"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="Collect SOC 2 evidence and upload to GCS.")
    parser.add_argument("--environment", default="dev", help="Environment name (dev/staging/prod)")
    parser.add_argument("--controls", default=None,
                        help="Comma-separated list of control numbers to collect (default: all)")
    parser.add_argument("--output-dir", default=None, help="Local output directory (default: tmp)")
    parser.add_argument("--skip-upload", action="store_true", help="Skip GCS upload")
    parser.add_argument("--bucket", default=EVIDENCE_BUCKET, help="GCS bucket name")

    args = parser.parse_args()

    # Determine which controls to collect
    if args.controls:
        controls = [int(c.strip()) for c in args.controls.split(",")]
    else:
        controls = AUTOMATABLE_CONTROLS

    # Output directory
    now = datetime.now(timezone.utc)
    output_dir = Path(args.output_dir) if args.output_dir else Path(f"/tmp/soc2-evidence-{now.strftime('%Y%m%d-%H%M%S')}")
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"SOC 2 Evidence Collection — {args.environment}")
    print(f"Date: {now.strftime('%Y-%m-%d %H:%M:%S UTC')}")
    print(f"Controls: {controls}")
    print(f"Output: {output_dir}")
    print("=" * 60)

    # Map control numbers to collector functions
    collectors = {
        12: ("Releases/Release Notes", collect_ctrl_12_releases),
        21: ("Monitoring Tools", collect_ctrl_21_monitoring),
        22: ("Uptime Monitoring", collect_ctrl_22_uptime),
        24: ("Log Review", collect_ctrl_24_log_review),
        25: ("Cloud Access (IAM)", collect_ctrl_25_26_cloud_access),
        26: ("New System Access", collect_ctrl_25_26_cloud_access),
        27: ("Admin Access", collect_ctrl_27_admin_access),
        28: ("Database Access", collect_ctrl_28_db_access),
        29: ("Source Control Access", collect_ctrl_29_30_source_control),
        30: ("Build Tool Access", collect_ctrl_29_30_source_control),
        33: ("SSO/Password Config", collect_ctrl_33_sso),
        34: ("Production Segregation", collect_ctrl_34_prod_segregation),
        37: ("TLS Configuration", collect_ctrl_37_tls),
        40: ("Endpoint Protection", collect_ctrl_40_endpoint_protection),
        41: ("Vulnerability Scanning", collect_ctrl_41_vuln_scans),
        44: ("Code Review", collect_ctrl_44_45_code_review),
        45: ("Test Requirements", collect_ctrl_44_45_code_review),
        46: ("Source Control Admin", collect_ctrl_46_47_deploy_access),
        47: ("Deploy Permissions", collect_ctrl_46_47_deploy_access),
        48: ("Backup Configuration", collect_ctrl_48_backups),
        49: ("Availability Zones", collect_ctrl_49_availability),
        52: ("Encryption at Rest", collect_ctrl_52_encryption),
        56: ("Firewall Rules", collect_ctrl_56_firewall),
        57: ("Asset Inventory", collect_ctrl_57_asset_inventory),
        58: ("Patch Management", collect_ctrl_58_patch_mgmt),
    }

    # Deduplicate (controls 25/26 share a collector, 29/30 share, 44/45 share)
    executed = set()
    manifest = {
        "collection_date": _now_iso(),
        "environment": args.environment,
        "collector": _collector_identity(),
        "controls_requested": controls,
        "evidence": [],
        "errors": [],
        "file_hashes": {},
    }

    for ctrl in controls:
        if ctrl not in collectors:
            print(f"\n[SKIP] Control {ctrl} — no automated collector available")
            manifest["errors"].append({"control": ctrl, "error": "no_automated_collector"})
            continue

        label, func = collectors[ctrl]
        func_id = id(func)
        if func_id in executed:
            continue
        executed.add(func_id)

        print(f"\n[{ctrl:02d}] Collecting: {label}...")
        try:
            result = func(output_dir)
            manifest["evidence"].append(result)
            artifact_count = len(result.get("artifacts", []))
            errors = sum(1 for a in result.get("artifacts", []) if "error" in a)
            print(f"     ✓ {artifact_count} artifacts ({errors} errors)")
        except Exception as e:
            print(f"     ✗ FAILED: {e}")
            manifest["errors"].append({"control": ctrl, "label": label, "error": str(e)})

    # Compute SHA256 hashes for all evidence files (integrity trail)
    print("\nComputing file integrity hashes...")
    for filepath in sorted(output_dir.rglob("*")):
        if filepath.is_file() and filepath.name != "manifest.json":
            rel = str(filepath.relative_to(output_dir))
            manifest["file_hashes"][rel] = _sha256(filepath)

    # Write manifest
    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, default=str))
    print(f"\n{'=' * 60}")
    print(f"Manifest: {manifest_path}")
    print(f"Files hashed: {len(manifest['file_hashes'])}")

    # Upload to GCS
    if not args.skip_upload:
        print(f"\nUploading to gs://{args.bucket}/...")
        try:
            gcs_path = upload_evidence_to_gcs(output_dir, args.bucket)
            manifest["gcs_location"] = gcs_path
            manifest_path.write_text(json.dumps(manifest, indent=2, default=str))
            print(f"Evidence available at: {gcs_path}")
        except Exception as e:
            print(f"ERROR: Upload failed: {e}")
            sys.exit(1)
    else:
        print("\nSkipped GCS upload (--skip-upload)")

    print(f"\nDone. {len(manifest['evidence'])} control groups collected, {len(manifest['errors'])} errors.")


if __name__ == "__main__":
    main()
