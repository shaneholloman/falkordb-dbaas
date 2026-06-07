#!/usr/bin/env python3
"""
AI OOM Triage — Copilot SDK-powered ContainerOOMKilled analysis.

Runs after the existing oom_handler and rdb_uploader have finished.
Uses GitHub Copilot to analyze the OOM event like a senior engineer would:
  1. Query memory metrics at dual time scales (7 days + 60 min)
  2. Analyze command rates and latency patterns
  3. Fetch pod logs for errors and suspicious activity
  4. Inspect the database via RDB/AOF dump
  5. Diagnose the root cause and send a Google Chat notification

Usage:
    python scripts/ai_oom_triage.py \
        --pod node-f-0 \
        --namespace instance-abc123 \
        --cluster hc-xxxx \
        --container service \
        --vmauth-url https://vmauth.example.com \
        --grafana-url https://grafana.example.com \
        --customer-name "John Doe" \
        --customer-email "john@example.com" \
        --subscription-id "sub-123" \
        [--rdb-url gs://bucket/path/dump.rdb] \
        [--aof-url gs://bucket/path/appendonlydir.tar.gz] \
        [--falkordb-version v4.18.0]
"""

import os
import sys
import re
import json
import html
import hashlib
import argparse
import asyncio
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode, quote
from zoneinfo import ZoneInfo

import requests
from copilot import CopilotClient, PermissionHandler

from oom_triage_tools import ALL_TOOLS, cleanup
from oom_handler import CHAT_MENTIONS

_EMAIL_RE = re.compile(r'[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+')


SYSTEM_MESSAGE = """\
You are a senior FalkorDB/Redis operations engineer investigating a ContainerOOMKilled event.

## Your Mission
Determine WHY this pod ran out of memory and classify the root cause. You have access \
to the same metrics, logs, and tools a human engineer uses.

## Key Principles

1. **RSS is ground truth.** The OOM killer looks at container_memory_rss, NOT \
redis_memory_used_bytes. Always prioritize RSS when analyzing the OOM event. \
The redis_exporter may have scrape gaps during high CPU, but container_memory_rss \
(scraped by cadvisor/node-exporter) is always available.

2. **Do NOT assume replication unless explicitly told.** The topology (standalone vs \
replicated) is provided in the context. If the instance is standalone, there is NO \
primary/replica relationship — do not mention replication, syncing, or resync in your \
analysis. If the pod restarts on a standalone instance, it recovers from its own \
RDB/AOF on disk.

3. **Context determines diagnosis.** A large query that causes OOM when the database \
is at 50% memory is a genuine problem query. The same query at 90% memory just reveals \
that the real issue is insufficient memory — the query is not the root cause.

## Workflow — Follow These Steps In Order

### Step 1: Long-Term Memory Trend (7-day view)
Query these metrics over the **past 7 days** (step="1h") to understand the growth pattern:
- `redis_memory_used_bytes{namespace="NAMESPACE", pod="POD", container="CONTAINER"}` (may have gaps during high CPU)
- `redis_memory_max_bytes{namespace="NAMESPACE", pod="POD", container="CONTAINER"}`
- `container_memory_rss{namespace="NAMESPACE", pod="POD", container="CONTAINER"}` (always available, ground truth)

Determine:
- Is memory steadily growing day over day? (legitimate growth)
- Has it been flat and then spiked recently? (event-triggered)
- What percentage of maxmemory was in use 7 days ago vs now?
- What was RSS 7 days ago vs at OOM? (RSS includes fork CoW, fragmentation, module overhead)

### Step 2: Short-Term Memory Analysis (60-minute view)
Query these metrics over the **past 60 minutes** (step="15s") to see the immediate event:
- `redis_memory_used_bytes{namespace="NAMESPACE", pod="POD", container="CONTAINER"}`
- `container_memory_rss{namespace="NAMESPACE", pod="POD", container="CONTAINER"}` ← PRIMARY signal for OOM
- `container_memory_working_set_bytes{namespace="NAMESPACE", pod="POD", container="CONTAINER"}`
- `redis_memory_max_bytes{namespace="NAMESPACE", pod="POD", container="CONTAINER"}`

Determine:
- Was there a sudden RSS spike right before the OOM?
- How much did RSS exceed the container limit?
- Is RSS significantly higher than redis_memory_used_bytes? (fragmentation / fork CoW)
- Are there gaps in redis_memory_used_bytes where RSS still has data? (exporter scrape failures during high CPU)

### Step 3: Memory Utilization at OOM Time
Calculate the utilization ratio just before the OOM using BOTH:
- `redis_memory_used_bytes{namespace="NAMESPACE", pod="POD", container="CONTAINER"} / redis_memory_max_bytes{namespace="NAMESPACE", pod="POD", container="CONTAINER"} * 100` (if available)
- `container_memory_rss{namespace="NAMESPACE", pod="POD", container="CONTAINER"} / on(namespace,pod,container) kube_pod_container_resource_limits{namespace="NAMESPACE", pod="POD", container="CONTAINER", resource="memory"} * 100` (ground truth)

This is CRITICAL for diagnosis:
- **< 70%**: Something caused a massive spike — likely a huge query or bulk operation
- **70-89%**: Moderate headroom — a large query could push it over
- **≥ 90%**: Very low headroom — even normal operations could trigger OOM. \
The real issue is insufficient memory, not the specific query.

### Step 4: Command Rate & Latency Analysis
Query over the **past 60 minutes** (step="15s"):
- `rate(redis_commands_total{namespace="NAMESPACE", pod="POD", container="CONTAINER"}[5m])`
- `rate(redis_commands_duration_seconds_total{namespace="NAMESPACE", pod="POD", container="CONTAINER"}[5m])`
- `redis_connected_clients{namespace="NAMESPACE", pod="POD", container="CONTAINER"}`

Look for:
- Spike in command rate (bulk import / many concurrent queries)
- Spike in command duration (expensive queries consuming memory)
- Spike in connected clients (sudden load increase)

### Step 5: Network I/O Analysis
Query over the **past 60 minutes** (step="15s"):
- `rate(redis_net_input_bytes_total{namespace="NAMESPACE", pod="POD", container="CONTAINER"}[5m])`
- `rate(redis_net_output_bytes_total{namespace="NAMESPACE", pod="POD", container="CONTAINER"}[5m])`

A spike in input bytes can indicate bulk data ingestion. Report the PEAK value, not just the average.

### Step 6: Log Analysis
Use `fetch_logs` to get the last 30 minutes of logs. Look for:
- Error messages or warnings
- Large query patterns
- Slow log entries
- Eviction warnings
- AOF rewrite or BGSAVE activity (these cause memory spikes due to fork)

### Step 7: Database Inspection (if RDB/AOF available)
If RDB or AOF URLs are provided:
- Use `run_falkordb_local` to start a local instance with the dump
- Use `execute_query` to run:
  - `INFO memory` — detailed memory breakdown
  - `INFO keyspace` — database size
  - `DBSIZE` — total key count
  - `GRAPH.LIST` — list all graphs
  - For each graph: `GRAPH.MEMORY USAGE <name>` — **critical** for per-graph memory breakdown. \
This returns: total_graph_sz_mb, label_matrices_sz_mb, relation_matrices_sz_mb, \
amortized_node_block_sz_mb, amortized_node_attributes_by_label_sz_mb, \
amortized_edge_block_sz_mb, amortized_edge_attributes_by_type_sz_mb, indices_sz_mb.
  - For each graph: `GRAPH.QUERY <name> "CALL db.labels()"` and \
`GRAPH.QUERY <name> "CALL db.relationshipTypes()"` to understand the schema
  - `CONFIG GET maxmemory` — configured memory limit

**Important:** Use `GRAPH.MEMORY USAGE` output to build the Memory Breakdown Table \
in the report. This identifies which graph consumes the most memory and whether \
the OOM is attributable to a single graph.

## Common OOM Patterns

### Consecutive OOMs on Standalone Instance
When a standalone instance OOMs repeatedly in short succession, the pattern is:
1. Pod starts → loads data from RDB/AOF on disk
2. Memory grows as dataset is restored
3. Background save (BGSAVE or AOF rewrite) triggers fork()
4. Copy-on-Write (CoW) pages accumulate during fork, pushing RSS past limit
5. OOM killer terminates the container → restart → repeat from step 1

This is NOT caused by replication resync. The fix is more memory headroom.

### Fork + Copy-on-Write
BGSAVE and AOF rewrite fork the Redis process. The child initially shares pages, \
but as the parent modifies pages during writes, CoW duplicates them. Peak RSS can \
reach up to 2x used_memory during active writes + fork. This is the most common \
hidden cause of OOMs when redis_memory_used_bytes shows plenty of headroom.

### Step 8: Produce Diagnosis
After completing your analysis, output EXACTLY this structured report:

```
## 🤖 AI OOM Triage Report

### Memory Timeline
- **7-day trend:** [Steady growth / Flat / Recent spike / etc.]
- **Memory (used_bytes) 7 days ago:** [X MB / X% of maxmemory]
- **Memory (used_bytes) at OOM:** [X MB / X% of maxmemory]
- **Container RSS at OOM:** [X MB] ← this is what the OOM killer saw
- **Container memory limit:** [X MB]
- **RSS / limit ratio:** [X%]
- **Maxmemory config:** [X MB]
- **Fragmentation ratio:** [RSS / used_bytes — if > 1.5 highlight CoW or fragmentation]

### Command Activity
- **Command rate before OOM:** [X ops/sec — normal / elevated / spike]
- **Command latency before OOM:** [X ms avg — normal / elevated / spike]
- **Connected clients:** [X — normal / elevated / spike]
- **Network I/O (peak):** [X KB/s in / X KB/s out — note if spike correlates with OOM]

### Log Analysis
[Summary of any relevant findings from logs — errors, large queries, \
slow operations, AOF/BGSAVE activity]

### Memory Breakdown
If GRAPH.MEMORY USAGE was run, include a table showing where memory is allocated. \
This helps identify which graph or component is consuming the most memory. \
If multiple graphs exist, identify which graph is the dominant consumer.

| Component | Size (MB) | % of Total |
|-----------|-----------|------------|
| Graph: <name1> — node attributes | X | X% |
| Graph: <name1> — edge attributes | X | X% |
| Graph: <name1> — indices | X | X% |
| Graph: <name1> — label matrices | X | X% |
| Graph: <name1> — relation matrices | X | X% |
| Graph: <name2> — total | X | X% |
| ... | ... | ... |
| Redis overhead + fragmentation | X | X% |
| **Total** | **X** | **100%** |

If RDB/AOF was not available, state: "Memory breakdown unavailable (no RDB/AOF dump provided)."

### Database State
[If RDB/AOF was inspected: total keys, graph count, per-graph node/edge counts, \
schema summary (labels, relationship types)]

### Root Cause Diagnosis
**Category:** [One of: Legitimate Growth / Bulk Operation / Oversized Query / \
Insufficient Headroom / Memory Fragmentation / Background Process (AOF/BGSAVE) / \
Single Graph Dominance / Other]

[Detailed explanation with evidence from the metrics and logs. \
Explain WHY you chose this category and why other categories don't fit.]

If one graph is consuming a disproportionate share of memory (>80%), call it out \
explicitly as it may indicate a customer issue with that specific graph.

**Confidence:** [High / Medium / Low] — [one-sentence justification]

### Recurrence Likelihood
**Likelihood:** [High / Medium / Low]

[Assess the probability of this OOM happening again based on:
- Memory growth trajectory (is the dataset growing toward the limit?)
- Headroom remaining (how close is steady-state to the limit?)
- Whether the trigger was a one-time event or a repeating pattern
- Whether the underlying cause has been or can be resolved without intervention]

### Known Issue Classification
**Classification:** [New Pattern / Known Pattern — <pattern name>]

Known OOM patterns to match against:
1. **Fork CoW Spiral** — consecutive OOMs during BGSAVE/AOF rewrite on restart
2. **Replication Full Sync** — OOM during replica reconnection after master restart
3. **Dataset Growth** — gradual memory increase until headroom is exhausted
4. **Bulk Ingestion Spike** — sudden memory spike from large data import
5. **Query Memory Bomb** — single expensive query allocating excessive memory
6. **Index Rebuild Storm** — memory spike during index creation or rebuild
7. **Fragmentation Creep** — RSS growing due to memory fragmentation over time

If this OOM matches a known pattern, state which one and explain the match. \
If it's a genuinely new pattern, describe what makes it unique.

### Recommended Action
[Specific actionable recommendation based on the diagnosis. \
Reference FalkorDB documentation where applicable.

FalkorDB-specific mitigations to consider:
- **Scale up memory** — Increase maxmemory and container limits. Rule of thumb: \
container_limit should be ≥ 1.5× maxmemory for standalone, ≥ 2× for replicated/cluster \
to accommodate fork CoW and replication buffers.
- **Query optimization** — If a specific query pattern caused the OOM, suggest using \
GRAPH.EXPLAIN to analyze the query plan, or GRAPH.PROFILE to measure actual execution. \
Consider adding indices (GRAPH.CONSTRAINT CREATE) to reduce scan-based memory usage. \
Reference: https://docs.falkordb.com/commands/graph.explain.html
- **Graph splitting** — If one graph dominates memory, consider splitting it into \
multiple smaller graphs or archiving old data.
- **Index tuning** — If indices consume a large portion of memory, review whether \
all indices are necessary. Use GRAPH.MEMORY USAGE to see index sizes. \
Reference: https://docs.falkordb.com/commands/graph.memory.html
- **Timeout configuration** — Set TIMEOUT_DEFAULT and TIMEOUT_MAX via GRAPH.CONFIG SET \
to prevent long-running queries from consuming excessive memory. \
Reference: https://docs.falkordb.com/commands/graph.config-set.html
- **AOF/BGSAVE tuning** — If fork CoW is the trigger, consider adjusting \
auto-aof-rewrite-percentage / auto-aof-rewrite-min-size, or scheduling BGSAVE \
during low-traffic periods.
- **Replication buffer limits** — For replicated/cluster instances, configure \
client-output-buffer-limit replica to cap replication buffer growth.
- **Diskless replication** — Enable repl-diskless-sync yes to reduce memory pressure \
during replica full sync.
- **Active defragmentation** — Enable CONFIG SET activedefrag yes if fragmentation \
ratio is high (> 1.5).]
```

## Constraints
- You are READ-ONLY on production systems. Only use local Docker for inspection.
- Be concise but thorough. Evidence-based reasoning only.
- If you cannot determine something, say so — don't guess.
- **NEVER fabricate or assume replication/topology** — only state what the provided topology tells you.
- Include actual metric values in your report, not just descriptions.
- Replace NAMESPACE, POD, and CONTAINER placeholders in the PromQL queries with the actual values.
- When reporting Network I/O, report the **peak** value observed, not just steady-state.
- Always run `GRAPH.MEMORY USAGE` for each graph when RDB/AOF is available — \
the memory breakdown table is mandatory when database inspection is possible.
"""


def _mask_email(email: str) -> str:
    """Mask email address to protect PII."""
    if '@' not in email:
        return email
    local, domain = email.split('@', 1)
    if len(local) <= 1:
        masked_local = local
    else:
        masked_local = local[0] + '*' * (len(local) - 1)
    return f"{masked_local}@{domain}"


# Regex to detect GCS signed URLs (contain X-Goog-Signature or Signature query params)
_SIGNED_URL_RE = re.compile(
    r'https://storage\.googleapis\.com/[^\s"\'<>]+(?:X-Goog-Signature|Signature)=[^\s"\'<>]+'
)


def _scrub_report(text: str) -> str:
    """Scrub sensitive content from a report before logging to stdout.

    Masks emails and signed URLs. This is only used for console output —
    the GitHub issue and Google Chat get the unmasked report.
    """
    text = _EMAIL_RE.sub(lambda m: _mask_email(m.group(0)), text)
    text = _SIGNED_URL_RE.sub("[SIGNED-URL-REDACTED]", text)
    return text


# ---------------------------------------------------------------------------
# GitHub Issue Manager for OOM tracking
# ---------------------------------------------------------------------------

class GitHubIssueManager:
    """Manages GitHub issues for OOM event tracking.

    Deduplicates by customer + namespace — recurring OOMs on the same instance
    for the same customer within 7 days are added as comments to the existing
    issue rather than creating new issues.
    """

    MAX_LABEL_LENGTH = 50

    def __init__(self, token: str, repo: str, project_id: str | None = None):
        self.token = token
        self.repo = repo  # "owner/repo"
        self.project_id = project_id  # "PVT_kwDO..."
        self.session = requests.Session()
        self.session.headers.update({
            'Authorization': f'Bearer {token}',
            'Accept': 'application/vnd.github.v3+json',
        })
        self.api_url = "https://api.github.com"

    # -- label helpers -------------------------------------------------------

    @staticmethod
    def _make_safe_label(prefix: str, value: str) -> str:
        """Create a label that fits within GitHub's 50-char limit."""
        full_label = f"{prefix}:{value}"
        if len(full_label) <= GitHubIssueManager.MAX_LABEL_LENGTH:
            return full_label
        value_hash = hashlib.sha256(value.encode('utf-8')).hexdigest()[:8]
        label = f"{prefix}:{value_hash}"
        if len(label) > GitHubIssueManager.MAX_LABEL_LENGTH:
            max_prefix_len = GitHubIssueManager.MAX_LABEL_LENGTH - 9
            label = f"{prefix[:max_prefix_len]}:{value_hash}"
        print(f"⚠️  Label '{prefix}:{value}' too long ({len(full_label)} chars), using hash: {label}")
        return label

    def _ensure_label_exists(self, label: str):
        """Ensure a label exists in the repo, create if missing."""
        if len(label) > self.MAX_LABEL_LENGTH:
            raise ValueError(f"Label '{label}' exceeds {self.MAX_LABEL_LENGTH} char limit")
        encoded = quote(label, safe='')
        resp = self.session.get(
            f"{self.api_url}/repos/{self.repo}/labels/{encoded}", timeout=30,
        )
        if resp.status_code == 404:
            create = self.session.post(
                f"{self.api_url}/repos/{self.repo}/labels",
                json={"name": label, "color": "d93f0b"},  # red for OOM
                timeout=30,
            )
            if create.status_code == 201:
                print(f"Created label: {label}")
            elif create.status_code == 422:
                print(f"Label already exists (race): {label}")
            else:
                create.raise_for_status()

    # -- project linking -----------------------------------------------------

    def _add_issue_to_project(self, issue_node_id: str):
        """Add issue to GitHub project via GraphQL."""
        if not self.project_id:
            return
        mutation = """
        mutation($projectId: ID!, $contentId: ID!) {
          addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
            item { id }
          }
        }
        """
        resp = self.session.post(
            "https://api.github.com/graphql",
            json={"query": mutation, "variables": {
                "projectId": self.project_id,
                "contentId": issue_node_id,
            }},
            timeout=30,
        )
        if resp.status_code == 200:
            result = resp.json()
            if "errors" in result:
                print(f"❌ Failed to add issue to project: {result['errors']}", file=sys.stderr)
            else:
                print(f"✅ Issue added to project {self.project_id}")
        else:
            print(f"❌ Failed to add issue to project (HTTP {resp.status_code})", file=sys.stderr)

    # -- find / create / comment ---------------------------------------------

    def find_existing_issue(self, customer_email: str, namespace: str,
                            hours: int = 168) -> int | None:
        """Find an open OOM issue for this namespace within *hours* (default 7 days).

        Returns the issue number, or None if no issue exists.
        """
        customer_label = self._make_safe_label('customer', customer_email)
        namespace_label = self._make_safe_label('namespace', namespace)

        resp = self.session.get(
            f"{self.api_url}/repos/{self.repo}/issues",
            params={
                'state': 'open',
                'labels': f'oom,{customer_label},{namespace_label}',
                'per_page': 10,
            },
            timeout=30,
        )
        resp.raise_for_status()
        issues = resp.json()

        if not issues:
            return None

        issue = issues[0]
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
        try:
            created = datetime.fromisoformat(
                issue['created_at'].replace('Z', '+00:00')
            )
        except (ValueError, KeyError):
            created = datetime.now(timezone.utc)

        if created < cutoff:
            print(f"   Existing issue #{issue['number']} is older than {hours}h, will create new")
            return None

        print(f"   Found existing issue #{issue['number']}")
        return issue['number']

    def create_issue(
        self,
        customer_name: str,
        customer_email: str,
        subscription_id: str,
        pod: str,
        namespace: str,
        cluster: str,
        container: str,
        timestamp: str,
        report: str,
        grafana_memory_url: str,
        grafana_pods_url: str,
    ) -> int:
        """Create a new GitHub issue with the full OOM triage report."""

        # Extract key fields for the title
        category = _extract_report_field(report, "Category") or "Unknown"

        title = f"[OOM] {pod} in {namespace} ({cluster}) — {category} — {timestamp}"

        body = f"""## ContainerOOMKilled — AI Triage

**Customer:** {customer_name} ({customer_email})
**Subscription ID:** {subscription_id}
**Pod:** {pod}
**Container:** {container}
**Namespace:** {namespace}
**Cluster:** {cluster}
**Time (Israel):** {timestamp}

**Grafana Links:** [Memory metrics]({grafana_memory_url}) · [Pod overview]({grafana_pods_url})

---

{report}
"""

        customer_label = self._make_safe_label('customer', customer_email)
        namespace_label = self._make_safe_label('namespace', namespace)

        labels = [customer_label, namespace_label, 'oom']
        for lbl in labels:
            self._ensure_label_exists(lbl)

        resp = self.session.post(
            f"{self.api_url}/repos/{self.repo}/issues",
            json={'title': title, 'body': body, 'labels': labels},
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        issue_number = data['number']
        print(f"✅ Created OOM issue #{issue_number}")

        self._add_issue_to_project(data['node_id'])
        return issue_number

    def add_comment(self, issue_number: int, pod: str, namespace: str,
                    cluster: str, container: str, timestamp: str,
                    report: str, grafana_memory_url: str,
                    grafana_pods_url: str):
        """Add triage report as a comment on an existing issue."""
        comment = f"""### Recurring OOM — {timestamp}

**Pod:** {pod} | **Container:** {container} | **Namespace:** {namespace} | **Cluster:** {cluster}

**Grafana Links:** [Memory metrics]({grafana_memory_url}) · [Pod overview]({grafana_pods_url})

---

{report}
"""
        resp = self.session.post(
            f"{self.api_url}/repos/{self.repo}/issues/{issue_number}/comments",
            json={'body': comment},
            timeout=30,
        )
        resp.raise_for_status()
        print(f"✅ Added triage comment to issue #{issue_number}")


def _build_initial_prompt(args) -> str:
    """Build the initial prompt with OOM context for the AI session."""
    # Determine topology description
    topology = args.topology if args.topology else "unknown"
    if topology == "standalone":
        topology_note = (
            "This is a **standalone** instance (single node, NO replication). "
            "If it OOMs and restarts, it recovers from its own RDB/AOF on disk. "
            "Do NOT mention replication, primary/replica, or resync in your analysis."
        )
    elif topology == "replicated":
        topology_note = (
            "This is a **replicated** instance (primary + replica nodes). "
            "Consider replication buffer memory and whether replica resync after "
            "restart contributed to the OOM."
        )
    elif topology == "cluster":
        topology_note = (
            "This is a **cluster** instance (sharded, with replication). "
            "Consider replication buffer memory, cluster bus overhead, and whether "
            "replica resync after restart contributed to the OOM."
        )
    else:
        topology_note = (
            "Topology is unknown. Do NOT assume replication unless you find explicit "
            "evidence (e.g., connected_slaves > 0 in INFO output)."
        )

    prompt = f"""\
A ContainerOOMKilled event has been detected. Please perform a full OOM triage.

**OOM Context:**
- Pod: {args.pod}
- Namespace: {args.namespace}
- Cluster: {args.cluster}
- Container: {args.container}
- Customer: {args.customer_name} ({args.customer_email})
- Topology: {topology}
"""
    if args.falkordb_version:
        prompt += f"- FalkorDB Version: {args.falkordb_version}\n"
    if args.rdb_url:
        prompt += f"- RDB dump available: yes\n"
        prompt += f"  RDB URL: {args.rdb_url}\n"
    if args.aof_url:
        prompt += f"- AOF directory available: yes\n"
        prompt += f"  AOF URL: {args.aof_url}\n"

    prompt += f"""
**Topology Note:** {topology_note}

When querying metrics, use these label selectors:
- namespace="{args.namespace}"
- pod="{args.pod}"
- container="{args.container}" (for Redis metrics)

Start with Step 1: query the 7-day memory trend, then proceed through all steps.
"""
    return prompt


def _extract_report_field(report: str, field_name: str) -> str:
    """Extract a **Field:** value from the triage report markdown."""
    pattern = re.compile(rf'\*\*{re.escape(field_name)}:\*\*\s*(.+)', re.IGNORECASE)
    match = pattern.search(report)
    return match.group(1).strip() if match else ""


def _build_grafana_memory_url(grafana_base: str, namespace: str, pod: str,
                               from_ms: int, to_ms: int) -> str:
    """Grafana Explore URL showing container_memory_rss centred on the OOM time."""
    expr = f'container_memory_rss{{namespace="{namespace}", pod="{pod}"}}'
    params = {
        "orgId": "1",
        "left": json.dumps({
            "datasource": "VictoriaMetrics",
            "queries": [{"expr": expr, "refId": "A"}],
            "range": {"from": str(from_ms), "to": str(to_ms)},
        }),
    }
    return f"{grafana_base.rstrip('/')}/explore?{urlencode(params)}"


def _build_grafana_pods_url(grafana_base: str, namespace: str, pod: str,
                            cluster: str, from_ms: int, to_ms: int) -> str:
    """Kubernetes / Views / Pods dashboard centred on the OOM time."""
    params = {
        "orgId": "1",
        "from": str(from_ms),
        "to": str(to_ms),
        "var-cluster": cluster,
        "var-namespace": namespace,
        "var-pod": pod,
    }
    return f"{grafana_base.rstrip('/')}/d/k8s_views_pods/kubernetes-views-pods?{urlencode(params)}"


def _send_summary_to_chat(
    report: str,
    webhook_url: str,
    customer_name: str,
    customer_email: str,
    subscription_id: str,
    pod: str,
    namespace: str,
    cluster: str,
    container: str,
    grafana_memory_url: str,
    grafana_pods_url: str,
    timestamp: str,
    issue_number: int | None = None,
    issue_repo: str = "",
    is_recurring: bool = False,
    verify_ssl: bool = True,
):
    """Send AI triage summary to Google Chat.

    The full triage report is stored in the GitHub issue — the chat card
    includes the key diagnosis, evidence, and recommended action with a
    link to the full report.
    """

    # Extract key fields from the report
    category = html.escape(_extract_report_field(report, "Category") or "Unknown")
    confidence = html.escape(_extract_report_field(report, "Confidence") or "Unknown")
    likelihood = html.escape(_extract_report_field(report, "Likelihood") or "N/A")
    classification = html.escape(_extract_report_field(report, "Classification") or "N/A")

    # Extract the Recommended Action section (full section)
    recommended_action = ""
    action_match = re.search(
        r'###\s*Recommended Action\s*\n+(.+?)(?:\n###|\n##|\Z)',
        report, re.DOTALL | re.IGNORECASE,
    )
    if action_match:
        recommended_action = action_match.group(1).strip()
        if len(recommended_action) > 1500:
            recommended_action = recommended_action[:1497] + "..."
        recommended_action = html.escape(recommended_action)

    # Extract root cause evidence chain
    evidence_html = ""
    evidence_match = re.search(
        r'\*\*Evidence chain:\*\*\s*\n(.+?)(?:\n\n(?:Other|Additional|\*\*Confidence)|\Z)',
        report, re.DOTALL | re.IGNORECASE,
    )
    if evidence_match:
        raw = evidence_match.group(1).strip()
        # Take first 3 numbered points
        lines = []
        for line in raw.split('\n'):
            stripped = line.strip()
            if stripped and stripped[0].isdigit() and '.' in stripped[:3]:
                lines.append(stripped)
                if len(lines) >= 3:
                    break
        if lines:
            evidence_html = html.escape('\n'.join(lines))
            if len(evidence_html) > 500:
                evidence_html = evidence_html[:497] + "..."

    # Build issue URL
    issue_url = ""
    if issue_number and issue_repo:
        issue_url = f"https://github.com/{issue_repo}/issues/{issue_number}"

    if is_recurring:
        card_title = "🔁 Recurring OOM Triage"
        subtitle = f"Same instance OOM again — {customer_email}"
        text_prefix = f"🔁 Recurring OOM Triage — {pod} ({namespace}) {CHAT_MENTIONS}"
    else:
        card_title = "🤖 OOM Triage Complete"
        subtitle = f"Customer: {customer_email}"
        text_prefix = f"🤖 OOM Triage Complete — {pod} ({namespace}) {CHAT_MENTIONS}"

    sections = [
        {
            "widgets": [
                {"keyValue": {"topLabel": "Customer", "content": f"{customer_name} ({customer_email})"}},
                {"keyValue": {"topLabel": "Cluster", "content": cluster}},
                {"keyValue": {"topLabel": "Pod", "content": f"{pod} ({container})"}},
                {"keyValue": {"topLabel": "Namespace", "content": namespace}},
                {"keyValue": {"topLabel": "Diagnosis", "content": category}},
                {"keyValue": {"topLabel": "Confidence", "content": confidence}},
                {"keyValue": {"topLabel": "Recurrence", "content": likelihood}},
                {"keyValue": {"topLabel": "Pattern", "content": classification}},
            ]
        },
    ]

    # Evidence section
    if evidence_html:
        sections.append({
            "widgets": [{
                "textParagraph": {
                    "text": f"<b>Key Evidence:</b><br><code>{evidence_html}</code>",
                }
            }]
        })

    # Recommended action section
    if recommended_action:
        sections.append({
            "widgets": [{
                "textParagraph": {
                    "text": f"<b>Recommended Action:</b><br>{recommended_action}",
                }
            }]
        })

    # Buttons section
    buttons = []
    if issue_url:
        buttons.append({
            "textButton": {
                "text": f"View Issue #{issue_number}",
                "onClick": {"openLink": {"url": issue_url}},
            }
        })
    buttons.extend([
        {
            "textButton": {
                "text": "Memory Metrics",
                "onClick": {"openLink": {"url": grafana_memory_url}},
            }
        },
        {
            "textButton": {
                "text": "Pod Overview",
                "onClick": {"openLink": {"url": grafana_pods_url}},
            }
        },
    ])
    sections.append({"widgets": [{"buttons": buttons}]})

    payload = {
        "text": text_prefix,
        "cards": [{
            "header": {
                "title": card_title,
                "subtitle": subtitle,
            },
            "sections": sections,
        }],
    }

    try:
        response = requests.post(webhook_url, json=payload, timeout=30, verify=verify_ssl)
        response.raise_for_status()
        print("AI triage summary sent to Google Chat.")
    except requests.RequestException as e:
        print(f"⚠️  Failed to send AI triage summary to Google Chat: {e}", file=sys.stderr)


async def run_triage(args):
    """Run the AI OOM triage session."""
    triage_report = None

    client = CopilotClient()
    await client.start()
    try:
        session = await client.create_session(
            on_permission_request=PermissionHandler.approve_all,
            model="claude-opus-4.6",
            streaming=True,
            tools=ALL_TOOLS,
            system_message={
                "mode": "append",
                "content": SYSTEM_MESSAGE,
            },
        )
        done = asyncio.Event()
        messages = []
        streamed_chunks = []
        turn_active = False

        def on_event(event):
            nonlocal turn_active
            t = event.type.value
            print(f"  [{t}]", file=sys.stderr, flush=True)
            if t in ("assistant.message_delta", "assistant.streaming_delta"):
                delta = event.data.delta_content or ""
                streamed_chunks.append(delta)
                print(delta, end="", flush=True)
            elif t == "assistant.message":
                messages.append(event.data.content)
                print()
            elif t == "assistant.turn_start":
                turn_active = True
            elif t == "assistant.turn_end":
                turn_active = False
            elif t == "tool.execution_start":
                name = getattr(event.data, 'tool_name', '') or getattr(event.data, 'name', '') or ''
                print(f"🔧 Running tool: {name}", flush=True)
            elif t == "tool.execution_complete":
                name = getattr(event.data, 'tool_name', '') or getattr(event.data, 'name', '') or ''
                print(f"✅ Tool complete: {name}", flush=True)
            elif t == "session.idle":
                if not turn_active:
                    done.set()
            elif t == "session.error":
                print(f"Session error: {getattr(event.data, 'message', event.data)}", file=sys.stderr, flush=True)
                done.set()

        session.on(on_event)
        prompt = _build_initial_prompt(args)
        print(f"Sending OOM triage request for {args.pod} in {args.namespace}...")
        await session.send_and_wait(prompt)

        REPORT_HEADER = "## 🤖 AI OOM Triage Report"
        if messages:
            for msg in reversed(messages):
                if REPORT_HEADER in msg:
                    triage_report = msg
                    break
            else:
                triage_report = messages[-1]
        elif streamed_chunks:
            triage_report = "".join(streamed_chunks)
    finally:
        await client.stop()

    return triage_report


def main():
    parser = argparse.ArgumentParser(description="AI-powered OOM triage using Copilot SDK")
    parser.add_argument("--pod", required=True, help="Pod name")
    parser.add_argument("--namespace", required=True, help="Namespace / instance ID")
    parser.add_argument("--cluster", required=True, help="Cluster name")
    parser.add_argument("--container", default="service", help="Container name")
    parser.add_argument("--vmauth-url", required=True, help="VMAuth URL")
    parser.add_argument("--grafana-url", required=True, help="Grafana base URL")
    parser.add_argument("--customer-name", required=True, help="Customer name")
    parser.add_argument("--customer-email", required=True, help="Customer email")
    parser.add_argument("--subscription-id", required=True, help="Subscription ID")
    parser.add_argument("--rdb-url", default="", help="GCS path for dump.rdb")
    parser.add_argument("--aof-url", default="", help="GCS path for appendonlydir.tar.gz")
    parser.add_argument("--falkordb-version", default="", help="FalkorDB version")
    parser.add_argument("--alert-timestamp", default="", help="ISO timestamp of the OOM event (fallback: now)")
    parser.add_argument("--topology", default="", choices=["", "standalone", "replicated", "cluster"], help="Instance topology: standalone, replicated, or cluster")
    args = parser.parse_args()

    # Pass vmauth-url to tools via env
    os.environ.setdefault("VMAUTH_URL", args.vmauth_url)

    # Configure SSL
    environment = os.environ.get("ENVIRONMENT", "prod").lower()
    disable_ssl_verify = os.environ.get("DISABLE_SSL_VERIFY", "false").lower() == "true"
    verify_ssl = not (environment == "dev" or disable_ssl_verify)

    # Generate timestamp and Grafana links
    # Use alert timestamp if provided, else fall back to current time
    tz_israel = ZoneInfo("Asia/Jerusalem")
    if args.alert_timestamp:
        try:
            oom_dt = datetime.fromisoformat(args.alert_timestamp).astimezone(tz_israel)
        except (ValueError, TypeError):
            oom_dt = datetime.now(tz_israel)
    else:
        oom_dt = datetime.now(tz_israel)
    timestamp = oom_dt.strftime("%Y-%m-%d %H:%M:%S")
    oom_ts_ms = int(oom_dt.timestamp() * 1000)
    from_ms = oom_ts_ms - 10 * 60 * 1000
    to_ms = oom_ts_ms + 10 * 60 * 1000
    grafana_memory_url = _build_grafana_memory_url(args.grafana_url, args.namespace, args.pod, from_ms, to_ms)
    grafana_pods_url = _build_grafana_pods_url(args.grafana_url, args.namespace, args.pod, args.cluster, from_ms, to_ms)

    google_chat_webhook = os.environ.get("GOOGLE_CHAT_WEBHOOK_URL", "")

    # GitHub issue tracking (optional — gracefully skip if not configured)
    github_token = os.environ.get("ISSUE_GITHUB_TOKEN", "")
    issue_repo = os.environ.get("ISSUE_REPO", "")
    project_id = os.environ.get("PROJECT_ID")  # Optional project board ID

    try:
        report = asyncio.run(run_triage(args))
        if report:
            # Scrub PII and sensitive URLs before any output
            scrubbed_report = _scrub_report(report)
            print(f"\n{'='*60}")
            print("AI OOM Triage Report:")
            print(f"{'='*60}")
            print(scrubbed_report)
            print(f"{'='*60}")

            # --- GitHub issue tracking ---
            issue_number = None
            is_recurring = False
            if github_token and issue_repo:
                try:
                    github = GitHubIssueManager(github_token, issue_repo, project_id)

                    print("\n🔍 Searching for existing OOM issue...")
                    existing = github.find_existing_issue(
                        args.customer_email, args.namespace,
                    )

                    if existing:
                        is_recurring = True
                        issue_number = existing
                        github.add_comment(
                            issue_number=existing,
                            pod=args.pod,
                            namespace=args.namespace,
                            cluster=args.cluster,
                            container=args.container,
                            timestamp=timestamp,
                            report=report,
                            grafana_memory_url=grafana_memory_url,
                            grafana_pods_url=grafana_pods_url,
                        )
                    else:
                        issue_number = github.create_issue(
                            customer_name=args.customer_name,
                            customer_email=args.customer_email,
                            subscription_id=args.subscription_id,
                            pod=args.pod,
                            namespace=args.namespace,
                            cluster=args.cluster,
                            container=args.container,
                            timestamp=timestamp,
                            report=report,
                            grafana_memory_url=grafana_memory_url,
                            grafana_pods_url=grafana_pods_url,
                        )
                except Exception as e:
                    print(f"⚠️  GitHub issue creation failed (non-fatal): {e}", file=sys.stderr)
            else:
                print("⚠️  ISSUE_GITHUB_TOKEN or ISSUE_REPO not set, skipping issue creation", file=sys.stderr)

            # --- Google Chat summary (compact — full report lives in the issue) ---
            if google_chat_webhook:
                _send_summary_to_chat(
                    report=report,
                    webhook_url=google_chat_webhook,
                    customer_name=args.customer_name,
                    customer_email=args.customer_email,
                    subscription_id=args.subscription_id,
                    pod=args.pod,
                    namespace=args.namespace,
                    cluster=args.cluster,
                    container=args.container,
                    grafana_memory_url=grafana_memory_url,
                    grafana_pods_url=grafana_pods_url,
                    timestamp=timestamp,
                    issue_number=issue_number,
                    issue_repo=issue_repo,
                    is_recurring=is_recurring,
                    verify_ssl=verify_ssl,
                )
            else:
                print("⚠️  GOOGLE_CHAT_WEBHOOK_URL not set, skipping chat notification", file=sys.stderr)

            # Output for GitHub Actions
            github_output = os.environ.get("GITHUB_OUTPUT")
            if github_output:
                with open(github_output, "a") as f:
                    f.write(f"issue_number={issue_number or ''}\n")
                    f.write(f"is_recurring={str(is_recurring).lower()}\n")
        else:
            print("ERROR: No triage report generated", file=sys.stderr, flush=True)
            sys.exit(1)
    finally:
        cleanup()


if __name__ == "__main__":
    main()
