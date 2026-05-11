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
import os
import sys
from datetime import datetime, timezone

import requests
from copilot import CopilotClient, SubprocessConfig
from copilot.session import PermissionHandler

from security_triage_tools import ALL_TOOLS, cleanup  # noqa: F401

SYSTEM_MESSAGE = """\
You are a senior security engineer performing a weekly review of a Kubernetes
fleet's security posture. Your goal is ACTIONABLE remediation, not a wall of
data. You have STRICTLY READ-ONLY tools — you cannot apply fixes yourself.
A human will read your report and execute the changes.

## Workflow

### Step 1: Survey the firing alerts
- Call `fetch_active_alerts` (team=security) to see what's broken right now.
- Note operational gaps (scanners stale/down, dashboards offline, etc.).

### Step 2: Categorize findings
- Call `fetch_grype_findings` for image vulnerabilities (critical+high).
- Call `fetch_compliance_failures` for Prowler / kube-bench / KubeScape FAILs.
- Call `fetch_wazuh_alerts` (rule_groups='soc2_critical,soc2_high', min_level=10)
  for high-severity Wazuh hits.

### Step 3: Prioritize
For each finding cluster, score on:
  - severity (critical > high > medium)
  - blast radius (how many clusters/images affected)
  - exploitability (network-reachable? auth required? known PoC?)
  - SOC 2 control impact (CC6.x / CC7.x / CC8.x)

### Step 4: Investigate the top items
For the top 5–10 prioritized clusters:
  - Use `lookup_cve` to confirm severity and fixed-in version (for CVEs).
  - Use `search_repo_code` / `read_repo_file` to confirm the affected component
    is actually deployed and find where the image tag / config lives.
  - Use `list_open_security_issues` to avoid duplicates.

### Step 5: Propose fixes
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

### Step 6: Output the report
Output EXACTLY this structure (Markdown):

```
## 🛡️ AI Security Triage — {date}

### Summary
- **Active security alerts:** N firing (X critical, Y warning)
- **Open Grype findings:** N CVEs across M images
- **Open compliance FAILs:** N controls (X SOC 2 CC-mapped)
- **Operational gaps:** [Wazuh/Grype/Prowler scanner status]

### Top Findings (Prioritized)

#### 1. [CRITICAL] <one-line title>
- **Affected:** <images / clusters / namespaces>
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
- DO NOT call any tool not in your tool list.
- DO NOT fabricate CVE numbers, file paths, or line numbers — verify with
  `lookup_cve` / `search_repo_code` / `read_repo_file` first.
- If a tool returns an error, note it in "Operational Gaps" and continue.
- Cap the report at ~10 top findings — quality over quantity.
"""


def _build_initial_prompt(args: argparse.Namespace) -> str:
    return f"""
Run the weekly security triage for environment **{args.environment}**.

Today's date: {datetime.now(timezone.utc).strftime('%Y-%m-%d')}.

Start with Step 1 (fetch_active_alerts) and proceed through all steps.
"""


def _post_report_to_issue(report: str, repo: str, environment: str) -> None:
    """Open a new GitHub issue with the triage report."""
    token = os.environ.get("PRIVATE_REPO_TOKEN") or os.environ.get("GITHUB_TOKEN", "")
    if not token:
        print("WARNING: no token set, printing report to stdout", file=sys.stderr)
        print(report)
        return
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
        print(f"Triage issue created: {resp.json().get('html_url')}")
    else:
        print(
            f"ERROR: failed to create issue (HTTP {resp.status_code}): "
            f"{resp.text[:500]}",
            file=sys.stderr,
        )
        print(report)


async def run_triage(args: argparse.Namespace) -> str | None:
    triage_report: str | None = None
    github_token = os.environ.get("GITHUB_TOKEN", "")

    async with CopilotClient(SubprocessConfig(github_token=github_token)) as client:
        async with await client.create_session(
            on_permission_request=PermissionHandler.approve_all,
            model="claude-opus-4.6",
            streaming=True,
            tools=ALL_TOOLS,
            system_message={"mode": "append", "content": SYSTEM_MESSAGE},
        ) as session:
            done = asyncio.Event()
            messages: list[str] = []
            streamed_chunks: list[str] = []
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
            prompt = _build_initial_prompt(args)
            print(f"Starting security triage for {args.environment}...")
            await session.send(prompt)
            await done.wait()

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
    finally:
        cleanup()

    if not report:
        print("ERROR: triage produced no report", file=sys.stderr)
        return 1
    _post_report_to_issue(report, args.issue_repo, args.environment)
    return 0


if __name__ == "__main__":
    sys.exit(main())
