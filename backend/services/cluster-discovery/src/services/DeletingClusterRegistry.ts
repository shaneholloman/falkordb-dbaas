const DEFAULT_DELETION_SUPPRESSION_MS = 6 * 60 * 60 * 1000;

const deletingClusters = new Map<string, number>();

function normalizeClusterName(clusterName: string): string {
  return clusterName.trim().toLowerCase();
}

function getDeletionSuppressionMs(): number {
  const configuredValue = Number(process.env.DELETION_SUPPRESSION_MS);
  return Number.isFinite(configuredValue) && configuredValue > 0 ? configuredValue : DEFAULT_DELETION_SUPPRESSION_MS;
}

function pruneExpired(now = Date.now()): void {
  const suppressionMs = getDeletionSuppressionMs();

  for (const [clusterName, markedAt] of deletingClusters.entries()) {
    if (now - markedAt > suppressionMs) {
      deletingClusters.delete(clusterName);
    }
  }
}

export function markClusterDeleting(clusterName: string): void {
  pruneExpired();
  deletingClusters.set(normalizeClusterName(clusterName), Date.now());
}

export function unmarkClusterDeleting(clusterName: string): void {
  deletingClusters.delete(normalizeClusterName(clusterName));
}

export function isClusterDeleting(clusterName: string): boolean {
  pruneExpired();
  return deletingClusters.has(normalizeClusterName(clusterName));
}

export function clearDeletingClustersNotIn(discoveredClusterNames: string[]): void {
  const discovered = new Set(discoveredClusterNames.map(normalizeClusterName));

  for (const clusterName of deletingClusters.keys()) {
    if (!discovered.has(clusterName)) {
      deletingClusters.delete(clusterName);
    }
  }
}