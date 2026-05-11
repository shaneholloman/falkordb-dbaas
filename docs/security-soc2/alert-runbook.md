# Alert Runbook — SOC 2 Security Alerts

Response procedures for each VMRule alert defined in `observability/rules/soc2-security.rules.yml`.

All alerts route through VictoriaMetrics → Alertmanager → PagerDuty / Google Chat.

---

## Prowler Alerts

### ProwlerScanFailing

| Field | Value |
|-------|-------|
| **Severity** | warning |
| **Fires when** | Prowler CronJob has failed runs for >30 minutes |
| **Expression** | `kube_job_status_failed{job_name=~"prowler-soc2-scan-.*"} > 0` |
| **Impact** | SOC 2 evidence collection is degraded. Missing compliance data for the day. |

**Response:**

1. Check the failed Job logs:
   ```bash
   kubectl get jobs -n security -l app=prowler --sort-by=.metadata.creationTimestamp | tail -5
   FAILED_JOB=$(kubectl get jobs -n security -l app=prowler --field-selector status.successful=0 -o name | tail -1)
   kubectl logs $FAILED_JOB -n security
   ```

2. Common causes:
   - **Cloud credential error**: Check the relevant secret (`prowler-aws-credentials`, `prowler-azure-credentials`, `prowler-gcs-credentials`)
   - **GCS upload error**: For GCP clusters, verify Workload Identity binding. For AWS/Azure, check `GOOGLE_APPLICATION_CREDENTIALS` mount.
   - **OOMKilled**: Increase memory limit in `cronjob.yaml` (current: 1Gi)
   - **Timeout (>2h)**: Large cloud accounts may exceed the deadline. Increase `activeDeadlineSeconds` or scope Prowler to specific services.

3. Trigger a manual retry:
   ```bash
   kubectl create job --from=cronjob/prowler-soc2-scan prowler-retry -n security
   ```

4. **SOC 2 implication**: If the scan cannot be fixed within 24 hours, document the gap. The `ProwlerScanStale` alert will fire after 48h with no successful run.

---

### ProwlerScanStale

| Field | Value |
|-------|-------|
| **Severity** | warning |
| **Fires when** | No successful Prowler scan in over 48 hours |
| **Expression** | `time() - max(kube_cronjob_status_last_successful_time{cronjob="prowler-soc2-scan"}) > 172800` |
| **Impact** | Compliance evidence is stale. Auditors expect daily scans. |

**Response:**

1. Check if the CronJob is suspended:
   ```bash
   kubectl get cronjob prowler-soc2-scan -n security -o jsonpath='{.spec.suspend}'
   ```
   If `true`, unsuspend: `kubectl patch cronjob prowler-soc2-scan -n security -p '{"spec":{"suspend":false}}'`

2. Check if recent Jobs exist but are still running:
   ```bash
   kubectl get jobs -n security -l app=prowler --sort-by=.metadata.creationTimestamp | tail -5
   ```

3. If no Jobs exist, the CronJob scheduler may be broken. Check kube-controller-manager logs.

4. Trigger a manual run:
   ```bash
   kubectl create job --from=cronjob/prowler-soc2-scan prowler-catchup -n security
   ```

5. **SOC 2 implication**: Document the outage period. Generate a backdated report once scanning resumes.

---

### ProwlerCronJobSuspended

| Field | Value |
|-------|-------|
| **Severity** | warning |
| **Fires when** | Prowler CronJob has `suspend: true` for >1 hour |
| **Expression** | `kube_cronjob_spec_suspend{cronjob="prowler-soc2-scan"} == 1` |
| **Impact** | Compliance scanning is intentionally stopped. No new evidence will be collected. |

**Response:**

1. Determine who suspended the CronJob and why (check ArgoCD sync history, git log)
2. If it was suspended for maintenance, ensure a plan to re-enable
3. Unsuspend:
   ```bash
   kubectl patch cronjob prowler-soc2-scan -n security -p '{"spec":{"suspend":false}}'
   ```

---

## Wazuh Alerts

### WazuhManagerDown

| Field | Value |
|-------|-------|
| **Severity** | critical |
| **Fires when** | Wazuh Manager is unreachable for >5 minutes |
| **Expression** | `up{job="wazuh-manager"} == 0` |
| **Impact** | **All agent communication is interrupted.** No security events are being collected from any cluster. FIM, vulnerability detection, and log analysis are all offline. |

**Response:**

1. Check Manager pod status:
   ```bash
   kubectl get pods -n security -l app=wazuh-manager
   kubectl describe pod -n security -l app=wazuh-manager
   ```

2. Check Manager logs:
   ```bash
   kubectl logs -n security -l app=wazuh-manager --tail=100
   ```

3. Common causes:
   - **Pod eviction**: Check node resource pressure. The Manager runs on the `security` node pool.
   - **Disk full**: Check Indexer PVC usage. Wazuh stores event indices.
   - **OOM**: Check if the container was OOMKilled. Increase memory limits.
   - **Node pool scaling**: If the security node pool scaled to 0, it may take time to scale back up.

4. If pod is stuck, try a restart:
   ```bash
   kubectl rollout restart deployment/wazuh-manager -n security  # or statefulset
   ```

5. **SOC 2 implication**: This is a **critical gap**. Document the outage duration. Agents buffer events locally and will forward them when the Manager recovers.

---

### WazuhAgentDaemonSetUnavailable

| Field | Value |
|-------|-------|
| **Severity** | warning |
| **Fires when** | Wazuh Agent DaemonSet has unavailable pods for >15 minutes |
| **Expression** | `kube_daemonset_status_number_unavailable{daemonset="wazuh-agent"} > 0` |
| **Impact** | Some nodes are not being monitored. Security coverage gap on those hosts. |

**Response:**

1. Identify which nodes are missing agents:
   ```bash
   kubectl get ds wazuh-agent -n security
   kubectl get pods -n security -l app=wazuh-agent -o wide | grep -v Running
   ```

2. Check pod events on failing nodes:
   ```bash
   kubectl describe pod <POD_NAME> -n security
   ```

3. Common causes:
   - **Node pressure**: Agent pod evicted due to resource pressure (DaemonSet has low priority)
   - **Image pull failure**: Check if `opennix/wazuh-agent:4.11.1` is pullable
   - **Enrollment failure**: Agent can't register with Manager (check `wazuh-agent-key` secret)
   - **New node with taints**: The DaemonSet has `operator: Exists` tolerations; this shouldn't happen unless custom taints were added after deployment

---

### WazuhAgentDaemonSetMisscheduled

| Field | Value |
|-------|-------|
| **Severity** | warning |
| **Fires when** | Wazuh Agent pods are scheduled on unexpected nodes for >15 minutes |
| **Expression** | `kube_daemonset_status_number_misscheduled{daemonset="wazuh-agent"} > 0` |
| **Impact** | Agents are running on nodes where they shouldn't be. Investigate scheduling. |

**Response:**

1. Check which nodes have misscheduled pods:
   ```bash
   kubectl get pods -n security -l app=wazuh-agent -o wide
   ```

2. This usually indicates a node selector or affinity mismatch. The Wazuh Agent DaemonSet does **not** have a nodeSelector (intentionally runs on all nodes). If misscheduled pods appear, check if node taints/labels have changed.

---

## Grype Alerts

### GrypeScanFailing

| Field | Value |
|-------|-------|
| **Severity** | warning |
| **Fires when** | Grype CronJob has failed runs for >30 minutes |
| **Expression** | `kube_job_status_failed{job_name=~"grype-cve-scan-.*"} > 0` |
| **Impact** | Container image CVE scanning is degraded. New vulnerabilities won't be detected. |

**Response:**

1. Check the failed Job logs:
   ```bash
   FAILED_JOB=$(kubectl get jobs -n security -l app=grype --field-selector status.successful=0 -o name | tail -1)
   kubectl logs $FAILED_JOB -n security
   ```

2. Common causes:
   - **Registry auth failure**: Check image pull secret or Workload Identity binding
   - **OOMKilled**: Increase memory limit — large images can exhaust the scanner
   - **GCS upload failure**: Check `prowler-gcs-credentials` / Workload Identity for evidence locker access

3. Trigger a manual retry:
   ```bash
   kubectl create job --from=cronjob/grype-cve-scan grype-retry -n security
   ```

---

### GrypeScanStale

| Field | Value |
|-------|-------|
| **Severity** | warning |
| **Fires when** | No successful Grype scan in over 48 hours |
| **Expression** | `time() - max(kube_cronjob_status_last_successful_time{cronjob="grype-cve-scan"}) > 172800` |
| **Impact** | Vulnerability data is stale. New CVEs published since the last scan are invisible. |

**Response:** Same as `ProwlerScanStale` — check if suspended, check recent Jobs, trigger a manual run.

---

### GrypeCronJobSuspended

| Field | Value |
|-------|-------|
| **Severity** | warning |
| **Fires when** | Grype CronJob has `suspend: true` for >1 hour |
| **Expression** | `kube_cronjob_spec_suspend{cronjob="grype-cve-scan"} == 1` |
| **Impact** | No new CVE scans will run until unsuspended. |

**Response:** Determine who suspended it and why. Unsuspend: `kubectl patch cronjob grype-cve-scan -n security -p '{"spec":{"suspend":false}}'`

---

## Kube-bench Alerts

### KubeBenchScanFailing

| Field | Value |
|-------|-------|
| **Severity** | warning |
| **Fires when** | Kube-bench CronJob has failed runs for >30 minutes |
| **Expression** | `kube_job_status_failed{job_name=~"kube-bench-cis-scan-.*"} > 0` |
| **Impact** | CIS benchmark compliance scanning is degraded. |

**Response:**

1. Check the failed Job logs:
   ```bash
   FAILED_JOB=$(kubectl get jobs -n security -l app=kube-bench --field-selector status.successful=0 -o name | tail -1)
   kubectl logs $FAILED_JOB -n security
   ```

2. Common causes:
   - **Host path access denied**: kube-bench needs read access to `/etc`, `/var/lib/kubelet`, etc.
   - **Auto-detection failure**: If the cloud provider isn't detected, the scan may fail. Consider adding an explicit `--benchmark` flag.

---

### KubeBenchScanStale

| Field | Value |
|-------|-------|
| **Severity** | warning |
| **Fires when** | No successful kube-bench scan in over 7 days |
| **Expression** | `time() - max(kube_cronjob_status_last_successful_time{cronjob="kube-bench-cis-scan"}) > 604800` |
| **Impact** | CIS compliance data is stale. Weekly scan cadence is broken. |

**Response:** Same pattern — check if suspended, check recent Jobs, trigger a manual run.

---

### KubeBenchCronJobSuspended

| Field | Value |
|-------|-------|
| **Severity** | warning |
| **Fires when** | Kube-bench CronJob has `suspend: true` for >1 hour |
| **Expression** | `kube_cronjob_spec_suspend{cronjob="kube-bench-cis-scan"} == 1` |
| **Impact** | No CIS benchmark scans will run until unsuspended. |

**Response:** Unsuspend: `kubectl patch cronjob kube-bench-cis-scan -n security -p '{"spec":{"suspend":false}}'`

---

## Kubescape Alerts

### KubescapeScanFailing

| Field | Value |
|-------|-------|
| **Severity** | warning |
| **Fires when** | Kubescape CronJob has failed runs for >30 minutes |
| **Expression** | `kube_job_status_failed{job_name=~"kubescape-scan-.*"} > 0` |
| **Impact** | MITRE ATT&CK / NSA hardening scanning is degraded. |

**Response:**

1. Check the failed Job logs:
   ```bash
   FAILED_JOB=$(kubectl get jobs -n security -l app=kubescape --field-selector status.successful=0 -o name | tail -1)
   kubectl logs $FAILED_JOB -n security
   ```

2. Common causes:
   - **API server connectivity**: Kubescape needs cluster-admin access to scan all resources
   - **OOMKilled**: Large clusters with many resources can exhaust scanner memory

---

### KubescapeScanStale

| Field | Value |
|-------|-------|
| **Severity** | warning |
| **Fires when** | No successful Kubescape scan in over 48 hours |
| **Expression** | `time() - max(kube_cronjob_status_last_successful_time{cronjob="kubescape-scan"}) > 172800` |
| **Impact** | Kubernetes security posture data is stale. |

**Response:** Check if suspended, check recent Jobs, trigger a manual run.

---

### KubescapeCronJobSuspended

| Field | Value |
|-------|-------|
| **Severity** | warning |
| **Fires when** | Kubescape CronJob has `suspend: true` for >1 hour |
| **Expression** | `kube_cronjob_spec_suspend{cronjob="kubescape-scan"} == 1` |
| **Impact** | No MITRE/NSA scans will run until unsuspended. |

**Response:** Unsuspend: `kubectl patch cronjob kubescape-scan -n security -p '{"spec":{"suspend":false}}'`

---

## TruffleHog Alerts

### TrufflehogScanFailing

| Field | Value |
|-------|-------|
| **Severity** | warning |
| **Fires when** | TruffleHog CronJob has failed runs for >30 minutes |
| **Expression** | `kube_job_status_failed{job_name=~"trufflehog-secret-scan-.*"} > 0` |
| **Impact** | Secret leak detection is degraded. Leaked credentials in container images won't be found. |

**Response:**

1. Check the failed Job logs:
   ```bash
   FAILED_JOB=$(kubectl get jobs -n security -l app=trufflehog --field-selector status.successful=0 -o name | tail -1)
   kubectl logs $FAILED_JOB -n security
   ```

2. Common causes:
   - **Registry auth failure**: TruffleHog needs to pull and scan images
   - **Timeout**: Very large images can exceed the scan deadline

---

### TrufflehogScanStale

| Field | Value |
|-------|-------|
| **Severity** | warning |
| **Fires when** | No successful TruffleHog scan in over 48 hours |
| **Expression** | `time() - max(kube_cronjob_status_last_successful_time{cronjob="trufflehog-secret-scan"}) > 172800` |
| **Impact** | Secret detection data is stale. |

**Response:** Check if suspended, check recent Jobs, trigger a manual run.

---

### TrufflehogCronJobSuspended

| Field | Value |
|-------|-------|
| **Severity** | warning |
| **Fires when** | TruffleHog CronJob has `suspend: true` for >1 hour |
| **Expression** | `kube_cronjob_spec_suspend{cronjob="trufflehog-secret-scan"} == 1` |
| **Impact** | No secret scans will run until unsuspended. |

**Response:** Unsuspend: `kubectl patch cronjob trufflehog-secret-scan -n security -p '{"spec":{"suspend":false}}'`

---

## Compliance Report Alerts

### ComplianceReportFailing

| Field | Value |
|-------|-------|
| **Severity** | warning |
| **Fires when** | Compliance Report CronJob has failed runs for >30 minutes |
| **Expression** | `kube_job_status_failed{job_name=~"compliance-report-.*"} > 0` |
| **Impact** | Weekly evidence aggregation is degraded. SOC 2 audit packages won't be generated. |

**Response:**

1. Check the failed Job logs:
   ```bash
   FAILED_JOB=$(kubectl get jobs -n security -l app=compliance-report --field-selector status.successful=0 -o name | tail -1)
   kubectl logs $FAILED_JOB -n security
   ```

2. Common causes:
   - **GCS access failure**: Uses `gcloud storage` — check Workload Identity
   - **Wazuh API unreachable**: The report pulls data from the Wazuh API

---

### ComplianceReportStale

| Field | Value |
|-------|-------|
| **Severity** | warning |
| **Fires when** | No successful compliance report in over 7 days |
| **Expression** | `time() - max(kube_cronjob_status_last_successful_time{cronjob="compliance-report"}) > 604800` |
| **Impact** | Evidence aggregation cadence is broken. Auditors expect weekly reports. |

**Response:** Check if suspended, check recent Jobs, trigger a manual run.

---

### ComplianceReportCronJobSuspended

| Field | Value |
|-------|-------|
| **Severity** | warning |
| **Fires when** | Compliance Report CronJob has `suspend: true` for >1 hour |
| **Expression** | `kube_cronjob_spec_suspend{cronjob="compliance-report"} == 1` |
| **Impact** | No evidence packages will be generated until unsuspended. |

**Response:** Unsuspend: `kubectl patch cronjob compliance-report -n security -p '{"spec":{"suspend":false}}'`

---

## Falco Alerts

### FalcoDaemonSetUnavailable

| Field | Value |
|-------|-------|
| **Severity** | warning |
| **Fires when** | Falco DaemonSet has unavailable pods for >15 minutes |
| **Expression** | `kube_daemonset_status_number_unavailable{daemonset="falco"} > 0` |
| **Impact** | Runtime threat detection is degraded on nodes without Falco. Syscall-based attacks won't be detected. |

**Response:**

1. Identify which nodes are missing Falco:
   ```bash
   kubectl get ds falco -n security
   kubectl get pods -n security -l app=falco -o wide | grep -v Running
   ```

2. Common causes:
   - **Kernel module failure**: Falco needs kernel headers or eBPF support. Check pod logs for driver errors.
   - **Node pressure**: Falco pod evicted due to resource limits
   - **Security context denied**: Falco needs privileged mode — ensure the Kyverno exclusion is in place

---

### FalcoDaemonSetMisscheduled

| Field | Value |
|-------|-------|
| **Severity** | warning |
| **Fires when** | Falco pods are scheduled on unexpected nodes for >15 minutes |
| **Expression** | `kube_daemonset_status_number_misscheduled{daemonset="falco"} > 0` |
| **Impact** | Falco is running on nodes where it shouldn't be. Investigate scheduling. |

**Response:** Same as `WazuhAgentDaemonSetMisscheduled` — check for taint/label changes on nodes.

---

## Alert Escalation Matrix

| Alert | Severity | On-Call Response Time | Escalation |
|-------|----------|----------------------|------------|
| WazuhManagerDown | Critical | 15 minutes | Page infrastructure + security team |
| WazuhAgentDaemonSetUnavailable | Warning | 1 hour | Notify security team |
| WazuhAgentDaemonSetMisscheduled | Warning | 4 hours | Notify security team |
| FalcoDaemonSetUnavailable | Warning | 1 hour | Notify security team |
| FalcoDaemonSetMisscheduled | Warning | 4 hours | Notify security team |
| ProwlerScanFailing | Warning | 4 hours | Notify security team |
| ProwlerScanStale | Warning | 8 hours | Notify security + compliance team |
| ProwlerCronJobSuspended | Warning | 4 hours | Notify security team |
| GrypeScanFailing | Warning | 4 hours | Notify security team |
| GrypeScanStale | Warning | 8 hours | Notify security team |
| GrypeCronJobSuspended | Warning | 4 hours | Notify security team |
| KubeBenchScanFailing | Warning | 4 hours | Notify security team |
| KubeBenchScanStale | Warning | Next business day | Notify security team |
| KubeBenchCronJobSuspended | Warning | 4 hours | Notify security team |
| KubescapeScanFailing | Warning | 4 hours | Notify security team |
| KubescapeScanStale | Warning | 8 hours | Notify security team |
| KubescapeCronJobSuspended | Warning | 4 hours | Notify security team |
| TrufflehogScanFailing | Warning | 4 hours | Notify security team |
| TrufflehogScanStale | Warning | 8 hours | Notify security team |
| TrufflehogCronJobSuspended | Warning | 4 hours | Notify security team |
| ComplianceReportFailing | Warning | 4 hours | Notify security + compliance team |
| ComplianceReportStale | Warning | Next business day | Notify security + compliance team |
| ComplianceReportCronJobSuspended | Warning | 4 hours | Notify security + compliance team |

---

## Silence Procedures

To silence an alert during planned maintenance:

```bash
# Via Alertmanager API
curl -X POST http://alertmanager:9093/api/v2/silences \
  -H "Content-Type: application/json" \
  -d '{
    "matchers": [{"name": "alertname", "value": "WazuhManagerDown", "isRegex": false}],
    "startsAt": "2025-01-15T00:00:00Z",
    "endsAt": "2025-01-15T04:00:00Z",
    "createdBy": "your-name",
    "comment": "Planned Wazuh Manager upgrade"
  }'
```

Or use the existing alert-silence-syncer if configured.

**Always document maintenance windows for SOC 2 audit trail.**
