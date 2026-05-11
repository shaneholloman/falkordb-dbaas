#!/usr/bin/env python3
"""
Read-only tools for the AI Security Triage agent.

Mirrors the structure of `triage_tools.py` (Pydantic-typed Copilot tools).
All tools are STRICTLY read-only — they never call mutating Wazuh/VM/Kubernetes
endpoints and never use `git push` / write files. Any remediation produced by
the agent is rendered as a Markdown report posted to a GitHub issue, and a
human operator is the only one who can act on it.

Tools:
    fetch_active_alerts       — VictoriaMetrics /api/v1/alerts (firing only)
    fetch_wazuh_alerts        — Wazuh API /alerts with filters
    fetch_grype_findings      — recent Grype CVE alerts grouped by image+CVE
    fetch_compliance_failures — recent Prowler/KubeBench/KubeScape FAILs
    search_repo_code          — grep this repo (read-only)
    read_repo_file            — read a file from this repo
    lookup_cve                — NVD/OSV CVE metadata
    list_open_security_issues — GitHub issues labelled `security`/`soc2`
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from typing import Optional

import requests
from pydantic import BaseModel, Field

# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))


def _vm_get(path: str, params: Optional[dict] = None) -> dict:
    base = os.environ.get("VMAUTH_URL", "").rstrip("/")
    user = os.environ.get("VMAUTH_USERNAME", "")
    pwd = os.environ.get("VMAUTH_PASSWORD", "")
    if not base:
        raise RuntimeError("VMAUTH_URL not set")
    resp = requests.get(
        f"{base}{path}",
        params=params,
        auth=(user, pwd) if user else None,
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def _wazuh_get(path: str, params: Optional[dict] = None) -> dict:
    """Query the Wazuh Manager API. Read-only paths only."""
    base = os.environ.get("WAZUH_API_URL", "").rstrip("/")
    user = os.environ.get("WAZUH_API_USERNAME", "")
    pwd = os.environ.get("WAZUH_API_PASSWORD", "")
    if not base:
        raise RuntimeError("WAZUH_API_URL not set")
    # Whitelist read-only paths so the LLM cannot escape via path traversal.
    allowed_prefixes = ("/security/", "/agents", "/manager", "/cluster", "/lists",
                        "/rules", "/decoders", "/syscollector", "/vulnerability")
    if not any(path.startswith(p) for p in allowed_prefixes):
        raise PermissionError(f"Wazuh path '{path}' not in read-only allowlist")
    # Auth: basic auth → JWT
    auth_resp = requests.post(
        f"{base}/security/user/authenticate",
        auth=(user, pwd),
        timeout=15,
        verify=False,
    )
    auth_resp.raise_for_status()
    token = auth_resp.json()["data"]["token"]
    resp = requests.get(
        f"{base}{path}",
        params=params,
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
        verify=False,
    )
    resp.raise_for_status()
    return resp.json()


def _github_search(query: str, repo: str, kind: str = "issues") -> dict:
    token = os.environ.get("PRIVATE_REPO_TOKEN") or os.environ.get("GITHUB_TOKEN", "")
    headers = {"Accept": "application/vnd.github.v3+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    resp = requests.get(
        f"https://api.github.com/search/{kind}",
        params={"q": f"{query} repo:{repo}"},
        headers=headers,
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


# --------------------------------------------------------------------------- #
# Tool: fetch_active_alerts
# --------------------------------------------------------------------------- #

class FetchActiveAlertsParams(BaseModel):
    team: str = Field(
        default="security",
        description="Alertmanager 'team' label to filter on. Default: security",
    )
    severity: Optional[str] = Field(
        default=None,
        description="Filter to one severity (warning|critical). Optional.",
    )


async def fetch_active_alerts(params: FetchActiveAlertsParams) -> str:
    """Return currently firing alerts from VictoriaMetrics matching team/severity.

    Use this to see what's broken RIGHT NOW. Gives a snapshot of operational
    health (Prowler/Grype/etc. scan failures, Wazuh down, etc.) — does NOT
    surface individual security findings (use fetch_wazuh_alerts for those).
    """
    data = _vm_get("/api/v1/alerts")
    alerts = data.get("data", {}).get("alerts", [])
    out = []
    for a in alerts:
        if a.get("state") != "firing":
            continue
        labels = a.get("labels", {})
        if labels.get("team") != params.team:
            continue
        if params.severity and labels.get("severity") != params.severity:
            continue
        out.append({
            "alertname": labels.get("alertname"),
            "severity": labels.get("severity"),
            "labels": {k: v for k, v in labels.items()
                       if k not in ("alertname", "team")},
            "summary": a.get("annotations", {}).get("summary"),
            "description": a.get("annotations", {}).get("description"),
            "activeAt": a.get("activeAt"),
        })
    return json.dumps({"count": len(out), "alerts": out}, indent=2)


# --------------------------------------------------------------------------- #
# Tool: fetch_wazuh_alerts
# --------------------------------------------------------------------------- #

class FetchWazuhAlertsParams(BaseModel):
    rule_groups: Optional[str] = Field(
        default=None,
        description="Comma-separated rule.groups filter (e.g. 'grype_vuln,soc2_critical').",
    )
    min_level: int = Field(
        default=10,
        description="Minimum rule.level to return. Default 10 (Google Chat threshold).",
    )
    days: int = Field(
        default=7,
        description="Look back this many days. Default 7.",
    )
    limit: int = Field(default=200, description="Max alerts to return. Default 200.")


async def fetch_wazuh_alerts(params: FetchWazuhAlertsParams) -> str:
    """Return Wazuh alerts matching filters.

    Use AFTER fetch_active_alerts to drill into specific finding categories.
    Returns aggregated counts plus a sample of representative alerts.
    """
    q = {"limit": params.limit, "level_above": params.min_level - 1}
    if params.rule_groups:
        q["rule_groups"] = params.rule_groups
    data = _wazuh_get("/manager/logs/summary", params=q)
    return json.dumps(data, indent=2)[:30000]


# --------------------------------------------------------------------------- #
# Tool: fetch_grype_findings
# --------------------------------------------------------------------------- #

class FetchGrypeFindingsParams(BaseModel):
    severity: str = Field(
        default="critical,high",
        description="Comma-separated severity filter. Default critical,high.",
    )
    days: int = Field(default=7, description="Look back this many days.")


async def fetch_grype_findings(params: FetchGrypeFindingsParams) -> str:
    """Aggregated Grype CVE findings: top affected images + top CVEs per cluster.

    Reads from VM (alerts metric) when possible; falls back to Wazuh API.
    Output is grouped (NOT raw per-finding) so it's actionable for triage.
    """
    # Use a Wazuh search query for grype_vuln group
    severities = [s.strip().lower() for s in params.severity.split(",")]
    sev_filter = " OR ".join(f'data.Severity="{s}"' for s in severities)
    try:
        data = _wazuh_get("/manager/logs", params={
            "search": f"rule.groups=grype_vuln AND ({sev_filter})",
            "limit": 500,
        })
    except Exception as e:
        return json.dumps({"error": str(e), "hint": "Wazuh API unreachable"})
    # Aggregate
    by_image: dict[str, dict] = {}
    by_cluster: dict[str, dict] = {}
    for entry in data.get("data", {}).get("affected_items", []):
        image = entry.get("data", {}).get("ImageName", "unknown")
        cluster = entry.get("data", {}).get("Cluster", "unknown")
        cve = entry.get("data", {}).get("VulnerabilityID", "")
        sev = entry.get("data", {}).get("Severity", "")
        by_image.setdefault(image, {"cves": set(), "severities": set()})
        by_image[image]["cves"].add(cve)
        by_image[image]["severities"].add(sev)
        by_cluster.setdefault(cluster, {"cves": set(), "images": set()})
        by_cluster[cluster]["cves"].add(cve)
        by_cluster[cluster]["images"].add(image)
    # Convert sets → counts/lists
    top_images = sorted(
        ({"image": k, "cve_count": len(v["cves"]),
          "severities": sorted(v["severities"]),
          "sample_cves": sorted(v["cves"])[:10]}
         for k, v in by_image.items()),
        key=lambda x: x["cve_count"], reverse=True,
    )[:20]
    by_cluster_out = {
        k: {"cve_count": len(v["cves"]),
            "image_count": len(v["images"]),
            "sample_images": sorted(v["images"])[:5]}
        for k, v in by_cluster.items()
    }
    return json.dumps({
        "top_affected_images": top_images,
        "by_cluster": by_cluster_out,
    }, indent=2)


# --------------------------------------------------------------------------- #
# Tool: fetch_compliance_failures
# --------------------------------------------------------------------------- #

class FetchComplianceFailuresParams(BaseModel):
    framework: str = Field(
        default="all",
        description="prowler|kubebench|kubescape|all",
    )
    days: int = Field(default=7)


async def fetch_compliance_failures(params: FetchComplianceFailuresParams) -> str:
    """Aggregated Prowler / kube-bench / KubeScape FAIL findings."""
    group_map = {
        "prowler": "prowler_compliance,soc2_fail",
        "kubebench": "kubebench_cis,cis_fail",
        "kubescape": "kubescape_attack,soc2_fail",
    }
    if params.framework == "all":
        groups = ",".join(group_map.values())
    else:
        groups = group_map.get(params.framework, "")
    try:
        data = _wazuh_get("/manager/logs", params={
            "search": f"rule.groups=({groups})",
            "limit": 500,
        })
    except Exception as e:
        return json.dumps({"error": str(e)})
    # Aggregate by control + cluster
    by_control: dict[str, dict] = {}
    for entry in data.get("data", {}).get("affected_items", []):
        d = entry.get("data", {})
        ctrl = (d.get("ControlID") or d.get("CheckTitle")
                or d.get("TestNumber") or "unknown")
        cluster = d.get("Cluster", "unknown")
        sev = d.get("Severity", "")
        key = f"{ctrl} ({sev})"
        by_control.setdefault(key, {"clusters": set(), "count": 0,
                                     "description": d.get("ControlName")
                                                    or d.get("CheckTitle")
                                                    or d.get("TestDesc")})
        by_control[key]["clusters"].add(cluster)
        by_control[key]["count"] += 1
    out = sorted(
        ({"control": k, "count": v["count"],
          "clusters": sorted(v["clusters"]),
          "description": v["description"]}
         for k, v in by_control.items()),
        key=lambda x: x["count"], reverse=True,
    )[:30]
    return json.dumps({"top_controls": out}, indent=2)


# --------------------------------------------------------------------------- #
# Tool: search_repo_code
# --------------------------------------------------------------------------- #

class SearchRepoCodeParams(BaseModel):
    pattern: str = Field(description="Regex pattern to search for.")
    path_glob: Optional[str] = Field(
        default=None,
        description="Optional path glob to scope the search (e.g. argocd/**).",
    )


async def search_repo_code(params: SearchRepoCodeParams) -> str:
    """Grep this repo for a regex pattern. Read-only.

    Use to check whether a CVE'd package is actually used, or to find the
    declaration of an image tag that needs bumping.
    """
    cmd = ["git", "-C", REPO_ROOT, "grep", "-n", "-I", "-E", params.pattern]
    if params.path_glob:
        cmd.append("--")
        cmd.append(params.path_glob)
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=30, check=False,
        )
    except subprocess.TimeoutExpired:
        return json.dumps({"error": "search timed out"})
    out = (result.stdout or "")[:20000]
    return out or "(no matches)"


# --------------------------------------------------------------------------- #
# Tool: read_repo_file
# --------------------------------------------------------------------------- #

class ReadRepoFileParams(BaseModel):
    path: str = Field(description="Repo-relative file path.")
    start_line: int = Field(default=1, description="1-indexed start line.")
    end_line: int = Field(default=200, description="1-indexed end line (inclusive).")


async def read_repo_file(params: ReadRepoFileParams) -> str:
    """Read a slice of a file from this repo. Read-only."""
    # Prevent path traversal: resolve and ensure inside REPO_ROOT
    abs_path = os.path.realpath(os.path.join(REPO_ROOT, params.path))
    if not abs_path.startswith(REPO_ROOT + os.sep):
        return json.dumps({"error": "path outside repo"})
    if not os.path.isfile(abs_path):
        return json.dumps({"error": "not a file"})
    try:
        with open(abs_path, encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except OSError as e:
        return json.dumps({"error": str(e)})
    s = max(0, params.start_line - 1)
    e = min(len(lines), params.end_line)
    snippet = "".join(f"{i + 1:>5}: {ln}" for i, ln in enumerate(lines[s:e], start=s))
    return snippet[:30000]


# --------------------------------------------------------------------------- #
# Tool: lookup_cve
# --------------------------------------------------------------------------- #

class LookupCVEParams(BaseModel):
    cve_id: str = Field(description="CVE identifier (e.g. CVE-2024-12345).")


async def lookup_cve(params: LookupCVEParams) -> str:
    """Get authoritative CVE metadata from OSV. Returns severity + fixed versions."""
    if not re.match(r"^CVE-\d{4}-\d{4,}$", params.cve_id):
        return json.dumps({"error": "invalid CVE format"})
    try:
        resp = requests.post(
            "https://api.osv.dev/v1/query",
            json={"vulnerability_id": params.cve_id},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as e:
        return json.dumps({"error": str(e)})
    out = []
    for v in data.get("vulns", []):
        out.append({
            "id": v.get("id"),
            "summary": v.get("summary"),
            "severity": v.get("severity"),
            "affected": [{"package": a.get("package"),
                          "ranges": a.get("ranges"),
                          "fixed_in": [
                              ev.get("fixed")
                              for r in a.get("ranges", [])
                              for ev in r.get("events", [])
                              if ev.get("fixed")
                          ]}
                         for a in v.get("affected", [])][:5],
            "references": [r.get("url") for r in v.get("references", [])][:10],
        })
    return json.dumps({"cve_id": params.cve_id, "results": out}, indent=2)[:20000]


# --------------------------------------------------------------------------- #
# Tool: list_open_security_issues
# --------------------------------------------------------------------------- #

class ListOpenSecurityIssuesParams(BaseModel):
    repo: str = Field(
        default="FalkorDB/falkordb-dbaas",
        description="owner/repo to search. Default: this repo.",
    )


async def list_open_security_issues(params: ListOpenSecurityIssuesParams) -> str:
    """List open issues with the `security` or `soc2` label.

    Use to avoid filing duplicates of the same finding.
    """
    try:
        data = _github_search(
            'is:issue is:open (label:security OR label:soc2 OR label:ai-triage)',
            params.repo, kind="issues",
        )
    except requests.RequestException as e:
        return json.dumps({"error": str(e)})
    items = [{
        "number": i.get("number"),
        "title": i.get("title"),
        "labels": [lbl.get("name") for lbl in i.get("labels", [])],
        "url": i.get("html_url"),
        "updated_at": i.get("updated_at"),
    } for i in data.get("items", [])][:50]
    return json.dumps({"open_issues": items}, indent=2)


# --------------------------------------------------------------------------- #
# Registry — exported to the Copilot session
# --------------------------------------------------------------------------- #

ALL_TOOLS = [
    fetch_active_alerts,
    fetch_wazuh_alerts,
    fetch_grype_findings,
    fetch_compliance_failures,
    search_repo_code,
    read_repo_file,
    lookup_cve,
    list_open_security_issues,
]


def cleanup() -> None:
    """No-op cleanup for parity with triage_tools.py."""
