import { ImportRDBController } from '../routes/import/controllers/ImportRDBController';
import { sanitizeTaskDocument } from '@falkordb/schemas/global';
import { TaskQueueBullMQRepository } from '../repositories/tasksQueue/TaskQueueBullMQRepository';
import { RdbImportTaskNames } from '@falkordb/schemas/services/db-importer-worker/v1';

const mockGcsExists = jest.fn();
const mockS3Send = jest.fn();
const mockFetch = jest.fn();
const mockDnsLookup = jest.fn();
const originalFetch = global.fetch;

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

jest.mock('dns/promises', () => ({
  lookup: (...args: unknown[]) => mockDnsLookup(...args),
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
    getTaskById: jest.fn().mockResolvedValue(undefined),
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
    global.fetch = mockFetch as never;
    mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 206,
      statusText: 'Partial Content',
      body: {
        cancel: jest.fn().mockResolvedValue(undefined),
      },
    });
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

  afterAll(() => {
    global.fetch = originalFetch;
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
      status: 'in_progress',
    }));
    expect(taskQueueRepository.submitImportRDBTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-id',
      status: 'in_progress',
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
      status: 'in_progress',
      payload: createdPayload,
    }));
  });

  it('creates a customer URL source import task after validating the URL', async () => {
    const source = {
      type: 'url' as const,
      url: 'https://customer.example.com/imports/customer.rdb?X-Amz-Signature=secret-signature',
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
    expect(mockFetch).toHaveBeenCalledWith(source.url, expect.objectContaining({
      method: 'GET',
      headers: {
        range: 'bytes=0-0',
      },
    }));
    expect(storageRepository.getWriteUrl).not.toHaveBeenCalled();

    const createdPayload = tasksRepository.createTask.mock.calls[0][1];
    expect(createdPayload.source).toEqual(source);
    expect(JSON.stringify(createdPayload)).toContain('secret-signature');

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
      type: 'url',
    });
    expect(JSON.stringify(publicTask)).not.toContain('secret-signature');
    expect(taskQueueRepository.submitImportRDBTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-id',
      status: 'in_progress',
      payload: createdPayload,
    }));
  });

  it('rejects invalid URL source access before creating a task', async () => {
    const source = {
      type: 'url' as const,
      url: 'https://customer.example.com/imports/missing.rdb?token=secret-token',
    };
    const { controller, tasksRepository, taskQueueRepository } = makeController();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      body: {
        cancel: jest.fn().mockResolvedValue(undefined),
      },
    });

    await expect(controller.requestUploadUrl({
      requestorId: 'user-id',
      instanceId: 'instance-id',
      username: 'falkordb',
      password: 'password',
      source,
    })).rejects.toMatchObject({
      message: 'Invalid import source credentials or object access',
      errorCode: 'INVALID_IMPORT_SOURCE',
    });

    expect(tasksRepository.createTask).not.toHaveBeenCalled();
    expect(taskQueueRepository.submitImportRDBTask).not.toHaveBeenCalled();
  });

  it.each([
    ['http scheme', { url: 'http://customer.example.com/imports/customer.rdb' }, [{ address: '93.184.216.34', family: 4 }]],
    ['URL credentials', { url: 'https://user:pass@customer.example.com/imports/customer.rdb' }, [{ address: '93.184.216.34', family: 4 }]],
    ['private resolved address', { url: 'https://customer.example.com/imports/customer.rdb' }, [{ address: '10.0.0.10', family: 4 }]],
    ['link-local literal address', { url: 'https://169.254.169.254/latest/meta-data' }, undefined],
    ['localhost literal address', { url: 'https://127.0.0.1/imports/customer.rdb' }, undefined],
  ])('rejects URL source with %s before creating a task', async (_caseName, sourceOverrides, resolvedAddresses) => {
    const source = {
      type: 'url' as const,
      ...sourceOverrides,
    };
    const { controller, tasksRepository, taskQueueRepository } = makeController();
    if (resolvedAddresses) {
      mockDnsLookup.mockResolvedValue(resolvedAddresses);
    }

    await expect(controller.requestUploadUrl({
      requestorId: 'user-id',
      instanceId: 'instance-id',
      username: 'falkordb',
      password: 'password',
      source,
    })).rejects.toMatchObject({
      message: 'Invalid import source credentials or object access',
      errorCode: 'INVALID_IMPORT_SOURCE',
    });

    expect(tasksRepository.createTask).not.toHaveBeenCalled();
    expect(taskQueueRepository.submitImportRDBTask).not.toHaveBeenCalled();
  });

  it('rejects URL source redirects before creating a task', async () => {
    const source = {
      type: 'url' as const,
      url: 'https://customer.example.com/redirect.rdb',
    };
    const { controller, tasksRepository, taskQueueRepository } = makeController();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 302,
      statusText: 'Found',
      headers: new Headers({ location: 'https://169.254.169.254/latest/meta-data' }),
      body: {
        cancel: jest.fn().mockResolvedValue(undefined),
      },
    });

    await expect(controller.requestUploadUrl({
      requestorId: 'user-id',
      instanceId: 'instance-id',
      username: 'falkordb',
      password: 'password',
      source,
    })).rejects.toMatchObject({
      message: 'Invalid import source credentials or object access',
      errorCode: 'INVALID_IMPORT_SOURCE',
    });

    expect(mockFetch).toHaveBeenCalledWith(source.url, expect.objectContaining({
      redirect: 'manual',
    }));
    expect(tasksRepository.createTask).not.toHaveBeenCalled();
    expect(taskQueueRepository.submitImportRDBTask).not.toHaveBeenCalled();
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
    })).rejects.toMatchObject({
      message: 'Error submitting task',
      errorCode: 'TASK_SUBMISSION_ERROR',
    });

    expect(tasksRepository.updateTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-id',
      status: 'in_progress',
    }));
    expect(tasksRepository.updateTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-id',
      status: 'failed',
      errors: ['Failed to submit import task to queue'],
    }));
  });

  it('does not resubmit an already queued customer source task from confirm upload', async () => {
    const source = {
      type: 's3' as const,
      bucketName: 'customer-bucket',
      key: 'imports/customer.rdb',
      region: 'us-east-1',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
    };
    const { controller, tasksRepository, taskQueueRepository } = makeController();
    tasksRepository.getTaskById.mockResolvedValueOnce({
      taskId: 'task-id',
      type: 'RDBImport',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'in_progress',
      payload: { source },
    });

    await expect(controller.confirmUpload({
      requestorId: 'user-id',
      instanceId: 'instance-id',
      taskId: 'task-id',
    })).rejects.toMatchObject({
      message: 'Task is not in a valid state',
      errorCode: 'TASK_INVALID_STATE',
    });

    expect(tasksRepository.updateTask).not.toHaveBeenCalled();
    expect(taskQueueRepository.submitImportRDBTask).not.toHaveBeenCalled();
  });

  it('marks a confirmed upload task in progress before submitting it to the queue', async () => {
    const task = {
      taskId: 'task-id',
      type: 'RDBImport',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'pending',
      payload: {},
    };
    const { controller, tasksRepository, taskQueueRepository } = makeController();
    tasksRepository.getTaskById.mockResolvedValueOnce(task);

    await controller.confirmUpload({
      requestorId: 'user-id',
      instanceId: 'instance-id',
      taskId: 'task-id',
    });

    expect(tasksRepository.updateTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-id',
      status: 'in_progress',
    }));
    expect(taskQueueRepository.submitImportRDBTask).toHaveBeenCalledWith(task);
  });

  it('serializes customer source validation behind one copy job without queueing credentials', () => {
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
          type: 'url',
          url: 'https://customer.example.com/imports/customer.rdb?token=secret-token',
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
      expect(JSON.stringify(copyJob)).not.toContain('secret-token');
    }

    const sendSaveJob = jobs.find((job) => job.name === RdbImportTaskNames.RdbImportSendSaveCommand);
    expect(sendSaveJob?.children).toHaveLength(1);
    const sizeMonitorJob = sendSaveJob?.children?.[0];
    expect(sizeMonitorJob?.name).toBe(RdbImportTaskNames.RdbImportMonitorSizeValidationProgress);
    const sizeValidationJob = sizeMonitorJob?.children?.[0];
    expect(sizeValidationJob?.name).toBe(RdbImportTaskNames.RdbImportValidateRDBSize);
    const formatMonitorJob = sizeValidationJob?.children?.[0];
    expect(formatMonitorJob?.name).toBe(RdbImportTaskNames.RdbImportMonitorFormatValidationProgress);
    const formatValidationJob = formatMonitorJob?.children?.[0];
    expect(formatValidationJob?.name).toBe(RdbImportTaskNames.RdbImportValidateRDBFormat);
    expect(formatValidationJob?.children?.[0].name).toBe(RdbImportTaskNames.RdbImportCopySourceToBucket);
  });
});

const collectJobs = (job) => [
  job,
  ...(job.children ?? []).flatMap(collectJobs),
];
