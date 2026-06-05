import { FlowJob } from 'bullmq';
import { ExportRDBTaskType, PublicExportRDBTaskSchema, PublicTaskDocumentSchema, sanitizeTaskDocument, TaskDocumentSchema } from '@falkordb/schemas/global';
import { RdbExportCopyRDBToBucketProcessorDataSchema, RdbExportTaskNames } from '@falkordb/schemas/services/db-importer-worker/v1';
import { Value } from '@sinclair/typebox/value';
import { TaskQueueBullMQRepository } from '../repositories/tasksQueue/TaskQueueBullMQRepository';
import { ExportRDBController } from '../routes/export/controllers/ExportRDBController';

const gcsSaveMock = jest.fn();
const s3SendMock = jest.fn();

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({
      file: jest.fn().mockReturnValue({
        save: gcsSaveMock,
      }),
    }),
  })),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: s3SendMock,
  })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock('bullmq', () => ({
  FlowProducer: jest.fn().mockImplementation(() => ({
    add: jest.fn(),
  })),
}));

const logger = {
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
};

const envKeys = [
  'CTRL_PLANE_PROJECT_ID',
  'CTRL_PLANE_CLUSTER_ID',
  'CTRL_PLANE_REGION',
  'NAMESPACE',
] as const;

const previousEnv: Partial<Record<typeof envKeys[number], string>> = {};

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

const findJob = (flow: FlowJob, name: RdbExportTaskNames): FlowJob | undefined => {
  if (flow.name === name) {
    return flow;
  }

  for (const child of flow.children ?? []) {
    const match = findJob(child as FlowJob, name);
    if (match) {
      return match;
    }
  }

  return undefined;
};

const makeSingleShardTask = (target?: ExportRDBTaskType['payload']['destination']['target']): ExportRDBTaskType => ({
  taskId: 'task-single',
  type: 'SingleShardRDBExport',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: 'created',
  payload: {
    cloudProvider: 'gcp',
    clusterId: 'cluster-id',
    region: 'us-central1',
    instanceId: 'instance-id',
    podId: 'node-s-0',
    hasTLS: false,
    destination: {
      bucketName: 'falkordb-export-bucket',
      fileName: 'exports/instance-id/export.rdb',
      expiresIn: 60 * 60 * 1000,
      target,
    },
  },
});

const makeMultiShardTask = (target?: ExportRDBTaskType['payload']['destination']['target']): ExportRDBTaskType => ({
  taskId: 'task-multi',
  type: 'MultiShardRDBExport',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: 'created',
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
      target,
      nodes: [
        { podId: 'cluster-mz-0', partFileName: 'exports/instance-id/cluster-mz-0.rdb' },
        { podId: 'cluster-mz-2', partFileName: 'exports/instance-id/cluster-mz-2.rdb' },
        { podId: 'cluster-mz-4', partFileName: 'exports/instance-id/cluster-mz-4.rdb' },
      ],
    },
  },
});

const makeController = (createdTask: ExportRDBTaskType) => {
  const tasksRepository = {
    listTasks: jest.fn().mockResolvedValue({ data: [] }),
    createTask: jest.fn().mockResolvedValue(createdTask),
    updateTask: jest.fn().mockResolvedValue({ ...createdTask, status: 'pending' }),
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
      deploymentType: 'Free',
      subscriptionId: 'subscription-id',
    }),
    checkIfUserHasAccessToInstance: jest.fn().mockResolvedValue(true),
  };
  const k8sRepository = {
    isUserAdmin: jest.fn().mockResolvedValue(true),
  };
  const taskQueueRepository = {
    submitExportRDBTask: jest.fn().mockResolvedValue(undefined),
  };

  return {
    controller: new ExportRDBController(
      tasksRepository as never,
      omnistrateRepository as never,
      k8sRepository as never,
      taskQueueRepository as never,
      'falkordb-export-bucket',
      { logger: logger as never },
    ),
    tasksRepository,
  };
};

describe('export target flow', () => {
  beforeAll(() => {
    for (const key of envKeys) {
      previousEnv[key] = process.env[key];
    }

    process.env.CTRL_PLANE_PROJECT_ID = 'ctrl-project';
    process.env.CTRL_PLANE_CLUSTER_ID = 'ctrl-cluster';
    process.env.CTRL_PLANE_REGION = 'us-central1';
    process.env.NAMESPACE = 'db-importer-worker';
  });

  afterAll(() => {
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousEnv[key];
      }
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('verifies GCS target write access before creating an export task', async () => {
    gcsSaveMock.mockResolvedValue(undefined);
    const target = {
      type: 'gcs' as const,
      bucketName: 'customer-bucket',
      credentials: serviceAccountCredentials,
    };
    const { controller, tasksRepository } = makeController(makeSingleShardTask(target));

    await controller.exportRDB({
      requestorId: 'user-id',
      instanceId: 'instance-id',
      username: 'falkordb',
      password: 'password',
      target,
    });

    expect(gcsSaveMock).toHaveBeenCalledWith(Buffer.alloc(0), {
      contentType: 'application/octet-stream',
      resumable: false,
    });
    const createdPayload = tasksRepository.createTask.mock.calls[0][1];
    expect(createdPayload.destination.fileName).toMatch(/^exports\/instance-id\/.+\.rdb$/);
    expect(gcsSaveMock.mock.invocationCallOrder[0]).toBeLessThan(tasksRepository.createTask.mock.invocationCallOrder[0]);
  });

  it('verifies S3 target write access before creating an export task', async () => {
    s3SendMock.mockResolvedValue(undefined);
    const target = {
      type: 's3' as const,
      bucketName: 'customer-bucket',
      region: 'us-east-1',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
    };
    const { controller, tasksRepository } = makeController(makeSingleShardTask(target));

    await controller.exportRDB({
      requestorId: 'user-id',
      instanceId: 'instance-id',
      username: 'falkordb',
      password: 'password',
      target,
    });

    const command = s3SendMock.mock.calls[0][0];
    const createdPayload = tasksRepository.createTask.mock.calls[0][1];
    expect(command.input).toEqual(expect.objectContaining({
      Bucket: 'customer-bucket',
      Key: createdPayload.destination.fileName,
      Body: new Uint8Array(),
      ContentType: 'application/octet-stream',
    }));
    expect(createdPayload.destination.fileName).toMatch(/^exports\/instance-id\/.+\.rdb$/);
    expect(s3SendMock.mock.invocationCallOrder[0]).toBeLessThan(tasksRepository.createTask.mock.invocationCallOrder[0]);
  });

  it('uses read signed URL as the root job for default single shard exports', () => {
    const repository = new TaskQueueBullMQRepository({ logger: logger as never });

    const flow = repository._createExportRDBFlow(makeSingleShardTask());

    expect(flow.name).toBe(RdbExportTaskNames.RdbExportRequestReadSignedURL);
    expect(findJob(flow, RdbExportTaskNames.RdbExportCopyRdbToBucket)).toBeDefined();
  });

  it('uses copy RDB as the root job for customer GCS single shard exports', () => {
    const repository = new TaskQueueBullMQRepository({ logger: logger as never });

    const flow = repository._createExportRDBFlow(makeSingleShardTask({
      type: 'gcs',
      bucketName: 'customer-bucket',
      credentials: serviceAccountCredentials,
    }));

    expect(flow.name).toBe(RdbExportTaskNames.RdbExportCopyRdbToBucket);
    expect(findJob(flow, RdbExportTaskNames.RdbExportRequestReadSignedURL)).toBeUndefined();
    expect(flow.data).not.toHaveProperty('target');
    expect(JSON.stringify(flow)).not.toContain(serviceAccountCredentials.private_key);
  });

  it('uses copy RDB as the root job after merge for customer S3 multi shard exports', () => {
    const repository = new TaskQueueBullMQRepository({ logger: logger as never });

    const flow = repository._createExportRDBFlow(makeMultiShardTask({
      type: 's3',
      bucketName: 'customer-bucket',
      region: 'us-east-1',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
    }));

    expect(flow.name).toBe(RdbExportTaskNames.RdbExportCopyRdbToBucket);
    expect(findJob(flow, RdbExportTaskNames.RdbExportRequestReadSignedURL)).toBeUndefined();
    expect(findJob(flow, RdbExportTaskNames.RdbExportMonitorRDBMerge)).toBeDefined();
    expect(flow.data).toEqual(expect.objectContaining({
      taskId: 'task-multi',
      bucketName: 'falkordb-export-bucket',
      fileName: 'exports/instance-id/export.rdb',
    }));
    expect(flow.data).not.toHaveProperty('podId');
    expect(flow.data).not.toHaveProperty('target');
    expect(JSON.stringify(flow)).not.toContain('secret-key');
  });

  it('uses read signed URL as the root job after merge for default multi shard exports', () => {
    const repository = new TaskQueueBullMQRepository({ logger: logger as never });

    const flow = repository._createExportRDBFlow(makeMultiShardTask());

    expect(flow.name).toBe(RdbExportTaskNames.RdbExportRequestReadSignedURL);
    expect(findJob(flow, RdbExportTaskNames.RdbExportMonitorRDBMerge)).toBeDefined();
  });

  it('does not allow import task types in the public export task schema', () => {
    expect(Value.Check(PublicExportRDBTaskSchema, {
      ...makeSingleShardTask(),
      type: 'RDBImport',
    })).toBe(false);
  });

  it('preserves multi-shard nodes and read URL when casting public task responses', () => {
    const task = {
      ...makeMultiShardTask({ type: 'default' }),
      status: 'completed' as const,
      output: {
        readUrl: 'https://example.com/export.rdb',
      },
    };

    const storedTask = Value.Cast(TaskDocumentSchema, task) as ExportRDBTaskType;
    const publicTask = Value.Cast(PublicTaskDocumentSchema, sanitizeTaskDocument(storedTask));

    expect(publicTask.type).toBe('MultiShardRDBExport');
    if (publicTask.type !== 'MultiShardRDBExport') {
      throw new Error(`Expected MultiShardRDBExport, got ${publicTask.type}`);
    }
    const multiShardPublicTask = publicTask as {
      payload: { destination: { nodes: unknown[] } };
      output?: { readUrl?: string };
    };
    expect(multiShardPublicTask.payload.destination.nodes).toHaveLength(3);
    expect(multiShardPublicTask.output?.readUrl).toBe('https://example.com/export.rdb');
  });

  it('requires pod upload metadata only for copy jobs that include podId', () => {
    const stagedCopyJob = {
      taskId: 'task-id',
      bucketName: 'falkordb-export-bucket',
      fileName: 'exports/instance-id/export.rdb',
    };

    expect(Value.Check(RdbExportCopyRDBToBucketProcessorDataSchema, stagedCopyJob)).toBe(true);
    expect(Value.Check(RdbExportCopyRDBToBucketProcessorDataSchema, {
      ...stagedCopyJob,
      podId: 'node-s-0',
    })).toBe(false);
    expect(Value.Check(RdbExportCopyRDBToBucketProcessorDataSchema, {
      ...stagedCopyJob,
      cloudProvider: 'gcp',
      clusterId: 'cluster-id',
      region: 'us-central1',
      instanceId: 'instance-id',
      podId: 'node-s-0',
    })).toBe(true);
  });
});