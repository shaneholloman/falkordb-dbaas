import * as k8s from '@kubernetes/client-node';
import logger from '../logger';
import { Cluster } from '../types';
import { getK8sConfig } from '../utils/k8s';

const DEFAULT_FORCE_DELETE_TIMEOUT_MS = 30_000;

function getForceDeleteTimeoutMs(): number {
  const configuredValue = Number(process.env.FORCE_DELETE_NODEPOOL_PODS_TIMEOUT_MS);
  return Number.isFinite(configuredValue) && configuredValue > 0 ? configuredValue : DEFAULT_FORCE_DELETE_TIMEOUT_MS;
}

function getNodePoolLabelSelectors(cluster: Cluster, nodePoolName: string): string[] {
  switch (cluster.cloud) {
    case 'gcp':
      return [`cloud.google.com/gke-nodepool=${nodePoolName}`];
    case 'aws':
      return [`eks.amazonaws.com/nodegroup=${nodePoolName}`];
    case 'azure':
      return [`agentpool=${nodePoolName}`, `kubernetes.azure.com/agentpool=${nodePoolName}`];
    default:
      return [];
  }
}

function isDaemonSetPod(pod: k8s.V1Pod): boolean {
  return pod.metadata?.ownerReferences?.some((owner) => owner.kind === 'DaemonSet') ?? false;
}

function isMirrorPod(pod: k8s.V1Pod): boolean {
  return Boolean(pod.metadata?.annotations?.['kubernetes.io/config.mirror']);
}

export async function forceDeleteNodePoolPods(cluster: Cluster, nodePoolName: string): Promise<void> {
  const timeoutMs = getForceDeleteTimeoutMs();
  let timeout: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      forceDeleteNodePoolPodsWithKubernetes(cluster, nodePoolName),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    logger.warn(
      { cluster: cluster.name, nodePoolName, timeoutMs, error, errorName: (error as any)?.name, errorMessage: (error as any)?.message },
      'Failed to force-delete pods on node pool before deletion; continuing with cloud node pool deletion',
    );
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function forceDeleteNodePoolPodsWithKubernetes(cluster: Cluster, nodePoolName: string): Promise<void> {
  const kubeConfig = await getK8sConfig(cluster, { projectId: cluster.gcpAccountID });
  const coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
  const nodesByName = new Map<string, k8s.V1Node>();

  for (const labelSelector of getNodePoolLabelSelectors(cluster, nodePoolName)) {
    const response = await coreApi.listNode(undefined, undefined, undefined, undefined, labelSelector);

    for (const node of response.body.items) {
      if (node.metadata?.name) {
        nodesByName.set(node.metadata.name, node);
      }
    }
  }

  if (nodesByName.size === 0) {
    logger.info({ cluster: cluster.name, nodePoolName }, 'No nodes found for node pool before deletion');
    return;
  }

  let deletedPods = 0;

  for (const nodeName of nodesByName.keys()) {
    const response = await coreApi.listPodForAllNamespaces(
      undefined,
      undefined,
      `spec.nodeName=${nodeName}`,
    );

    for (const pod of response.body.items) {
      const podName = pod.metadata?.name;
      const namespace = pod.metadata?.namespace;

      if (!podName || !namespace || isDaemonSetPod(pod) || isMirrorPod(pod)) {
        continue;
      }

      await coreApi.deleteNamespacedPod(
        podName,
        namespace,
        undefined,
        undefined,
        0,
        undefined,
        'Background',
        {
          gracePeriodSeconds: 0,
          propagationPolicy: 'Background',
        },
      );
      deletedPods += 1;
    }
  }

  logger.info(
    { cluster: cluster.name, nodePoolName, nodeCount: nodesByName.size, deletedPods },
    'Force-deleted pods on node pool before deletion',
  );
}