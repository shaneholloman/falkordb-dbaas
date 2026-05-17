# FalkorDB DBaaS - Copilot Instructions

## Project Context

This is the FalkorDB DBaaS (Database-as-a-Service) platform repository managing:
- **Observability**: Grafana dashboards, VMRule alerting rules, Alloy scrape configs
- **Infrastructure**: Tofu/Terragrunt IaC for GCP/AWS/K8s
- **Backend services**: Node.js microservices (pnpm monorepo)
- **Frontend**: React apps (pnpm monorepo)
- **ArgoCD**: GitOps deployment manifests

## Architecture Notes

- FalkorDB pods are managed by **Omnistrate** (not this repo)
- Redis exporter runs as a **sidecar** in Omnistrate pods, exposes metrics on port 9121
- **Grafana Alloy** scrapes FalkorDB pods via kubernetes discovery (label `app.kubernetes.io/managed-by=omnistrate`)
- Metrics flow: exporter → Alloy → VictoriaMetrics → Grafana
- Alerts defined as **VMRule** CRDs (`operator.victoriametrics.com/v1beta1`)
- Dashboards deployed as **ConfigMaps** via Kustomize, referenced by GrafanaDashboard CRDs

## Active Plan: FalkorDB Memory Visibility Dashboard Fixes

**Origin**: Reevo customer meeting (May 15, 2026) — memory reporting & visibility issues
**Objective**: Provide granular memory breakdown visibility for FalkorDB graphs

### Key Insight
`GRAPH.MEMORY USAGE <graph>` already returns detailed breakdown (total, label_matrices, relation_matrices, node_block, node_attributes_by_label, edge_block, edge_attributes_by_type, indices). No core engine changes needed for visibility. The gap is in the **exporter** (not scraping it) and **dashboards** (not displaying it).

### Phase 1: Immediate Fixes (no external dependencies)

| # | Task | File | Status |
|---|------|------|--------|
| 1 | Add container memory panels (working_set, rss, limits comparison) | `observability/grafana/dashboards/falkordb-cloud.json` | TODO |
| 2 | Add memory fragmentation ratio panel (`redis_mem_fragmentation_ratio`) | `observability/grafana/dashboards/falkordb-cloud.json` | TODO |
| 3 | Fix `FalkorDBOutOfConfiguredMaxmemoryCritical` severity: warning → critical | `observability/rules/falkordb.rules.yml` | TODO |
| 4 | Add memory growth rate panel (`deriv(redis_memory_used_bytes[1h])`) | `observability/grafana/dashboards/falkordb-cloud.json` | TODO |
| 5 | Add Redis memory breakdown panels (dataset vs overhead vs allocator) | `observability/grafana/dashboards/falkordb-cloud.json` | TODO |
| 6 | Add graph count timeseries trend (currently only stat) | `observability/grafana/dashboards/falkordb-cloud.json` | TODO |
| 7 | New alert: `FalkorDBMemoryFragmentationHigh` (ratio > 1.5 for 10m) | `observability/rules/falkordb.rules.yml` | TODO |
| 8 | New alert: `FalkorDBMemoryGrowthRapid` (deriv threshold) | `observability/rules/falkordb.rules.yml` | TODO |

### Phase 2: After Exporter Enhancement (blocked on exporter team)

| # | Task | File | Status |
|---|------|------|--------|
| 9 | Update Alloy allowlist for `falkordb_graph_*` metrics | `argocd/apps/app-plane/{dev,prod}/alloy.yaml` | BLOCKED |
| 10 | Per-graph memory panels (stacked by component, top-N table) | `observability/grafana/dashboards/falkordb-cloud.json` | BLOCKED |
| 11 | Per-graph breakdown (node attrs by label, edge attrs by type) | `observability/grafana/dashboards/falkordb-cloud.json` | BLOCKED |
| 12 | New alert: `FalkorDBGraphMemoryImbalance` (single graph >70% total) | `observability/rules/falkordb.rules.yml` | BLOCKED |

### Phase 3: After Engine Features (blocked on core team)

| # | Task | Blocked On | Status |
|---|------|-----------|--------|
| 13 | Graph eviction status panel | Engine Task 3.1 | BLOCKED |
| 14 | Node utilization & load balancing dashboard | Engine Task 6.1 | BLOCKED |
| 15 | Graph topology overview panel | Engine Task 4.1 | BLOCKED |

### Exporter Team Requirements

The redis exporter sidecar (in Omnistrate-managed pods) needs to:
1. Call `GRAPH.LIST` to enumerate all graphs
2. For each graph, call `GRAPH.MEMORY USAGE <graph>`
3. Expose results as Prometheus metrics:
   - `falkordb_graph_memory_total_mb{graph}`
   - `falkordb_graph_label_matrices_mb{graph}`
   - `falkordb_graph_relation_matrices_mb{graph}`
   - `falkordb_graph_node_block_mb{graph}`
   - `falkordb_graph_node_attributes_mb{graph, label}`
   - `falkordb_graph_edge_block_mb{graph}`
   - `falkordb_graph_edge_attributes_mb{graph, type}`
   - `falkordb_graph_indices_mb{graph}`

### Verification Checklist

- [ ] All Phase 1 panels render with data in Grafana
- [ ] `redis_mem_fragmentation_ratio` is not dropped by Alloy allowlist
- [ ] Alert severity fix fires as `critical` in alertmanager
- [ ] Memory breakdown panels show meaningful non-zero data
- [ ] Phase 2 metrics appear in VictoriaMetrics after exporter deploy

## Coding Conventions

- Dashboards: JSON files in `observability/grafana/dashboards/`, use `${datasource}` template variable
- Alert rules: VMRule YAML in `observability/rules/`, namespace `observability`
- Alloy config: HCL-like syntax in `argocd/apps/app-plane/{dev,prod}/alloy.yaml`
- Backend: TypeScript, pnpm workspaces, turborepo
- IaC: OpenTofu + Terragrunt
