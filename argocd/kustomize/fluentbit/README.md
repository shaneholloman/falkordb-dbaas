# Fluent Bit multi-cloud node/system coverage

This kustomize package now has provider-aware overlays:

- `overlays/gke`
- `overlays/eks`
- `overlays/aks`

Each overlay patches `provider-extra.conf` to collect provider-specific system/node/CNI logs, and may also patch other shared base fragments when needed (for example, GKE also patches `inputs-common.conf` to expand `Exclude_Path` for GKE-only system namespaces), while keeping shared Loki/Alloy output behavior in the base config.

## Shared normalized labels/fields

All outputs are normalized through `victoria-logs-label-normalizer.lua` and include:

- `cluster`
- `cloud_provider`
- `region`
- `node`
- `node_pool`
- `namespace`
- `pod`
- `container`
- `workload`
- `log_type` (`workload|system|node|cni`)
- `source` (for example `kubelet`, `containerd`, `node-problem-detector`)

## Provider coverage notes

### GKE overlay

Adds:

- System namespace container logs:
  - `kube-system`, `gke-system`, `gmp-system`, `istio-system`, `knative-serving`,
    `config-management-system`, `gke-managed-*`
- Node/system logs:
  - kubelet, containerd, node-problem-detector, kubelet-monitor,
    kube-container-runtime-monitor, startup script logs
- Network/CNI style logs where available

### EKS overlay

Adds:

- `kube-system` container logs
- kubelet/containerd/docker (where present)
- `/var/log/dmesg`, `/var/log/messages|/var/log/syslog`
- AWS VPC CNI logs from `/var/log/aws-routed-eni/`

### AKS overlay

Adds:

- `kube-system` container logs
- kubelet/containerd (journald), `/var/log/syslog`, `/var/log/kern.log`
- AKS/Azure CNI log paths where present

## Migration guidance (duplicate-control and parity checks)

1. Keep provider-managed logging enabled while first deploying these overlays.
2. Validate Fluent Bit DaemonSet health on all nodes:
   - `kubectl -n fluent-bit get pods -o wide`
3. Validate Fluent Bit output health:
   - `kubectl -n fluent-bit logs ds/fluent-bit --tail=200 | grep -E "retry|error|warn"`
4. In Loki, verify data availability for:
   - workload logs
   - system namespace logs
   - kubelet/container runtime logs
   - node-problem-detector logs (GKE where present)
   - CNI/network logs (provider dependent)
   - Kubernetes events (from existing Alloy `loki.source.kubernetes_events`)
5. During migration, avoid duplicate ingestion by temporarily excluding overlapping streams if another node agent is also writing to Loki. Keep workload logs as source-of-truth from this DaemonSet.
6. Validate dashboards/alerts and incident-response queries before disabling provider-managed agents.

## Control plane logs scope

Control plane logs are not collected from node-local paths by this DaemonSet:

- GKE: apiserver/scheduler/controller-manager remain in Cloud Logging path
- EKS: `api`, `audit`, `authenticator`, `controllerManager`, `scheduler` remain in CloudWatch path
- AKS: control plane/resource logs remain in Azure diagnostic settings path

Keep those provider-native exports enabled if those signals are required.

## Rollback

If migration validation fails:

1. Re-enable provider-managed node/system logging:
   - GKE: re-enable logging components including `SYSTEM_COMPONENTS`
   - EKS: re-enable CloudWatch/node logging add-on path
   - AKS: re-enable Azure Monitor / Container Insights / diagnostic settings
2. Revert Fluent Bit app path to previous manifest or remove temporary duplicate-control filters.
3. Re-validate node/system coverage before another disablement attempt.
