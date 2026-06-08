import { ImportRDBController } from '../routes/import/controllers/ImportRDBController';
import { sanitizeTaskDocument } from '@falkordb/schemas/global';
import { TaskQueueBullMQRepository } from '../repositories/tasksQueue/TaskQueueBullMQRepository';
import { RdbImportTaskNames } from '@falkordb/schemas/services/db-importer-worker/v1';

const mockGcsExists = jest.fn();
const mockS3Send = jest.fn();

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({
      file: jest.fn().mockImplementation((fileName: string) => ({
        exists: () => mockGcsExists(fileName),
      })),
    }),
  })),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: (...args: unknown[]) => mockS3Send(...args),
  })),
  HeadObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

const logger = {
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
};

const serviceAccountCredentials = {
  type: 'service_account' as const,
  project_id: 'customer-project',
  private_key_id: 'key-id',
  private_key: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n',
  client_email: 'exporter@customer-project.iam.gserviceaccount.com',
  client_id: '1234567890',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
  auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
  client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/exporter%40customer-project.iam.gserviceaccount.com',
};

const makeController = () => {
  const createdTask = {
    taskId: 'task-id',
    type: 'RDBImport',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'created',
  };
  const omnistrateRepository = {
    getInstance: jest.fn().mockResolvedValue({
      id: 'instance-id',
      cloudProvider: 'gcp',
      clusterId: 'cluster-id',
      region: 'us-central1',
      tls: false,
      status: 'RUNNING',
      productTierName: 'FalkorDB Free',
      deploymentType: 'Standalone',
      podIds: ['node-s-0'],
      aofEnabled: false,
    }),
    checkIfUserHasAccessToInstance: jest.fn().mockResolvedValue(true),
  };
  const k8sRepository = {
    isUserAdmin: jest.fn().mockResolvedValue(true),
    getMaxMemory: jest.fn().mockResolvedValue('104857600'),
  };
  const tasksRepository = {
    listTasks: jest.fn().mockResolvedValue({ data: [] }),
    createTask: jest.fn().mockImplementation(async (_type, payload) => ({
      ...createdTask,
      payload,
    })),
    updateTask: jest.fn().mockResolvedValue(undefined),
  };
  const storageRepository = {
    getWriteUrl: jest.fn().mockResolvedValue('https://managed-write-url'),
  };
  const taskQueueRepository = {
    submitImportRDBTask: jest.fn().mockResolvedValue(undefined),
  };

  return {
    controller: new ImportRDBController(
      omnistrateRepository as never,
      k8sRepository as never,
      tasksRepository as never,
      storageRepository as never,
      taskQueueRepository as never,
      'falkordb-import-bucket',
      { logger: logger as never },
    ),
    tasksRepository,
    storageRepository,
    taskQueueRepository,
  };
};

describe('import RDB customer source flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGcsExists.mockImplementation(async (fileName: string) => {
      if (fileName.includes('missing')) {
        throw new Error('missing object');
      }
      return [true];
    });
    mockS3Send.mockImplementation(async (command) => {
      if (command.input.Key.includes('missing')) {
        throw new Error('access denied');
      }
      return {};
    });
  });

  it('creates a customer GCS source import task without copying in the API request', async () => {
    const source = {
      type: 'gcs' as const,
      bucketName: 'customer-bucket',
      fileName: 'imports/customer.rdb',
      credentials: serviceAccountCredentials,
    };
    const { controller, storageRepository, tasksRepository, taskQueueRepository } = makeController();

    const result = await controller.requestUploadUrl({
      requestorId: 'user-id',
      instanceId: 'instance-id',
      username: 'falkordb',
      password: 'password',
      source,
    });

    expect(result).toEqual({ taskId: 'task-id' });
    expect(mockGcsExists).toHaveBeenCalledTimes(1);
    expect(storageRepository.getWriteUrl).not.toHaveBeenCalled();

    const createdPayload = tasksRepository.createTask.mock.calls[0][1];
    expect(createdPayload.source).toEqual(source);
    expect(JSON.stringify(createdPayload)).toContain('private_key');

    const publicTask = sanitizeTaskDocument({
      taskId: 'task-id',
      type: 'RDBImport',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'pending',
      payload: createdPayload,
    });
    if (publicTask.type !== 'RDBImport') {
      throw new Error(`Expected RDBImport task, got ${publicTask.type}`);
    }
    expect(publicTask.payload.source).toEqual({
      type: 'gcs',
      bucketName: 'customer-bucket',
      fileName: 'imports/customer.rdb',
    });
    expect(JSON.stringify(publicTask)).not.toContain(serviceAccountCredentials.private_key);
    expect(tasksRepository.updateTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-id',
      status: 'pending',
    }));
    expect(taskQueueRepository.submitImportRDBTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-id',
      status: 'pending',
      payload: createdPayload,
    }));
  });

  it('creates a customer S3 source import task without copying in the API request', async () => {
    const source = {
      type: 's3' as const,
      bucketName: 'customer-bucket',
      key: 'imports/customer.rdb',
      region: 'us-east-1',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      sessionToken: 'session-token',
    };
    const { controller, storageRepository, tasksRepository, taskQueueRepository } = makeController();

    const result = await controller.requestUploadUrl({
      requestorId: 'user-id',
      instanceId: 'instance-id',
      username: 'falkordb',
      password: 'password',
      source,
    });

    expect(result).toEqual({ taskId: 'task-id' });
    const headCommand = mockS3Send.mock.calls[0][0];
    expect(headCommand.input).toEqual({
      Bucket: 'customer-bucket',
      Key: 'imports/customer.rdb',
    });
    expect(storageRepository.getWriteUrl).not.toHaveBeenCalled();

    const createdPayload = tasksRepository.createTask.mock.calls[0][1];
    expect(createdPayload.source).toEqual(source);
    expect(JSON.stringify(createdPayload)).toContain('secret-key');
    expect(JSON.stringify(createdPayload)).toContain('session-token');

    const publicTask = sanitizeTaskDocument({
      taskId: 'task-id',
      type: 'RDBImport',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'pending',
      payload: createdPayload,
    });
    if (publicTask.type !== 'RDBImport') {
      throw new Error(`Expected RDBImport task, got ${publicTask.type}`);
    }
    expect(publicTask.payload.source).toEqual({
      type: 's3',
      bucketName: 'customer-bucket',
      key: 'imports/customer.rdb',
      region: 'us-east-1',
    });
    expect(JSON.stringify(publicTask)).not.toContain('secret-key');
    expect(JSON.stringify(publicTask)).not.toContain('session-token');
    expect(taskQueueRepository.submitImportRDBTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-id',
      status: 'pending',
      payload: createdPayload,
    }));
  });

  it('rejects invalid customer source access before creating a task', async () => {
    const source = {
      type: 's3' as const,
      bucketName: 'customer-bucket',
      key: 'imports/missing.rdb',
      region: 'us-east-1',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
    };
    const { controller, tasksRepository, taskQueueRepository } = makeController();
    jest
      .spyOn(controller as unknown as { _validateCustomerSource: (typeof controller)['requestUploadUrl'] }, '_validateCustomerSource')
      .mockRejectedValue(new Error('Invalid import source credentials or object access'));

    await expect(controller.requestUploadUrl({
      requestorId: 'user-id',
      instanceId: 'instance-id',
      username: 'falkordb',
      password: 'password',
      source,
    })).rejects.toThrow('Invalid import source credentials or object access');

    expect(tasksRepository.createTask).not.toHaveBeenCalled();
    expect(taskQueueRepository.submitImportRDBTask).not.toHaveBeenCalled();
  });

  it('marks customer source task failed when queue submission fails', async () => {
    const source = {
      type: 'gcs' as const,
      bucketName: 'customer-bucket',
      fileName: 'imports/customer.rdb',
      credentials: serviceAccountCredentials,
    };
    const { controller, tasksRepository, taskQueueRepository } = makeController();
    taskQueueRepository.submitImportRDBTask.mockRejectedValueOnce(new Error('queue down'));

    await expect(controller.requestUploadUrl({
      requestorId: 'user-id',
      instanceId: 'instance-id',
      username: 'falkordb',
      password: 'password',
      source,
    })).rejects.toThrow('queue down');

    expect(tasksRepository.updateTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-id',
      status: 'pending',
    }));
    expect(tasksRepository.updateTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-id',
      status: 'failed',
      errors: ['Failed to submit import task to queue'],
    }));
  });

  it('adds customer source copy jobs to the import flow without queueing credentials', () => {
    process.env.APPLICATION_PLANE_PROJECT_ID = 'app-plane-project';
    process.env.CTRL_PLANE_PROJECT_ID = 'ctrl-plane-project';
    process.env.CTRL_PLANE_CLUSTER_ID = 'ctrl-plane-cluster';
    process.env.CTRL_PLANE_REGION = 'us-central1';
    process.env.NAMESPACE = 'db-importer';

    const repository = Object.create(TaskQueueBullMQRepository.prototype) as TaskQueueBullMQRepository;
    (repository as unknown as { _opts: { logger: typeof logger } })._opts = { logger };
    const flow = repository._createImportRDBFlow({
      taskId: 'task-id',
      type: 'RDBImport',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'pending',
      payload: {
        cloudProvider: 'gcp',
        clusterId: 'cluster-id',
        region: 'us-central1',
        instanceId: 'instance-id',
        podIds: ['node-s-0'],
        hasTLS: false,
        bucketName: 'falkordb-import-bucket',
        fileName: 'imports/instance-id/import.rdb',
        rdbSizeFileName: 'imports/instance-id/import-size.txt',
        rdbKeyNumberFileName: 'imports/instance-id/import-keys.txt',
        deploymentSizeInMb: 100,
        backupPath: '/data/backup/dump.rdb',
        aofEnabled: false,
        isCluster: false,
        source: {
          type: 's3',
          bucketName: 'customer-bucket',
          key: 'imports/customer.rdb',
          region: 'us-east-1',
          accessKeyId: 'access-key',
          secretAccessKey: 'secret-key',
          sessionToken: 'session-token',
        },
      },
    });

    const jobs = collectJobs(flow);
    const copyJobs = jobs.filter((job) => job.name === RdbImportTaskNames.RdbImportCopySourceToBucket);

    expect(copyJobs).toHaveLength(1);
    for (const copyJob of copyJobs) {
      expect(copyJob.data).toEqual({
        taskId: 'task-id',
        bucketName: 'falkordb-import-bucket',
        fileName: 'imports/instance-id/import.rdb',
      });
      expect(JSON.stringify(copyJob)).not.toContain('secret-key');
      expect(JSON.stringify(copyJob)).not.toContain('session-token');
    }

    const sendSaveJob = jobs.find((job) => job.name === RdbImportTaskNames.RdbImportSendSaveCommand);
    expect(sendSaveJob?.children).toHaveLength(1);
    expect(sendSaveJob?.children?.[0].name).toBe(RdbImportTaskNames.RdbImportMonitorSizeValidationProgress);
    expect(JSON.stringify(sendSaveJob)).toContain(RdbImportTaskNames.RdbImportMonitorFormatValidationProgress);
  });
});

const collectJobs = (job) => [
  job,
  ...(job.children ?? []).flatMap(collectJobs),
];
