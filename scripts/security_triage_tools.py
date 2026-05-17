#!/usr/bin/env python3
"""
Read-only tools for the AI Security Triage agent.

Mirrors the structure of `triage_tools.py` (Pydantic-typed Copilot tools).
All tools are STRICTLY read-only — they never call mutating Wazuh/Kubernetes
endpoints and never use `git push` / write files. Any remediation produced by
the agent is rendered as a Markdown report posted to a GitHub issue, and a
human operator is the only one who can act on it.

Tools:
    fetch_wazuh_alerts        — Wazuh Indexer (OpenSearch) /wazuh-alerts-*/_search
    fetch_grype_findings      — recent Grype CVE alerts grouped by image+CVE
    fetch_compliance_failures — recent Prowler/KubeBench/KubeScape FAILs
    search_repo_code          — grep this repo (read-only)
    read_repo_file            — read a file from this repo
    lookup_cve                — OSV CVE metadata
    list_open_security_issues — GitHub issues labelled `security`/`soc2`

Required env vars:
    WAZUH_INDEXER_URL         — e.g. https://wazuh.security.dev.internal.falkordb.cloud:9443
    WAZUH_INDEXER_USERNAME    — OpenSearch user (e.g. admin / kibanaserver)
    WAZUH_INDEXER_PASSWORD
    GITHUB_TOKEN              — Copilot SDK auth (also used as fallback for repo API)
    PRIVATE_REPO_TOKEN        — optional, for GitHub issues / search API
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from typing import Optional

import requests
from copilot import define_tool
from pydantic import BaseModel, Field
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
WAZUH_ALERTS_INDEX = "wazuh-alerts-*"

# Cluster names used by us for ad-hoc syslog-pipeline testing.
# Their events are noise — never represent real findings, never affect
# real workloads. Filter out of all aggregations.
TEST_CLUSTER_NAMES = {"bash-test", "localhost-test", "app-plane-lb-test", "test-cluster"}

# Paths in the repo where alert exceptions / accepted CVEs are tracked.
# These are the source of truth — sync'd into the Wazuh manager as ConfigMaps.
ALERT_EXCEPTIONS_PATH = os.path.join(
    REPO_ROOT, "argocd", "kustomize", "wazuh-rules", "wazuh-alert-exceptions.yaml",
)
ACCEPTED_CVES_PATH = os.path.join(
    REPO_ROOT, "argocd", "kustomize", "wazuh-rules", "wazuh-accepted-cves.yaml",
)


def _load_alert_exceptions() -> list[dict]:
    """Parse `wazuh-alert-exceptions.yaml` into the structured `exceptions` list.

    Returns [] if the file is missing or malformed (don't fail triage).
    """
    if not os.path.isfile(ALERT_EXCEPTIONS_PATH):
        return []
    try:
        # Embedded JSON inside a ConfigMap `data:` block — locate the JSON
        # payload between `alert-exceptions.json: |` and end-of-block.
        with open(ALERT_EXCEPTIONS_PATH, encoding="utf-8") as f:
            text = f.read()
        m = re.search(
            r"alert-exceptions\.json:\s*\|\s*\n(.+?)(?:\n\S|\Z)",
            text, re.DOTALL,
        )
        if not m:
            return []
        # Strip common YAML block-scalar indentation (4 spaces) to get raw JSON.
        block = re.sub(r"^ {4}", "", m.group(1), flags=re.MULTILINE)
        parsed = json.loads(block)
        return parsed.get("exceptions", []) if isinstance(parsed, dict) else []
    except (OSError, ValueError):
        return []


def _load_accepted_cves() -> list[dict]:
    """Parse the `wazuh-accepted-cves.yaml` CDB list.

    Each non-empty / non-comment line is `CVE-ID:justification`.
    Returns [] if the file is missing or empty.
    """
    if not os.path.isfile(ACCEPTED_CVES_PATH):
        return []
    try:
        with open(ACCEPTED_CVES_PATH, encoding="utf-8") as f:
            text = f.read()
        m = re.search(
            r"accepted-cves:\s*\|\s*\n(.+?)(?:\n\S|\Z)",
            text, re.DOTALL,
        )
        if not m:
            return []
        out: list[dict] = []
        for raw in m.group(1).splitlines():
            ln = raw.strip()
            if not ln or ln.startswith("#"):
                continue
            if ":" not in ln:
                continue
            cve, justification = ln.split(":", 1)
            cve = cve.strip()
            if not re.match(r"^CVE-\d{4}-\d{4,}$", cve):
                continue
            out.append({"cve_id": cve, "justification": justification.strip()})
        return out
    except OSError:
        return []


def load_exceptions_evidence() -> str:
    """JSON-serialised exceptions block injected into the agent's prompt."""
    return json.dumps({
        "alert_exceptions": _load_alert_exceptions(),
        "accepted_cves": _load_accepted_cves(),
        "_note": (
            "These are the ACTIVE suppressions. Alerts/CVEs matching here "
            "are intentionally hidden from the Google Chat ping and from "
            "Grype noise. DO NOT re-raise them as new findings; if you "
            "still believe an exception is misapplied, call it out in "
            "'Operational Gaps' so the security team can review."
        ),
    }, indent=2)


def _get_nested(src: dict, dotted: str):
    """Walk a dot-notation path through nested dicts. Return None if missing."""
    cur: object = src
    for part in dotted.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
        if cur is None:
            return None
    return cur


def _event_is_suppressed(src: dict, exceptions: list[dict]) -> bool:
    """True if `src` matches any alert exception (same logic as the
    google-chat integration). Used to filter suppressed alerts out of
    triage evidence so the agent doesn't re-raise known false positives.
    """
    if not exceptions:
        return False
    rule_id = str((src.get("rule") or {}).get("id", ""))
    rule_level = (src.get("rule") or {}).get("level")
    for exc in exceptions:
        # rule_id gate
        if exc.get("rule_id") and str(exc["rule_id"]) != rule_id:
            continue
        # level_below gate
        lb = exc.get("level_below")
        if lb is not None and isinstance(rule_level, (int, float)) and rule_level >= lb:
            continue
        # field/pattern gate
        field = exc.get("field")
        pattern = exc.get("pattern")
        if field and pattern is not None:
            val = _get_nested(src, field)
            if val is None:
                continue
            sval = str(val)
            if exc.get("is_regex"):
                try:
                    if not re.search(pattern, sval):
                        continue
                except re.error:
                    continue
            else:
                if pattern not in sval:
                    continue
        return True
    return False


def _verify_ssl() -> bool:
    """SSL verification policy: disabled in dev / when explicitly disabled.

    The Wazuh Indexer ships with a self-signed certificate, so verification
    is off by default in dev. Override with DISABLE_SSL_VERIFY=true in prod
    if needed.
    """
    env = os.environ.get("ENVIRONMENT", "prod").lower()
    if env == "dev":
        return False
    if os.environ.get("DISABLE_SSL_VERIFY", "false").lower() == "true":
        return False
    return True


def _indexer_search(query: dict, size: int = 500) -> dict:
    """POST a search query to the Wazuh Indexer (OpenSearch).

    Targets the `wazuh-alerts-*` index pattern. Auth via HTTP Basic.
    Retries transient connection / SSL errors a few times — TCP passthrough
    through the nginx LB can drop concurrent connections.
    """
    base = os.environ.get("WAZUH_INDEXER_URL", "").rstrip("/")
    user = os.environ.get("WAZUH_INDEXER_USERNAME", "")
    pwd = os.environ.get("WAZUH_INDEXER_PASSWORD", "")
    if not base:
        raise RuntimeError("WAZUH_INDEXER_URL not set")
    body = {"size": size, "query": query, "sort": [{"@timestamp": "desc"}]}

    session = requests.Session()
    retry = Retry(
        total=4,
        backoff_factor=1.0,  # 0s, 1s, 2s, 4s
        status_forcelist=(502, 503, 504),
        allowed_methods=frozenset(["GET", "POST"]),
        raise_on_status=False,
    )
    session.mount("https://", HTTPAdapter(max_retries=retry))
    session.mount("http://", HTTPAdapter(max_retries=retry))

    last_err: Optional[Exception] = None
    for attempt in range(4):
        try:
            resp = session.post(
                f"{base}/{WAZUH_ALERTS_INDEX}/_search",
                auth=(user, pwd) if user else None,
                json=body,
                timeout=45,
                verify=_verify_ssl(),
            )
            resp.raise_for_status()
            return resp.json()
        except (requests.exceptions.SSLError,
                requests.exceptions.ConnectionError) as e:
            last_err = e
            if attempt == 3:
                break
            # Linear backoff for connection-level errors (the Retry adapter
            # doesn't cover SSLError / ConnectionError before a response).
            import time
            time.sleep(2 ** attempt)
    raise last_err  # type: ignore[misc]


def _hits(data: dict) -> list[dict]:
    """Extract `_source` documents from an OpenSearch search response."""
    return [h.get("_source", {}) for h in data.get("hits", {}).get("hits", [])]


def _total_hits(data: dict) -> int:
    total = data.get("hits", {}).get("total", 0)
    if isinstance(total, dict):
        return int(total.get("value", 0))
    return int(total or 0)


def _is_test_cluster(cluster_name: str) -> bool:
    """True if cluster name is one of our ad-hoc syslog test markers."""
    return (cluster_name or "").strip().lower() in TEST_CLUSTER_NAMES


def _classify_plane(agent_name: str, cluster_name: str = "") -> str:
    """Classify an event into a control plane.

    Two signals are considered, in order of reliability:

    1. `data.Cluster` (set by Prowler / kube-bench / KubeScape / Grype CronJobs
       via the `--cluster-name` overlay flag). Scanner findings are forwarded
       to the manager over syslog, so `agent.name` is always
       `wazuh-manager-*` for them — the cluster name is the only correct
       attribution signal.
    2. `agent.name` (Wazuh agent hostname). Used for native agent events
       (Falco, syscheck, rootcheck) where `data.Cluster` is absent.

    Conventions:
      - cluster `ctrl-plane-*`               → ctrl-plane
      - cluster `app-plane-*` / `customer-*` → app-plane
      - agent  `wazuh-manager-*`             → ctrl-plane
      - agent  `gke-observability-stack-*`   → ctrl-plane
      - agent  `gke-c-<id>-*` / `aks-*-vmss` → app-plane
    Anything else is `unknown`.
    """
    c = (cluster_name or "").lower()
    if c.startswith("ctrl-plane"):
        return "ctrl-plane"
    if c.startswith("app-plane") or c.startswith("customer-"):
        return "app-plane"
    n = (agent_name or "").lower()
    if not n:
        return "unknown"
    if n.startswith("wazuh-manager") or "observability-stack" in n or "observability-re" in n:
        return "ctrl-plane"
    if n.startswith("gke-c-") or n.startswith("aks-") or "customer" in n:
        return "app-plane"
    return "unknown"


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
# Tool: fetch_wazuh_alerts
# --------------------------------------------------------------------------- #

class FetchWazuhAlertsParams(BaseModel):
    rule_groups: Optional[str] = Field(
        default=None,
        description=(
            "Comma-separated list of rule.groups to match (any). "
            "E.g. 'soc2_critical,soc2_high'. Optional."
        ),
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
    """Aggregated Wazuh alerts grouped by rule.id (top 30).

    Queries the Wazuh Indexer directly. Use to surface noisy/important
    rules firing across the fleet over the lookback window.
    """
    must: list[dict] = [
        {"range": {"@timestamp": {"gte": f"now-{params.days}d"}}},
        {"range": {"rule.level": {"gte": params.min_level}}},
    ]
    if params.rule_groups:
        groups = [g.strip() for g in params.rule_groups.split(",") if g.strip()]
        if groups:
            must.append({"terms": {"rule.groups": groups}})
    try:
        data = _indexer_search({"bool": {"must": must}}, size=params.limit)
    except requests.RequestException as e:
        return json.dumps({"error": str(e), "hint": "Wazuh Indexer unreachable"})

    by_rule: dict[str, dict] = {}
    by_plane: dict[str, int] = {"ctrl-plane": 0, "app-plane": 0, "unknown": 0}
    exceptions = _load_alert_exceptions()
    suppressed_count = 0
    test_skipped = 0
    for src in _hits(data):
        if _event_is_suppressed(src, exceptions):
            suppressed_count += 1
            continue
        if _is_test_cluster((src.get("data", {}) or {}).get("Cluster", "")):
            test_skipped += 1
            continue
        rule = src.get("rule", {}) or {}
        rid = str(rule.get("id", "?"))
        agent = (src.get("agent", {}) or {}).get("name", "?")
        cluster = (src.get("data", {}) or {}).get("Cluster", "")
        plane = _classify_plane(agent, cluster)
        by_plane[plane] = by_plane.get(plane, 0) + 1
        entry = by_rule.setdefault(rid, {
            "rule_id": rid,
            "level": rule.get("level"),
            "description": rule.get("description"),
            "groups": rule.get("groups", []),
            "count": 0,
            "agents": set(),
            "planes": set(),
        })
        entry["count"] += 1
        entry["agents"].add(agent)
        entry["planes"].add(plane)
    top = sorted(
        ({**v, "agents": sorted(v["agents"])[:10],
          "agent_count": len(v["agents"]),
          "planes": sorted(v["planes"])}
         for v in by_rule.values()),
        key=lambda x: x["count"], reverse=True,
    )[:30]
    return json.dumps({
        "total_hits": _total_hits(data),
        "suppressed_by_exceptions": suppressed_count,
        "test_cluster_events_skipped": test_skipped,
        "window_days": params.days,
        "min_level": params.min_level,
        "by_plane": by_plane,
        "top_rules": top,
    }, indent=2)[:30000]


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
    """Aggregated Grype CVE findings: top affected images + per-cluster summary.

    Queries the Wazuh Indexer for events tagged `rule.groups: grype_vuln`.
    Output is grouped (NOT raw per-finding) so it's actionable for triage.
    """
    severities = [s.strip().capitalize() for s in params.severity.split(",") if s.strip()]
    query = {
        "bool": {
            "must": [
                {"range": {"@timestamp": {"gte": f"now-{params.days}d"}}},
                {"term": {"rule.groups": "grype_vuln"}},
            ],
            "filter": [
                {"terms": {"data.Severity": severities}} if severities else {"match_all": {}},
            ],
        }
    }
    try:
        data = _indexer_search(query, size=1000)
    except requests.RequestException as e:
        return json.dumps({"error": str(e), "hint": "Wazuh Indexer unreachable"})

    accepted_cves = {c["cve_id"] for c in _load_accepted_cves()}
    by_image: dict[str, dict] = {}
    by_cluster: dict[str, dict] = {}
    by_plane: dict[str, int] = {"ctrl-plane": 0, "app-plane": 0, "unknown": 0}
    suppressed_count = 0
    test_skipped = 0
    for src in _hits(data):
        d = src.get("data", {}) or {}
        if _is_test_cluster(d.get("Cluster", "")):
            test_skipped += 1
            continue
        cve = d.get("VulnerabilityID") or d.get("vulnerability", {}).get("id", "")
        if cve and cve in accepted_cves:
            suppressed_count += 1
            continue
        agent_name = (src.get("agent", {}) or {}).get("name", "")
        image = d.get("ImageName") or d.get("artifact", {}).get("name") or "unknown"
        cluster = d.get("Cluster") or agent_name or "unknown"
        sev = d.get("Severity") or d.get("vulnerability", {}).get("severity", "")
        plane = _classify_plane(agent_name, cluster)
        by_plane[plane] = by_plane.get(plane, 0) + 1
        bi = by_image.setdefault(image, {"cves": set(), "severities": set(),
                                         "planes": set()})
        if cve:
            bi["cves"].add(cve)
        if sev:
            bi["severities"].add(sev)
        bi["planes"].add(plane)
        bc = by_cluster.setdefault(cluster, {"cves": set(), "images": set(),
                                             "plane": plane})
        if cve:
            bc["cves"].add(cve)
        bc["images"].add(image)
    top_images = sorted(
        ({"image": k, "cve_count": len(v["cves"]),
          "severities": sorted(v["severities"]),
          "planes": sorted(v["planes"]),
          "sample_cves": sorted(v["cves"])[:10]}
         for k, v in by_image.items()),
        key=lambda x: x["cve_count"], reverse=True,
    )[:20]
    by_cluster_out = {
        k: {"cve_count": len(v["cves"]),
            "image_count": len(v["images"]),
            "plane": v["plane"],
            "sample_images": sorted(v["images"])[:5]}
        for k, v in by_cluster.items()
    }
    return json.dumps({
        "total_hits": _total_hits(data),
        "suppressed_by_accepted_cves": suppressed_count,
        "test_cluster_events_skipped": test_skipped,
        "window_days": params.days,
        "by_plane": by_plane,
        "top_affected_images": top_images,
        "by_cluster": by_cluster_out,
    }, indent=2)[:30000]


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
    """Aggregated Prowler / kube-bench / KubeScape FAIL findings.

    Queries the Wazuh Indexer for rule.groups matching the requested framework(s).
    """
    framework_groups = {
        "prowler": ["prowler_compliance", "soc2_fail"],
        "kubebench": ["kubebench_cis", "cis_fail"],
        "kubescape": ["kubescape_attack", "kubescape_fail"],
    }
    if params.framework == "all":
        groups = sorted({g for gs in framework_groups.values() for g in gs})
    else:
        groups = framework_groups.get(params.framework, [])
    if not groups:
        return json.dumps({"error": f"unknown framework: {params.framework}"})

    query = {
        "bool": {
            "must": [
                {"range": {"@timestamp": {"gte": f"now-{params.days}d"}}},
                {"terms": {"rule.groups": groups}},
            ]
        }
    }
    try:
        data = _indexer_search(query, size=1000)
    except requests.RequestException as e:
        return json.dumps({"error": str(e), "hint": "Wazuh Indexer unreachable"})

    exceptions = _load_alert_exceptions()
    by_control: dict[str, dict] = {}
    by_plane: dict[str, int] = {"ctrl-plane": 0, "app-plane": 0, "unknown": 0}
    suppressed_count = 0
    test_skipped = 0
    for src in _hits(data):
        if _event_is_suppressed(src, exceptions):
            suppressed_count += 1
            continue
        d = src.get("data", {}) or {}
        if _is_test_cluster(d.get("Cluster", "")):
            test_skipped += 1
            continue
        agent_name = (src.get("agent", {}) or {}).get("name", "")
        ctrl = (d.get("ControlID") or d.get("CheckTitle")
                or d.get("TestNumber") or d.get("check_id") or "unknown")
        cluster = d.get("Cluster") or agent_name or "unknown"
        sev = d.get("Severity") or d.get("severity") or ""
        plane = _classify_plane(agent_name, d.get("Cluster", ""))
        by_plane[plane] = by_plane.get(plane, 0) + 1
        key = f"{ctrl} ({sev})" if sev else str(ctrl)
        entry = by_control.setdefault(key, {
            "clusters": set(),
            "planes": set(),
            "count": 0,
            "description": (d.get("ControlName") or d.get("CheckTitle")
                            or d.get("TestDesc") or d.get("description") or ""),
        })
        entry["clusters"].add(cluster)
        entry["planes"].add(plane)
        entry["count"] += 1
    out = sorted(
        ({"control": k, "count": v["count"],
          "clusters": sorted(v["clusters"]),
          "planes": sorted(v["planes"]),
          "description": v["description"]}
         for k, v in by_control.items()),
        key=lambda x: x["count"], reverse=True,
    )[:30]
    return json.dumps({
        "total_hits": _total_hits(data),
        "suppressed_by_exceptions": suppressed_count,
        "test_cluster_events_skipped": test_skipped,
        "window_days": params.days,
        "framework": params.framework,
        "by_plane": by_plane,
        "top_controls": out,
    }, indent=2)[:30000]


# --------------------------------------------------------------------------- #
# Tool: search_repo_code
# --------------------------------------------------------------------------- #

class SearchRepoCodeParams(BaseModel):
    pattern: str = Field(description="Regex pattern to search for.")
    path_glob: Optional[str] = Field(
        default=None,
        description="Optional path glob to scope the search (e.g. argocd/**).",
    )


@define_tool(
    name="search_repo_code",
    description=(
        "Grep this repo (FalkorDB/falkordb-dbaas) for a regex pattern. "
        "Read-only. Use to check whether a CVE'd package is actually used, "
        "or to find the declaration of an image tag that needs bumping."
    ),
    skip_permission=True,
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


@define_tool(
    name="read_repo_file",
    description=(
        "Read a slice of a file from this repo (FalkorDB/falkordb-dbaas). "
        "Read-only. Use to inspect a kustomization, manifest, or values file "
        "located via search_repo_code."
    ),
    skip_permission=True,
)
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


@define_tool(
    name="lookup_cve",
    description=(
        "Query OSV for authoritative CVE metadata. Returns severity, affected "
        "package ranges, and fixed-in versions. Use to confirm a finding from "
        "Grype/Wazuh is real before recommending a fix."
    ),
    skip_permission=True,
)
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


@define_tool(
    name="list_open_security_issues",
    description=(
        "List open GitHub issues labelled `security`, `soc2`, or `ai-triage` "
        "in the given repo. Use to avoid filing duplicate findings."
    ),
    skip_permission=True,
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
