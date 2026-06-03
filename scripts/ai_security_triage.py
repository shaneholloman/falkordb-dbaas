#!/usr/bin/env python3
"""
AI Security Triage — periodic Copilot-driven review of SOC 2 evidence.

Runs on a weekly cron from `.github/workflows/ai-security-triage.yml`.
Mirrors `ai_crash_triage.py` but for security findings: pulls active alerts,
Wazuh findings, Grype CVEs, compliance FAILs, and asks Copilot (read-only
tools) to produce a prioritized remediation report. The report is posted as
a single GitHub issue. Humans review and act — the agent never modifies
infrastructure or merges anything.

Usage:
    python scripts/ai_security_triage.py --environment prod
"""

from __future__ import annotations

import argparse
import asyncio
import html
import json
import os
import re
import sys
from datetime import datetime, timezone

import requests
from copilot import CopilotClient, PermissionHandler

from security_triage_tools import (  # noqa: F401
    cleanup,
    fetch_compliance_failures,
    fetch_grype_findings,
    fetch_wazuh_alerts,
    list_open_security_issues,
    load_exceptions_evidence,
    lookup_cve,
    read_repo_file,
    search_repo_code,
    FetchComplianceFailuresParams,
    FetchGrypeFindingsParams,
    FetchWazuhAlertsParams,
)
from oom_handler import CHAT_MENTIONS

# Tools exposed to the agent. Data-collection tools are pre-fetched and
# injected into the prompt, so the agent only needs investigation tools.
INVESTIGATION_TOOLS = [
    lookup_cve,
    search_repo_code,
    read_repo_file,
    list_open_security_issues,
]

SYSTEM_MESSAGE = """\
You are a senior security engineer performing a weekly review of a Kubernetes
fleet's security posture. Your goal is ACTIONABLE remediation, not a wall of
data. You have STRICTLY READ-ONLY tools — you cannot apply fixes yourself.
A human will read your report and execute the changes.

The raw evidence (Grype findings, compliance FAILs, Wazuh hits) has
ALREADY been gathered and is provided in the user message as JSON
blocks. Do NOT ask for it — use what's there.

A fourth block, `exceptions`, lists configured suppressions:
  * `alert_exceptions` — Wazuh alerts intentionally dropped before
    Google Chat notification (matched by rule_id + field patterns).
  * `accepted_cves` — CVEs explicitly risk-accepted (will NOT trigger
    new alerts in the fleet).
NOTE: the `wazuh_alerts`, `grype_findings`, and `compliance_failures`
blocks have ALREADY been pre-filtered against these suppressions —
the count is reported as `suppressed_by_exceptions` /
`suppressed_by_accepted_cves` in each block. So if a CVE or rule
doesn't appear in the evidence, it's either not firing OR it's
suppressed (check the suppression list to disambiguate).
You should still cross-reference:
  - Do NOT re-raise findings that match a suppression as new issues.
  - If you see a CRITICAL/HIGH that you think is incorrectly suppressed
    (e.g. the suppression pattern is too broad), call it out in
    'Operational Gaps' so a human can review the rule.

The fleet has TWO planes:
  * **ctrl-plane** — the central control / observability clusters
    (`wazuh-manager-*`, `gke-observability-stack-*`).
  * **app-plane** — customer spoke clusters that run FalkorDB instances
    (`gke-c-<id>-*`, `aks-*-vmss*`).
Every evidence block includes a `by_plane` counter and per-finding
`planes` array. Findings affecting **app-plane** clusters generally
have higher blast radius (multi-tenant customer impact). Treat them
as higher priority than ctrl-plane-only findings of the same severity.

## Workflow

### Step 1: Read the evidence
- Parse the three JSON blocks in the user message:
  grype_findings, compliance_failures, wazuh_alerts.
- If any block contains an `"error"` key, treat that source as an
  Operational Gap and continue.

### Step 2: Prioritize
For each finding cluster, score on:
  - severity (critical > high > medium)
  - blast radius (how many clusters/images affected)
  - exploitability (network-reachable? auth required? known PoC?)
  - SOC 2 control impact (CC6.x / CC7.x / CC8.x)

### Step 3: Investigate the top items (use your tools here)
For the top 5–10 prioritized clusters:
  - Use `lookup_cve` to confirm severity and fixed-in version (for CVEs).
  - Use `search_repo_code` / `read_repo_file` to confirm the affected
    component is actually deployed and find where the image tag / config
    lives.
  - Use `list_open_security_issues` to avoid duplicates.

### Step 4: Propose fixes
For each top item, give a concrete fix, NOT generic advice:
  - "Bump argocd/kustomize/foo/kustomization.yaml line 42 from
     image:1.2.3 → image:1.2.4 (fixes CVE-XXXX-YYYY)"
  - "Add cve:CVE-2024-XXXX to argocd/kustomize/wazuh-rules/wazuh-cdb-lists.yaml
     (accepted-cves) with a justification comment, because the package isn't
     reachable from network ingress."
  - "Apply NetworkPolicy denying egress from namespace X to fix Prowler
     check.5.4.1 — example manifest below."

Each fix MUST include: WHAT to change, WHERE (file path + line if applicable),
WHY it resolves the finding, and a CONFIDENCE rating (high/medium/low).

### Step 5: Output the report
Output EXACTLY this structure (Markdown):

```
## 🛡️ AI Security Triage — {date}

### Summary
- **Wazuh security alerts:** N firing (X critical, Y warning)
- **Open Grype findings:** N CVEs across M images
- **Open compliance FAILs:** N controls (X SOC 2 CC-mapped)
- **Plane breakdown:** ctrl-plane: N events / app-plane: M events
- **Operational gaps:** [Wazuh/Grype/Prowler scanner status]

### Top Findings (Prioritized)

#### 1. [CRITICAL] <one-line title>
- **Affected:** <images / clusters / namespaces>
- **Planes:** ctrl-plane | app-plane | both
- **SOC 2 controls:** <CC6.1, CC7.2, …>
- **Evidence:** <CVE / Wazuh rule.id / Prowler check>
- **Proposed Fix:** <WHAT + WHERE>
- **Confidence:** high|medium|low
- **Why it matters:** <one paragraph>

#### 2. [HIGH] …
…

### Operational Gaps
[Scanner staleness, broken dashboards, missing CDB entries — separately
from findings, since these are infra issues, not vulns.]

### Duplicates / Already Tracked
[Findings that match an existing open security issue — link them.]

### Recommended Manual Actions This Week
1. <one-liner>
2. <one-liner>
…
```

## Hard rules
- DO NOT ask for the data sources to be re-fetched — they are already
  in the user message. The `fetch_*` tools are NOT available.
- DO NOT call any tool not in your tool list.
- DO NOT fabricate CVE numbers, file paths, or line numbers — verify with
  `lookup_cve` / `search_repo_code` / `read_repo_file` first.
- Cap the report at ~10 top findings — quality over quantity.
- The final assistant message MUST start with the literal header
  `## 🛡️ AI Security Triage — {date}` and contain the full report.
"""


async def _gather_evidence() -> dict[str, str]:
    """Pre-fetch the three security data sources sequentially.

    Each value is a JSON string (already serialised by the tool function),
    or a JSON `{"error": "..."}` string if the call raised.

    Sequential (not concurrent) to avoid overwhelming the nginx TCP
    passthrough to the Wazuh Indexer with parallel SSL handshakes.
    """
    import json as _json

    async def _safe(name: str, coro):
        try:
            return await coro
        except Exception as e:  # noqa: BLE001
            return _json.dumps({"error": f"{type(e).__name__}: {e}"})

    results: dict[str, str] = {}
    results["exceptions"] = load_exceptions_evidence()
    results["grype_findings"] = await _safe(
        "grype_findings",
        fetch_grype_findings(
            FetchGrypeFindingsParams(severity="critical,high", days=7)),
    )
    results["compliance_failures"] = await _safe(
        "compliance_failures",
        fetch_compliance_failures(
            FetchComplianceFailuresParams(framework="all", days=7)),
    )
    results["wazuh_alerts"] = await _safe(
        "wazuh_alerts",
        fetch_wazuh_alerts(
            FetchWazuhAlertsParams(
                rule_groups="soc2_critical,soc2_high",
                min_level=10,
                days=7,
            )),
    )
    return results


def _build_initial_prompt(
    args: argparse.Namespace, evidence: dict[str, str]
) -> str:
    return f"""
Run the weekly security triage for environment **{args.environment}**.

Today's date: {datetime.now(timezone.utc).strftime('%Y-%m-%d')}.

The three security data sources have already been collected for you
below, along with the active suppression lists. Use `lookup_cve`,
`search_repo_code`, `read_repo_file`, and `list_open_security_issues`
to investigate the top findings, then output the final Markdown report
per the system message.

### exceptions
```json
{evidence['exceptions']}
```

### grype_findings
```json
{evidence['grype_findings']}
```

### compliance_failures
```json
{evidence['compliance_failures']}
```

### wazuh_alerts
```json
{evidence['wazuh_alerts']}
```
"""


def _post_report_to_issue(
    report: str, repo: str, environment: str
) -> tuple[str | None, int | None]:
    """Open a new GitHub issue with the triage report.

    Returns (issue_url, issue_number) or (None, None) on failure.
    """
    token = os.environ.get("PRIVATE_REPO_TOKEN") or os.environ.get("GITHUB_TOKEN", "")
    if not token:
        print("WARNING: no token set, printing report to stdout", file=sys.stderr)
        print(report)
        return None, None
    title = (
        f"[security-triage] Weekly security review — {environment} — "
        f"{datetime.now(timezone.utc).strftime('%Y-%m-%d')}"
    )
    body = (
        f"_Generated automatically by `.github/workflows/ai-security-triage.yml`._\n\n"
        f"{report}\n\n"
        f"---\n"
        f"_All proposed fixes are advisory. A human must review and apply them._"
    )
    resp = requests.post(
        f"https://api.github.com/repos/{repo}/issues",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github.v3+json",
        },
        json={
            "title": title,
            "body": body,
            "labels": ["security", "ai-triage", "soc2", environment],
        },
        timeout=30,
    )
    if resp.status_code == 201:
        data = resp.json()
        issue_url = data.get("html_url")
        issue_number = data.get("number")
        print(f"Triage issue created: {issue_url}")
        return issue_url, issue_number
    print(
        f"ERROR: failed to create issue (HTTP {resp.status_code}): "
        f"{resp.text[:500]}",
        file=sys.stderr,
    )
    print(report)
    return None, None


def _extract_report_field(report: str, field_name: str) -> str:
    """Extract a **Field:** value from the triage report markdown."""
    pattern = re.compile(rf"\*\*{re.escape(field_name)}:\*\*\s*(.+)", re.IGNORECASE)
    m = pattern.search(report)
    return m.group(1).strip() if m else ""


def _extract_summary_counts(report: str) -> dict[str, str]:
    """Pull the four bullet values out of the '### Summary' section."""
    out: dict[str, str] = {
        "alerts": "n/a",
        "grype": "n/a",
        "compliance": "n/a",
        "planes": "n/a",
        "ops_gaps": "n/a",
    }
    # Map legacy key to new label for backward-compat in callers.
    sm = re.search(
        r"^###\s+Summary\s*$(.*?)(?=^###\s+|\Z)",
        report,
        flags=re.MULTILINE | re.DOTALL,
    )
    if not sm:
        return out
    block = sm.group(1)
    patterns = {
        "alerts": r"\*\*(?:Wazuh|Active) security alerts:\*\*\s*(.+)",
        "grype": r"\*\*Open Grype findings:\*\*\s*(.+)",
        "compliance": r"\*\*Open compliance FAILs:\*\*\s*(.+)",
        "planes": r"\*\*Plane breakdown:\*\*\s*(.+)",
        "ops_gaps": r"\*\*Operational gaps:\*\*\s*(.+)",
    }
    for key, pat in patterns.items():
        m = re.search(pat, block)
        if m:
            out[key] = m.group(1).strip()
    return out


def _extract_top_findings(report: str, limit: int = 3) -> list[tuple[str, str]]:
    """Return list of (severity, title) for the first `limit` top findings."""
    results: list[tuple[str, str]] = []
    for m in re.finditer(
        r"^####\s+\d+\.\s+\[([A-Z]+)\]\s+(.+)$",
        report,
        flags=re.MULTILINE,
    ):
        results.append((m.group(1), m.group(2).strip()))
        if len(results) >= limit:
            break
    return results


def _extract_findings_breakdown(report: str) -> tuple[int, str]:
    """Return (total_count, 'X critical, Y high, ...') over ALL top findings."""
    sev_counts: dict[str, int] = {}
    for m in re.finditer(r"^####\s+\d+\.\s+\[([A-Z]+)\]", report, flags=re.MULTILINE):
        sev = m.group(1)
        sev_counts[sev] = sev_counts.get(sev, 0) + 1
    total = sum(sev_counts.values())
    if not total:
        return 0, "0"
    order = ["CRITICAL", "HIGH", "MEDIUM", "LOW"]
    parts = [
        f"{sev_counts[s]} {s.lower()}" for s in order if s in sev_counts
    ]
    parts.extend(
        f"{n} {s.lower()}" for s, n in sev_counts.items() if s not in order
    )
    return total, ", ".join(parts)


def _post_summary_to_google_chat(
    report: str,
    environment: str,
    issue_url: str | None,
    issue_number: int | None,
) -> None:
    """Send a Google Chat card mirroring the OOM triage card style."""
    webhook = os.environ.get("GOOGLE_CHAT_WEBHOOK_URL", "").strip()
    if not webhook:
        print("INFO: GOOGLE_CHAT_WEBHOOK_URL not set, skipping Google Chat notification")
        return

    date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    counts = _extract_summary_counts(report)
    total_findings, breakdown = _extract_findings_breakdown(report)
    top = _extract_top_findings(report, limit=3)

    # Extract the Recommended Manual Actions This Week section
    recommended_action = ""
    am = re.search(
        r"###\s*Recommended Manual Actions[^\n]*\n+(.+?)(?:\n###|\n##|\Z)",
        report,
        flags=re.DOTALL | re.IGNORECASE,
    )
    if am:
        recommended_action = am.group(1).strip()
        if len(recommended_action) > 1500:
            recommended_action = recommended_action[:1497] + "..."
        recommended_action = html.escape(recommended_action)

    card_title = "🛡️ AI Security Triage"
    subtitle = f"Weekly review — {environment} — {date_str}"
    text_prefix = f"🛡️ AI Security Triage — {environment} {CHAT_MENTIONS}"

    sections: list[dict] = [
        {
            "widgets": [
                {"keyValue": {"topLabel": "Environment", "content": environment}},
                {"keyValue": {"topLabel": "Date", "content": date_str}},
                {"keyValue": {
                    "topLabel": "Wazuh security alerts",
                    "content": counts["alerts"],
                }},
                {"keyValue": {
                    "topLabel": "Grype findings",
                    "content": counts["grype"],
                }},
                {"keyValue": {
                    "topLabel": "Compliance FAILs",
                    "content": counts["compliance"],
                }},
                {"keyValue": {
                    "topLabel": "Plane breakdown",
                    "content": counts["planes"],
                }},
                {"keyValue": {
                    "topLabel": "Operational gaps",
                    "content": counts["ops_gaps"],
                }},
                {"keyValue": {
                    "topLabel": "Top findings",
                    "content": (
                        f"{total_findings} ({breakdown})" if total_findings
                        else "0"
                    ),
                }},
            ]
        }
    ]

    # Top findings (titles only)
    if top:
        lines = [
            f"<b>[{html.escape(sev)}]</b> {html.escape(title)}"
            for sev, title in top
        ]
        sections.append({
            "widgets": [{
                "textParagraph": {
                    "text": "<b>Highest-priority findings:</b><br>" +
                            "<br>".join(lines),
                }
            }]
        })

    # Recommended actions
    if recommended_action:
        sections.append({
            "widgets": [{
                "textParagraph": {
                    "text": f"<b>Recommended Actions This Week:</b><br>"
                            f"{recommended_action}",
                }
            }]
        })

    # Buttons
    buttons = []
    if issue_url:
        label = (
            f"View Issue #{issue_number}" if issue_number else "View Full Report"
        )
        buttons.append({
            "textButton": {
                "text": label,
                "onClick": {"openLink": {"url": issue_url}},
            }
        })
    if buttons:
        sections.append({"widgets": [{"buttons": buttons}]})

    payload = {
        "text": text_prefix,
        "cards": [{
            "header": {"title": card_title, "subtitle": subtitle},
            "sections": sections,
        }],
    }

    try:
        resp = requests.post(webhook, json=payload, timeout=30)
        resp.raise_for_status()
        print("AI security triage summary sent to Google Chat.")
    except requests.RequestException as e:
        print(
            f"WARNING: failed to send Google Chat summary: {e}",
            file=sys.stderr,
        )


async def run_triage(args: argparse.Namespace) -> str | None:
    triage_report: str | None = None

    print("Gathering evidence (pre-fetching data sources)...")
    evidence = await _gather_evidence()
    failed: list[str] = []
    for name, payload in evidence.items():
        size = len(payload)
        head = payload.lstrip()[:80].replace("\n", " ")
        print(f"  - {name}: {size} bytes — {head}")
        # An "error" key at the top of the JSON marks a failed fetch.
        try:
            parsed = json.loads(payload)
        except (ValueError, TypeError):
            parsed = None
        if isinstance(parsed, dict) and "error" in parsed:
            failed.append(f"{name}: {parsed['error']}")
    if failed:
        msg = "ERROR: failed to gather evidence:\n  - " + "\n  - ".join(failed)
        print(msg, file=sys.stderr)
        raise RuntimeError(msg)

    client = CopilotClient()
    await client.start()
    try:
        session = await client.create_session({
            "on_permission_request": PermissionHandler.approve_all,
            "model": "claude-opus-4.6",
            "streaming": True,
            "tools": INVESTIGATION_TOOLS,
            "system_message": {"mode": "append", "content": SYSTEM_MESSAGE},
        })
        done = asyncio.Event()
        messages: list[str] = []
        streamed_chunks: list[str] = []
        turn_active = False

        def on_event(event):
            nonlocal turn_active
            t = event.type.value
            print(f"  [{t}]", file=sys.stderr, flush=True)
            if t == "assistant.message_delta":
                delta = getattr(event.data, "delta_content", "") or ""
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
                name = (getattr(event.data, "tool_name", "")
                        or getattr(event.data, "name", "") or "")
                print(f"🔧 {name}", flush=True)
            elif t == "tool.execution_complete":
                name = (getattr(event.data, "tool_name", "")
                        or getattr(event.data, "name", "") or "")
                print(f"✅ {name}", flush=True)
            elif t == "session.idle" and not turn_active:
                done.set()
            elif t == "session.error":
                print(
                    f"Session error: "
                    f"{getattr(event.data, 'message', event.data)}",
                    file=sys.stderr, flush=True,
                )
                done.set()

        session.on(on_event)
        prompt = _build_initial_prompt(args, evidence)
        print(f"Starting security triage for {args.environment}...")
        await session.send_and_wait({"prompt": prompt})

        REPORT_HEADER = "## 🛡️ AI Security Triage"
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment", required=True, choices=["dev", "prod"])
    parser.add_argument(
        "--issue-repo", default=os.environ.get("ISSUE_REPO", "FalkorDB/falkordb-dbaas"),
        help="owner/repo to file the triage issue against.",
    )
    args = parser.parse_args()

    try:
        report = asyncio.run(run_triage(args))
    except RuntimeError as e:
        # Evidence-gathering failure — fail fast without filing a report.
        print(f"ERROR: {e}", file=sys.stderr)
        cleanup()
        return 2
    finally:
        cleanup()

    if not report:
        print("ERROR: triage produced no report", file=sys.stderr)
        return 1
    issue_url, issue_number = _post_report_to_issue(
        report, args.issue_repo, args.environment
    )
    _post_summary_to_google_chat(
        report, args.environment, issue_url, issue_number
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
