---
mode: 'agent'
description: 'Add per-graph memory dashboard panels and Alloy allowlist update after exporter enhancement is deployed'
---

You are implementing Phase 2 of the FalkorDB Memory Visibility Dashboard Fixes.
The redis exporter sidecar now exposes GRAPH.MEMORY data as Prometheus metrics.

## Context

Read `.github/copilot-instructions.md` for full project context and architecture.

The exporter now exposes these new metrics (scraped from GRAPH.MEMORY USAGE):
- `falkordb_graph_memory_total_mb{graph, namespace, pod}`
- `falkordb_graph_label_matrices_mb{graph, namespace, pod}`
- `falkordb_graph_relation_matrices_mb{graph, namespace, pod}`
- `falkordb_graph_node_block_mb{graph, namespace, pod}`
- `falkordb_graph_node_attributes_mb{graph, label, namespace, pod}`
- `falkordb_graph_unlabeled_node_attributes_mb{graph, namespace, pod}`
- `falkordb_graph_edge_block_mb{graph, namespace, pod}`
- `falkordb_graph_edge_attributes_mb{graph, type, namespace, pod}`
- `falkordb_graph_indices_mb{graph, namespace, pod}`

## Tasks (4 items)

### Task 9: Update Alloy metric allowlist
Files: `argocd/apps/app-plane/dev/alloy.yaml` and `argocd/apps/app-plane/prod/alloy.yaml`

Find the `prometheus.relabel "drop_unwanted_metrics"` block that has a `keep` action
with a regex matching `redis_|...`. Add `falkordb_graph_` to that regex so the new
metrics are not dropped. Apply the same change to both dev and prod.

### Task 10: Per-graph memory usage panels
File: `observability/grafana/dashboards/falkordb-cloud.json`

Add a new collapsed row "Per-Graph Memory" after the "Memory Analysis" row. Add:

1. **Stacked timeseries: "Memory by Graph"**
   - Query: `falkordb_graph_memory_total_mb{namespace="$namespace", pod=~"$pod"}`
   - Stack by `graph` label, unit MB, fill opacity 30

2. **Table: "Top Graphs by Memory"**
   - Query: `topk(20, sum(falkordb_graph_memory_total_mb{namespace="$namespace"}) by (graph))`
   - Columns: Graph name, Total MB. Sort descending by memory.

3. **Pie chart: "Memory Distribution by Component"**
   - Queries (one per component, sum across graphs):
     - `sum(falkordb_graph_node_block_mb{...}) + sum(falkordb_graph_node_attributes_mb{...})` → "Nodes & Properties"
     - `sum(falkordb_graph_edge_block_mb{...}) + sum(falkordb_graph_edge_attributes_mb{...})` → "Edges & Properties"
     - `sum(falkordb_graph_label_matrices_mb{...}) + sum(falkordb_graph_relation_matrices_mb{...})` → "Matrices"
     - `sum(falkordb_graph_indices_mb{...})` → "Indices"

### Task 11: Per-graph breakdown detail panels
File: `observability/grafana/dashboards/falkordb-cloud.json`

Add to the same "Per-Graph Memory" row:

1. **Stacked timeseries: "Graph Memory Components"**
   - One query per component for selected graph (add $graph template variable):
     - `falkordb_graph_node_block_mb{graph="$graph", ...}` → "Node Blocks"
     - `falkordb_graph_node_attributes_mb{graph="$graph", ...}` → "Node Attrs ({{label}})"
     - `falkordb_graph_edge_block_mb{graph="$graph", ...}` → "Edge Blocks"
     - `falkordb_graph_edge_attributes_mb{graph="$graph", ...}` → "Edge Attrs ({{type}})"
     - `falkordb_graph_label_matrices_mb{graph="$graph", ...}` → "Label Matrices"
     - `falkordb_graph_relation_matrices_mb{graph="$graph", ...}` → "Relation Matrices"
     - `falkordb_graph_indices_mb{graph="$graph", ...}` → "Indices"
   - Stacked, unit MB

2. **Add `$graph` template variable** to the dashboard templating section:
   - Type: query
   - Query: `label_values(falkordb_graph_memory_total_mb{namespace="$namespace"}, graph)`
   - Include All: true, allValue: ".*"
   - Refresh: on time range change

### Task 12: New alert — FalkorDBGraphMemoryImbalance
File: `observability/rules/falkordb.rules.yml`

Add to the `falkordb.rules.memory` group:

```yaml
- alert: FalkorDBGraphMemoryImbalance
  expr: >
    (max(falkordb_graph_memory_total_mb{container="service"}) by (namespace, cluster)
    /
    sum(falkordb_graph_memory_total_mb{container="service"}) by (namespace, cluster))
    > 0.7
  for: 15m
  labels:
    severity: warning
    cluster: '{{ $labels.cluster }}'
  annotations:
    summary: "Single graph consuming >70% of total graph memory in {{ $labels.namespace }}"
    description: "[cluster={{ $labels.cluster }}] A single graph in namespace {{ $labels.namespace }} is consuming more than 70% of total graph memory. Consider graph eviction or migration."
```

## Conventions
- All dashboard panels use `${datasource}` template variable
- All queries filter by `namespace=~"$namespace", pod=~"$pod"`
- Panel IDs must not conflict with existing (check max ID before adding)
- Validate JSON after editing: `python3 -c "import json; json.load(open('...'))" && echo "VALID"`
- Match the visual style of existing panels in the "Memory Analysis" row

## Verification
- Confirm `falkordb_graph_*` metrics appear in Grafana Explore after Alloy update
- All new panels render with data
- The $graph variable populates with graph names
- Alert expression evaluates correctly in vmui

## After completing, update `.github/copilot-instructions.md`:
- Change Phase 2 task statuses from BLOCKED → DONE
