import { OmnistrateRepository } from '../../src/repositories/omnistrate/OmnistrateRepository';
import { OmnistrateClient } from '../../src/repositories/omnistrate/OmnistrateClient';
import pino from 'pino';

describe('OmnistrateRepository', () => {
  let repository: OmnistrateRepository;
  let omnistrateClient: OmnistrateClient;
  let logger: pino.Logger;

  beforeEach(() => {
    logger = pino({ level: 'silent' });
    omnistrateClient = new OmnistrateClient(
      process.env.OMNISTRATE_EMAIL || 'test@example.com',
      process.env.OMNISTRATE_PASSWORD || 'password',
      { logger },
    );
    repository = new OmnistrateRepository(
      omnistrateClient,
      process.env.OMNISTRATE_SERVICE_ID || 'service-id',
      process.env.OMNISTRATE_ENVIRONMENT_ID || 'environment-id',
      { logger },
    );
  });

  describe('validate', () => {
    it('should throw error when token is not provided', async () => {
      await expect(repository.validate('')).rejects.toThrow();
    });

    it('should return false for invalid token', async () => {
      const result = await repository.validate('invalid-token');
      expect(result).toBe(false);
    });

    // Add more tests with real tokens in integration tests
  });

  describe('getInstance', () => {
    it('should throw error when instanceId is not provided', async () => {
      await expect(repository.getInstance('')).rejects.toThrow();
    });

    it('should use launch input params when result params are empty', async () => {
      jest.spyOn(omnistrateClient.client, 'get').mockResolvedValue({
        data: {
          deploymentCellID: 'hc-123',
          cloudProvider: 'gcp',
          serviceId: 'service-id',
          environmentId: 'environment-id',
          productTierId: 'tier-id',
          tierVersion: '1',
          productTierName: 'Dedicated',
          subscriptionId: 'subscription-id',
          consumptionResourceInstanceResult: {
            id: 'instance-id',
            region: 'us-central1',
            createdByUserId: 'user-id',
            created_at: '2026-05-26T00:00:00Z',
            status: 'RUNNING',
            detailedNetworkTopology: {},
            launch_input_params: {
              FALKORDB_HOST: 'cluster-mz-0',
              FALKORDB_PASSWORD: 'password',
            },
            result_params: {},
          },
        },
      });

      const result = await repository.getInstance('instance-id');

      expect(result.params).toEqual({
        FALKORDB_HOST: 'cluster-mz-0',
        FALKORDB_PASSWORD: 'password',
      });
    });

    // Add more tests with real instance IDs in integration tests
  });

  describe('getSubscriptionUsers', () => {
    it('should throw error when subscriptionId is not provided', async () => {
      await expect(repository.getSubscriptionUsers('')).rejects.toThrow();
    });

    // Add more tests with real subscription IDs in integration tests
  });

  describe('checkIfUserHasAccessToInstance', () => {
    it('should throw error when required parameters are missing', async () => {
      await expect(repository.checkIfUserHasAccessToInstance('', 'instance-id')).rejects.toThrow();
      await expect(repository.checkIfUserHasAccessToInstance('user-id', '')).rejects.toThrow();
    });

    // Add more tests with real data in integration tests
  });
});
