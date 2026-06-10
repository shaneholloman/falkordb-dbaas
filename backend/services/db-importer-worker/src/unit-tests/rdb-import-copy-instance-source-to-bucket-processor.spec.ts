import { IBlobStorageRepository } from '../repositories/blob/IBlobStorageRepository';
import { K8sRepository } from '../repositories/k8s/K8sRepository';
import { ITasksDBRepository } from '../repositories/tasks';
import RdbImportCopyInstanceSourceToBucketProcessor from '../processors/RdbImportCopyInstanceSourceToBucketProcessor';

const mockResolve = jest.fn();

jest.mock('../container', () => ({
  setupContainer: jest.fn(() => ({
    resolve: mockResolve,
  })),
}));

const logger = {
  debug: jest.fn(),
  error: jest.fn(),
};

describe('RDB import copy instance source to bucket processor', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('uses the deployment default user for source pod save and upload commands', async () => {
    const tasksRepository = {
      getTaskById: jest.fn().mockResolvedValue({
        taskId: 'task-id',
        type: 'RDBImport',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'in_progress',
        payload: {
          source: {
            type: 'instance',
            instanceId: 'source-instance-id',
            cloudProvider: 'gcp',
            clusterId: 'source-cluster-id',
            region: 'us-central1',
            podIds: ['node-s-0'],
            isCluster: false,
            tls: false,
          },
        },
      }),
      updateTask: jest.fn().mockResolvedValue(undefined),
    };
    const blobRepository = {
      getWriteUrl: jest.fn().mockResolvedValue('https://managed-write-url'),
    };
    const k8sRepository = {
      sendSaveAndUploadCommand: jest.fn().mockResolvedValue(undefined),
    };

    mockResolve.mockImplementation((name: string) => {
      switch (name) {
        case 'logger':
          return logger;
        case ITasksDBRepository.name:
          return tasksRepository;
        case K8sRepository.name:
          return k8sRepository;
        case IBlobStorageRepository.name:
          return blobRepository;
        default:
          throw new Error(`Unexpected dependency: ${name}`);
      }
    });

    await RdbImportCopyInstanceSourceToBucketProcessor.processor({
      id: 'job-id',
      data: {
        taskId: 'task-id',
        bucketName: 'falkordb-import-bucket',
        fileName: 'imports/instance-id/import.rdb',
        podId: 'node-s-0',
      },
    } as never, undefined as never);

    expect(blobRepository.getWriteUrl).toHaveBeenCalledWith(
      'falkordb-import-bucket',
      'imports/instance-id/import.rdb',
      'application/octet-stream',
      60 * 60 * 1000,
    );
    expect(k8sRepository.sendSaveAndUploadCommand).toHaveBeenCalledWith(
      'gcp',
      'source-cluster-id',
      'us-central1',
      'source-instance-id',
      'node-s-0',
      false,
      'https://managed-write-url',
    );
    expect(JSON.stringify(k8sRepository.sendSaveAndUploadCommand.mock.calls)).not.toContain('source-user');
    expect(JSON.stringify(k8sRepository.sendSaveAndUploadCommand.mock.calls)).not.toContain('source-password');
    expect(tasksRepository.updateTask).not.toHaveBeenCalled();
  });
});