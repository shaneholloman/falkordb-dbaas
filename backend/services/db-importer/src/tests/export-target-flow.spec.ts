import { FlowJob } from 'bullmq';
import { ExportRDBTaskType } from '@falkordb/schemas/global';
import { RdbExportTaskNames } from '@falkordb/schemas/services/db-importer-worker/v1';
import { TaskQueueBullMQRepository } from '../repositories/tasksQueue/TaskQueueBullMQRepository';

jest.mock('bullmq', () => ({
  FlowProducer: jest.fn().mockImplementation(() => ({
    add: jest.fn(),
  })),
}));

const logger = {
  debug: jest.fn(),
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

describe('export target flow', () => {
  beforeAll(() => {
    process.env.CTRL_PLANE_PROJECT_ID = 'ctrl-project';
    process.env.CTRL_PLANE_CLUSTER_ID = 'ctrl-cluster';
    process.env.CTRL_PLANE_REGION = 'us-central1';
    process.env.NAMESPACE = 'db-importer-worker';
  });

  beforeEach(() => {
    jest.clearAllMocks();
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
      fileName: 'exports/customer.rdb',
      credentials: serviceAccountCredentials,
    }));

    expect(flow.name).toBe(RdbExportTaskNames.RdbExportCopyRdbToBucket);
    expect(findJob(flow, RdbExportTaskNames.RdbExportRequestReadSignedURL)).toBeUndefined();
    expect(flow.data.target).toEqual(expect.objectContaining({
      type: 'gcs',
      bucketName: 'customer-bucket',
    }));
  });

  it('uses copy RDB as the root job after merge for customer S3 multi shard exports', () => {
    const repository = new TaskQueueBullMQRepository({ logger: logger as never });

    const flow = repository._createExportRDBFlow(makeMultiShardTask({
      type: 's3',
      bucketName: 'customer-bucket',
      key: 'exports/customer.rdb',
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
      target: expect.objectContaining({ type: 's3' }),
    }));
    expect(flow.data).not.toHaveProperty('podId');
  });

  it('uses read signed URL as the root job after merge for default multi shard exports', () => {
    const repository = new TaskQueueBullMQRepository({ logger: logger as never });

    const flow = repository._createExportRDBFlow(makeMultiShardTask());

    expect(flow.name).toBe(RdbExportTaskNames.RdbExportRequestReadSignedURL);
    expect(findJob(flow, RdbExportTaskNames.RdbExportMonitorRDBMerge)).toBeDefined();
  });
});