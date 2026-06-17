import { IBlobStorageRepository } from '../repositories/blob/IBlobStorageRepository';
import { K8sRepository } from '../repositories/k8s/K8sRepository';
import { ITasksDBRepository } from '../repositories/tasks';
import RdbImportCopySourceToBucketProcessor from '../processors/RdbImportCopySourceToBucketProcessor';

const mockResolve = jest.fn();
const mockValidateImportSourceUrl = jest.fn();

jest.mock('../container', () => ({
  setupContainer: jest.fn(() => ({
    resolve: mockResolve,
  })),
}));

jest.mock('@falkordb/security', () => ({
  validateImportSourceUrl: (...args: unknown[]) => mockValidateImportSourceUrl(...args),
}));

const logger = {
  debug: jest.fn(),
  error: jest.fn(),
};

const makeTask = () => ({
  taskId: 'task-id',
  type: 'RDBImport',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: 'in_progress',
  payload: {
    source: {
      type: 'url',
      url: 'https://source.example.com/dump.rdb',
    },
  },
});

describe('RDB import copy source to bucket processor', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      CTRL_PLANE_PROJECT_ID: 'ctrl-project',
      CTRL_PLANE_CLUSTER_ID: 'ctrl-cluster',
      CTRL_PLANE_REGION: 'us-central1',
      NAMESPACE: 'api',
    };
    mockValidateImportSourceUrl.mockResolvedValue(new URL('https://source.example.com/dump.rdb'));
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  const setup = () => {
    const tasksRepository = {
      getTaskById: jest.fn().mockResolvedValue(makeTask()),
      updateTask: jest.fn().mockResolvedValue(undefined),
    };
    const blobRepository = {
      getWriteUrl: jest.fn().mockResolvedValue('https://managed-write-url'),
    };
    const k8sRepository = {
      createCopySourceToBucketJob: jest.fn().mockResolvedValue(undefined),
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

    return { tasksRepository, blobRepository, k8sRepository };
  };

  const makeJob = () => ({
    id: 'job-id',
    data: {
      taskId: 'task-id',
      bucketName: 'falkordb-import-bucket',
      fileName: 'imports/instance-id/import.rdb',
    },
    moveToDelayed: jest.fn().mockResolvedValue(undefined),
  });

  it('creates a Kubernetes copy job without waiting for it to finish', async () => {
    const { blobRepository, k8sRepository, tasksRepository } = setup();
    const job = makeJob();

    await expect(RdbImportCopySourceToBucketProcessor.processor(job as never, 'token' as never)).resolves.toEqual({ success: true });

    expect(blobRepository.getWriteUrl).toHaveBeenCalledWith(
      'falkordb-import-bucket',
      'imports/instance-id/import.rdb',
      'application/octet-stream',
      60 * 60 * 1000,
    );
    expect(k8sRepository.createCopySourceToBucketJob).toHaveBeenCalledWith(
      'ctrl-project',
      'gcp',
      'ctrl-cluster',
      'us-central1',
      'api',
      'task-id-copy-source-to-bucket',
      'https://source.example.com/dump.rdb',
      'https://managed-write-url',
      5 * 60 * 1000,
    );
    expect(tasksRepository.updateTask).not.toHaveBeenCalled();
  });
});
