import { RDBTask, TaskTypes } from '../schemas/rdb-task';

const serviceAccountCredentials = {
  type: 'service_account',
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

const makeTask = (target: Record<string, unknown>) => ({
  taskId: 'task-id',
  type: TaskTypes.SingleShardRDBExport,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: 'pending' as const,
  payload: {
    cloudProvider: 'gcp' as const,
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

describe('RDB export target task schema', () => {
  it('accepts a GCS target with a service account JSON key', () => {
    expect(() => RDBTask.validateSync(makeTask({
      type: 'gcs',
      bucketName: 'customer-bucket',
      credentials: serviceAccountCredentials,
    }))).not.toThrow();
  });

  it('rejects a GCS target when the service account JSON key is incomplete', () => {
    const { private_key, ...incompleteCredentials } = serviceAccountCredentials;

    expect(() => RDBTask.validateSync(makeTask({
      type: 'gcs',
      bucketName: 'customer-bucket',
      credentials: incompleteCredentials,
    }))).toThrow();
  });

  it('accepts an S3 target and object path output', () => {
    expect(() => RDBTask.validateSync({
      ...makeTask({
        type: 's3',
        bucketName: 'customer-bucket',
        region: 'us-east-1',
        accessKeyId: 'access-key',
        secretAccessKey: 'secret-key',
      }),
      output: {
        target: {
          type: 's3',
          bucketName: 'customer-bucket',
          key: 'exports/customer.rdb',
          region: 'us-east-1',
          path: 's3://customer-bucket/exports/customer.rdb',
        },
      },
    })).not.toThrow();
  });

  it('rejects unknown export output targets', () => {
    expect(() => RDBTask.validateSync({
      ...makeTask({
        type: 'gcs',
        bucketName: 'customer-bucket',
        credentials: serviceAccountCredentials,
      }),
      output: {
        target: {
          bucketName: 'customer-bucket',
          path: 'gs://customer-bucket/exports/customer.rdb',
        },
      },
    })).toThrow();

    expect(() => RDBTask.validateSync({
      ...makeTask({
        type: 'gcs',
        bucketName: 'customer-bucket',
        credentials: serviceAccountCredentials,
      }),
      output: {
        target: {
          type: 'azure',
          bucketName: 'customer-bucket',
          path: 'azure://customer-bucket/exports/customer.rdb',
        },
      },
    })).toThrow();
  });

  it('allows export output without a target', () => {
    expect(() => RDBTask.validateSync({
      ...makeTask({
        type: 'gcs',
        bucketName: 'customer-bucket',
        credentials: serviceAccountCredentials,
      }),
      output: {
        readUrl: 'https://example.com/export.rdb',
      },
    })).not.toThrow();
  });

  it('rejects customer-supplied object names on export targets', () => {
    expect(() => RDBTask.validateSync(makeTask({
      type: 'gcs',
      bucketName: 'customer-bucket',
      fileName: 'exports/customer.rdb',
      credentials: serviceAccountCredentials,
    }))).toThrow();

    expect(() => RDBTask.validateSync(makeTask({
      type: 's3',
      bucketName: 'customer-bucket',
      key: 'exports/customer.rdb',
      region: 'us-east-1',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
    }))).toThrow();
  });
});