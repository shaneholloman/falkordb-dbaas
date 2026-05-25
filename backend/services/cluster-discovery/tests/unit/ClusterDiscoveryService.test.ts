import { ClusterDiscoveryService } from '../../src/services/ClusterDiscoveryService';
import { markClusterDeleting, unmarkClusterDeleting } from '../../src/services/DeletingClusterRegistry';
import { mockAWSCluster } from '../__mocks__/fixtures';

describe('ClusterDiscoveryService', () => {
  afterEach(() => {
    unmarkClusterDeleting(mockAWSCluster.name);
    jest.clearAllMocks();
  });

  it('should skip node pool reconciliation for clusters with deletion in progress', async () => {
    const service = new ClusterDiscoveryService({
      whitelist: [],
      blacklist: [],
      deleteUnknownSecrets: false,
    });
    const nodePoolService = {
      createObservabilityNodePoolIfNeeded: jest.fn(),
      createSecurityNodePoolIfNeeded: jest.fn(),
      createSecurityInfraNodePoolIfNeeded: jest.fn(),
    };
    const registrationService = {
      registerOrUpdateCluster: jest.fn().mockResolvedValue(undefined),
    };
    const secretService = {
      createPagerDutySecret: jest.fn(),
      createOrUpdateVMUserSecret: jest.fn().mockResolvedValue(undefined),
      createOrUpdateSealedSecretsKey: jest.fn().mockResolvedValue(undefined),
    };

    (service as any).nodePoolService = nodePoolService;
    (service as any).registrationService = registrationService;
    (service as any).secretService = secretService;
    markClusterDeleting(mockAWSCluster.name);

    await (service as any).registerClusters([mockAWSCluster], [
      {
        name: mockAWSCluster.name,
        labels: { cluster: mockAWSCluster.name },
      },
    ]);

    expect(nodePoolService.createObservabilityNodePoolIfNeeded).not.toHaveBeenCalled();
    expect(nodePoolService.createSecurityNodePoolIfNeeded).not.toHaveBeenCalled();
    expect(nodePoolService.createSecurityInfraNodePoolIfNeeded).not.toHaveBeenCalled();
    expect(registrationService.registerOrUpdateCluster).toHaveBeenCalledWith(mockAWSCluster, expect.any(Object));
  });
});