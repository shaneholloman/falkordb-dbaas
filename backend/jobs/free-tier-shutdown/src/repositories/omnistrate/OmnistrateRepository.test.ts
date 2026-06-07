import axios from 'axios';
import pino from 'pino';
import { OmnistrateRepository } from './OmnistrateRepository';
import { OmnistrateInstanceSchemaType } from '../../schemas/OmnistrateInstance';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('OmnistrateRepository', () => {
  let logger: pino.Logger;
  let mockAxiosInstance: any;

  const instance = {
    id: 'instance-1',
    clusterId: 'cluster-1',
    region: 'us-east-1',
    userId: 'user-1',
    createdDate: '2026-01-01T00:00:00Z',
    serviceId: 'service-1',
    environmentId: 'environment-1',
    tls: true,
    resourceId: 'resource-1',
    cloudProvider: 'aws',
  } as OmnistrateInstanceSchemaType;

  beforeEach(() => {
    logger = pino({ level: 'silent' });
    jest.clearAllMocks();

    mockAxiosInstance = {
      interceptors: {
        request: {
          use: jest.fn(),
        },
      },
      post: jest.fn(),
    };

    mockedAxios.create = jest.fn().mockReturnValue(mockAxiosInstance);
    (mockedAxios.isAxiosError as unknown as jest.Mock).mockReturnValue(true);
  });

  it('should retry stopInstance when Omnistrate returns 429', async () => {
    const rateLimitError = {
      response: {
        status: 429,
        headers: {
          'retry-after': '0',
        },
      },
    };
    mockAxiosInstance.post.mockRejectedValueOnce(rateLimitError).mockResolvedValueOnce({});

    const repo = new OmnistrateRepository('test-user', 'test-password', { logger });

    await repo.stopInstance(instance);

    expect(mockAxiosInstance.post).toHaveBeenCalledTimes(2);
    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      '/2022-09-01-00/fleet/service/service-1/environment/environment-1/instance/instance-1/stop',
      {
        resourceId: 'resource-1',
      },
    );
  });

  it('should not retry stopInstance for non-429 errors', async () => {
    const error = {
      response: {
        status: 500,
      },
    };
    mockAxiosInstance.post.mockRejectedValueOnce(error);

    const repo = new OmnistrateRepository('test-user', 'test-password', { logger });

    await expect(repo.stopInstance(instance)).rejects.toBe(error);
    expect(mockAxiosInstance.post).toHaveBeenCalledTimes(1);
  });
});