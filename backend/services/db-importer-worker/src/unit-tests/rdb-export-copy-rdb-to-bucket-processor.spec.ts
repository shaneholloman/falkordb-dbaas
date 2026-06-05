import { IBlobStorageRepository } from '../repositories/blob/IBlobStorageRepository';
import { K8sRepository } from '../repositories/k8s/K8sRepository';
import { ITasksDBRepository } from '../repositories/tasks';
import RdbExportCopyRDBToBucketProcessor from '../processors/RdbExportCopyRDBToBucketProcessor';

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

const makeDefaultMultiShardTask = () => ({
  taskId: 'task-id',
  type: 'MultiShardRDBExport',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: 'pending',
  payload: {
    cloudProvider: 'gcp',
    clusterId: 'cluster-id',
    region: 'us-central1',
    instanceId: 'instance-id',
    podId: 'cluster-mz-0',
    hasTLS: false,
    destination: {
      bucketName: 'falkordb-export-bucket',
      fileName: 'exports/instance-id/export.rdb',
      expiresIn: 60 * 60 * 1000,
      nodes: [
        { podId: 'cluster-mz-0', partFileName: 'exports/instance-id/cluster-mz-0.rdb' },
        { podId: 'cluster-mz-2', partFileName: 'exports/instance-id/cluster-mz-2.rdb' },
        { podId: 'cluster-mz-4', partFileName: 'exports/instance-id/cluster-mz-4.rdb' },
      ],
    },
  },
});

describe('RDB export copy RDB to bucket processor', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('uses the managed bucket write URL and completes default staged copies', async () => {
    const tasksRepository = {
      getTaskById: jest.fn().mockResolvedValue(makeDefaultMultiShardTask()),
      updateTask: jest.fn().mockResolvedValue(undefined),
    };
    const blobRepository = {
      getReadUrl: jest.fn().mockResolvedValue('https://source-read-url'),
      getWriteUrl: jest.fn().mockResolvedValue('https://managed-write-url'),
    };
    const k8sRepository = {
      sendUploadCommand: jest.fn(),
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

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(new Response('rdb-content'))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await RdbExportCopyRDBToBucketProcessor.processor({
      id: 'job-id',
      data: {
        taskId: 'task-id',
        bucketName: 'falkordb-export-bucket',
        fileName: 'exports/instance-id/export.rdb',
      },
    } as never, undefined as never);

    expect(blobRepository.getReadUrl).toHaveBeenCalledWith(
      'falkordb-export-bucket',
      'exports/instance-id/export.rdb',
      60 * 60 * 1000,
    );
    expect(blobRepository.getWriteUrl).toHaveBeenCalledWith(
      'falkordb-export-bucket',
      'exports/instance-id/export.rdb',
      'application/octet-stream',
      60 * 60 * 1000,
    );
    expect(global.fetch).toHaveBeenLastCalledWith('https://managed-write-url', expect.objectContaining({
      method: 'PUT',
    }));
    expect(tasksRepository.updateTask).toHaveBeenCalledWith({
      taskId: 'task-id',
      status: 'completed',
    });
    expect(k8sRepository.sendUploadCommand).not.toHaveBeenCalled();
  });
});
