# Multi-Cloud Security & SOC 2 Evidence Engine

Hub-spoke security monitoring architecture providing continuous compliance scanning, host-level intrusion detection, and runtime vulnerability analysis across all FalkorDB cloud environments.

## Architecture Overview

```
                          ┌─────────────────────────────────────────────┐
                          │         GCP Control Plane (Hub)             │
                          │                                             │
                          │  ┌─────────────┐                           │
                          │  │   Wazuh      │                           │
                          │  │   Manager    │                           │
                          │  │  (Helm)      │                           │
                          │  │  :1514 mTLS  │                           │
                          │  └──────┬───────┘                           │
                          │         │                                   │
                          │  ┌──────┴──────────────────────────────┐   │
                          │  │        GCS Evidence Locker           │   │
                          │  │  gs://falkordb-evidence-locker-*     │   │
                          │  │  (Prowler reports, Wazuh exports)    │   │
                          │  └─────────────────────────────────────┘   │
                          └────────────────┬───────────────────────────┘
                                           │
               ┌───────────────────────────┼───────────────────────────┐
               │                           │                           │
    ┌──────────▼──────────┐    ┌───────────▼─────────┐    ┌───────────▼─────────┐
    │   GCP Spoke Cluster  │    │  AWS Spoke Cluster   │    │ Azure Spoke Cluster  │
    │                      │    │                      │    │                      │
    │  ● Wazuh Agent (DS)  │    │  ● Wazuh Agent (DS)  │    │  ● Wazuh Agent (DS)  │
    │  ● Prowler (CJ)     │    │  ● Prowler (CJ)     │    │  ● Prowler (CJ)     │
    │   (Workload Identity) │    │    (IRSA + GCS key)  │    │    (SP + GCS key)    │
    └──────────────────────┘    └──────────────────────┘    └──────────────────────┘
```

## Components

| Component | Type | Version | Purpose |
|-----------|------|---------|---------|
| **Wazuh Manager** | Helm chart | 4.14.1 | Central SIEM — receives agent events, runs FIM, vulnerability detection |
| **Wazuh Agent** | DaemonSet | 4.11.1 | Host-level log collection, file integrity monitoring, rootkit detection |
| **Wazuh Custom Rules** | ConfigMap | — | SOC 2 rules: Prowler/Grype/Falco/TruffleHog/KubeBench/KubeScape detection |
| **Prowler** | CronJob | 4.6.1 | Cloud security posture (SOC 2 / CIS compliance), daily at 02:00 UTC |
| **Grype** | CronJob | — | Container image CVE scanning, results forwarded to Wazuh |
| **Kube-bench** | CronJob | — | CIS Kubernetes benchmark scanning |
| **Kubescape** | CronJob | — | MITRE ATT&CK + NSA hardening assessment |
| **TruffleHog** | CronJob | — | Secret leak detection in container images |
| **Falco** | DaemonSet | — | Runtime threat detection (syscall monitoring), alerts to Wazuh |
| **Kyverno** | Admission Controller | — | Pod security policies (privileged container prevention) |
| **GCS Evidence Locker** | GCS bucket | — | Centralized storage for all compliance artifacts |
| **VMRule alerts** | VMRule CRD | — | VictoriaMetrics alerts for component health (24 alerts) |
| **Grafana dashboard** | ConfigMap | — | SOC 2 Compliance overview dashboard |
| **Wazuh dashboards** | Saved Objects | — | 10 security dashboards (SOC 2, PCI DSS, NIST, MITRE, etc.) |
| **AI Security Triage** | GitHub Actions | — | Weekly Copilot-driven review of security findings + remediation proposals |

## Namespace

All security workloads run in the **`security`** namespace on every cluster.

## File Layout

```
tofu/
  runtime/gcp/infra/security.tf          # Wazuh IP, GCS bucket, Prowler SA, firewall
  runtime/gcp/infra/gke.tf               # Node pools: security (spot, CronJobs), security-infra (Kyverno/SealedSecrets)
  org/aws/org/prowler.tf                 # AWS IAM role for Prowler
  runtime/azure/prowler.tf               # Azure AD service principal for Prowler (auto-rotating)

argocd/
  apps/ctrl-plane/{dev,prod}/
    wazuh.yaml                           # Wazuh Manager Application
    wazuh-rules.yaml                     # Custom rules Application
    wazuh-agent.yaml                     # Ctrl-plane Wazuh Agent Application
    falco.yaml                           # Falco Application
    grype.yaml                           # Grype Application
    kube-bench.yaml                      # Kube-bench Application
    kubescape.yaml                       # Kubescape Application
    trufflehog.yaml                      # TruffleHog Application
    kyverno.yaml / kyverno-policies.yaml # Kyverno + policies
    compliance-report.yaml               # Compliance Report CronJob
  apps/app-plane/{dev,prod}/
    prowler.yaml                         # Prowler ApplicationSet (spoke clusters)
    wazuh-agent.yaml                     # Wazuh Agent ApplicationSet (spoke clusters)
    falco.yaml                           # Falco ApplicationSet
    grype.yaml                           # Grype ApplicationSet
    kube-bench.yaml                      # Kube-bench ApplicationSet
    kubescape.yaml                       # Kubescape ApplicationSet
    trufflehog.yaml                      # TruffleHog ApplicationSet
    kyverno-policies.yaml                # Kyverno policies ApplicationSet
  kustomize/
    prowler/                             # CronJob + 8 overlays (cloud × env)
    grype/                               # CronJob + 8 overlays
    kube-bench/                          # CronJob + 8 overlays
    kubescape/                           # CronJob + 8 overlays
    trufflehog/                          # CronJob + 8 overlays
    falco/                               # DaemonSet config
    kyverno-policies/                    # ClusterPolicy manifests
    wazuh-agent/                         # DaemonSet + 4 overlays (plane × env)
    wazuh-rules/                         # Custom rules + dashboard saved objects
    compliance-report/                   # Evidence aggregation CronJob

observability/
  rules/soc2-security.rules.yml          # VMRule alerts (24 alerts, 8 groups)
  rules/tests/soc2-security.test.yml     # promtool unit tests
  grafana/dashboards/soc2-compliance.json # Grafana dashboard

.github/workflows/
  ai-security-triage.yml                 # Weekly Copilot security triage

scripts/
  ai_security_triage.py                  # Copilot-driven security review
  security_triage_tools.py               # Read-only tools for AI triage
  generate_compliance_report.sh          # On-demand evidence collection
```

## Documentation

| Document | Description |
|----------|-------------|
| [Deployment Runbook](deployment-runbook.md) | Step-by-step first-time deployment procedure |
| [Operations Guide](operations-guide.md) | Day-to-day operations, troubleshooting, maintenance |
| [Alert Runbook](alert-runbook.md) | Response procedures for each SOC 2 alert |

## Quick Links

| Resource | Dev URL | Prod URL |
|----------|---------|----------|
| Wazuh Dashboard | `wazuh.security.dev.internal.falkordb.cloud` | `wazuh.security.internal.falkordb.cloud` |
| Grafana SOC 2 Dashboard | Grafana → Dashboards → SOC 2 Compliance | Same |
| GCS Evidence Locker | `gs://falkordb-evidence-locker-<suffix>` | Same naming |
