---
mode: 'agent'
description: 'Enhance Redis exporter sidecar to expose FalkorDB GRAPH.MEMORY metrics as Prometheus gauges'
---

You are enhancing the Redis exporter sidecar to expose FalkorDB per-graph memory
metrics as Prometheus metrics.
## Background

FalkorDB's `GRAPH.MEMORY USAGE <graph>` command already returns a detailed memory
breakdown per graph. The exporter currently only exposes `redis_falkordb_total_graph_count`.
We need it to also call GRAPH.MEMORY for each graph and expose the results.

## What GRAPH.MEMORY USAGE returns

```
127.0.0.1:6379> GRAPH.MEMORY USAGE flights
 1) "total_graph_sz_mb"
 2) (integer) 1086
 3) "label_matrices_sz_mb"
 4) (integer) 96
 5) "relation_matrices_sz_mb"
 6) (integer) 64
 7) "amortized_node_block_sz_mb"
 8) (integer) 120
 9) "amortized_node_attributes_by_label_sz_mb"
10) 1) "Airport"
    2) (integer) 35
    3) "City"
    4) (integer) 12
11) "amortized_unlabeled_nodes_attributes_sz_mb"
12) (integer) 0
13) "amortized_edge_block_sz_mb"
14) (integer) 54
15) "amortized_edge_attributes_by_type_sz_mb"
16) 1) "ROUTE"
    2) (integer) 68
17) "indices_sz_mb"
18) (integer) 752
```

## Implementation Requirements

### Step 1: Enumerate graphs
Call `GRAPH.LIST` to get all graph names in the current Redis instance.

### Step 2: For each graph, call `GRAPH.MEMORY USAGE <graph>`
Parse the response into the component fields. Note:
- `amortized_node_attributes_by_label_sz_mb` is a **map** (flat array of alternating
  label name and integer value pairs)
- `amortized_edge_attributes_by_type_sz_mb` is also a **map** (flat array of
  alternating relationship type name and integer value pairs)
- All values are integers in MB

### Step 3: Expose as Prometheus metrics

Register and expose these gauges:

| Metric Name | Labels | Source Field |
|-------------|--------|-------------|
| `falkordb_graph_memory_total_mb` | `graph` | `total_graph_sz_mb` |
| `falkordb_graph_label_matrices_mb` | `graph` | `label_matrices_sz_mb` |
| `falkordb_graph_relation_matrices_mb` | `graph` | `relation_matrices_sz_mb` |
| `falkordb_graph_node_block_mb` | `graph` | `amortized_node_block_sz_mb` |
| `falkordb_graph_node_attributes_mb` | `graph`, `label` | Each entry in `amortized_node_attributes_by_label_sz_mb` |
| `falkordb_graph_unlabeled_node_attributes_mb` | `graph` | `amortized_unlabeled_nodes_attributes_sz_mb` |
| `falkordb_graph_edge_block_mb` | `graph` | `amortized_edge_block_sz_mb` |
| `falkordb_graph_edge_attributes_mb` | `graph`, `type` | Each entry in `amortized_edge_attributes_by_type_sz_mb` |
| `falkordb_graph_indices_mb` | `graph` | `indices_sz_mb` |

All metrics should also inherit the standard labels already present on other
`redis_*` metrics: `namespace`, `pod`, `container`, `cluster`, `environment`.

### Step 4: Handle edge cases
- If GRAPH.LIST returns empty, expose no graph metrics (do not error)
- If GRAPH.MEMORY fails for a specific graph (e.g. graph deleted mid-scrape),
  log a warning and skip that graph
- Use the optional SAMPLES parameter only if scrape latency is too high
  (default 100 samples is fine for most graphs)
- Reset/clear stale graph metrics when a graph is deleted (avoid stale series)

### Step 5: Performance considerations
- GRAPH.MEMORY can be expensive on large graphs — consider adding a configurable
  scrape interval or a flag to enable/disable graph memory collection
- If there are many graphs (>50), consider batching or limiting to top-N by
  total_graph_sz_mb
- Consider caching results for a configurable TTL to avoid calling GRAPH.MEMORY
  on every Prometheus scrape (e.g. cache for 60s, scrape interval is also 60s)

## Expected Prometheus output

```
# HELP falkordb_graph_memory_total_mb Total memory consumed by graph in MB
# TYPE falkordb_graph_memory_total_mb gauge
falkordb_graph_memory_total_mb{graph="flights"} 1086
# HELP falkordb_graph_label_matrices_mb Memory used by label matrices in MB
# TYPE falkordb_graph_label_matrices_mb gauge
falkordb_graph_label_matrices_mb{graph="flights"} 96
# HELP falkordb_graph_relation_matrices_mb Memory used by relation matrices in MB
# TYPE falkordb_graph_relation_matrices_mb gauge
falkordb_graph_relation_matrices_mb{graph="flights"} 64
# HELP falkordb_graph_node_block_mb Memory used by node blocks in MB
# TYPE falkordb_graph_node_block_mb gauge
falkordb_graph_node_block_mb{graph="flights"} 120
# HELP falkordb_graph_node_attributes_mb Memory used by node attributes per label in MB
# TYPE falkordb_graph_node_attributes_mb gauge
falkordb_graph_node_attributes_mb{graph="flights",label="Airport"} 35
falkordb_graph_node_attributes_mb{graph="flights",label="City"} 12
# HELP falkordb_graph_unlabeled_node_attributes_mb Memory used by unlabeled node attributes in MB
# TYPE falkordb_graph_unlabeled_node_attributes_mb gauge
falkordb_graph_unlabeled_node_attributes_mb{graph="flights"} 0
# HELP falkordb_graph_edge_block_mb Memory used by edge blocks in MB
# TYPE falkordb_graph_edge_block_mb gauge
falkordb_graph_edge_block_mb{graph="flights"} 54
# HELP falkordb_graph_edge_attributes_mb Memory used by edge attributes per type in MB
# TYPE falkordb_graph_edge_attributes_mb gauge
falkordb_graph_edge_attributes_mb{graph="flights",type="ROUTE"} 68
# HELP falkordb_graph_indices_mb Memory used by indices in MB
# TYPE falkordb_graph_indices_mb gauge
falkordb_graph_indices_mb{graph="flights"} 752
```

## Testing
- Verify with a FalkorDB instance containing multiple graphs
- Confirm metric values match manual `GRAPH.MEMORY USAGE` output
- Confirm stale metrics are cleaned up after graph deletion
- Benchmark scrape latency with 1, 10, 50 graphs to ensure acceptable performance
