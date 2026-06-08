import { RDBTask, TaskTypes } from '../schemas/rdb-task';

const makeImportTask = (source: Record<string, unknown>) => ({
  taskId: 'task-id',
  type: TaskTypes.RDBImport,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: 'pending' as const,
  payload: {
    cloudProvider: 'gcp' as const,
    clusterId: 'cluster-id',
    region: 'us-central1',
    instanceId: 'instance-id',
    podIds: ['node-s-0'],
    hasTLS: false,
    bucketName: 'falkordb-import-bucket',
    fileName: 'imports/instance-id/import.rdb',
    rdbSizeFileName: 'imports/instance-id/import.rdb.size',
    rdbKeyNumberFileName: 'imports/instance-id/import.rdb.keys',
    deploymentSizeInMb: 1024,
    backupPath: 'backups/instance-id',
    aofEnabled: false,
    isCluster: false,
    source,
  },
});

describe('RDB import source task schema', () => {
  it('accepts HTTPS URL sources without credentials', () => {
    expect(() => RDBTask.validateSync(makeImportTask({
      type: 'url',
      url: 'https://customer.example.com/imports/customer.rdb?token=secret-token',
    }))).not.toThrow();
  });

  it.each([
    ['http scheme', 'http://customer.example.com/imports/customer.rdb'],
    ['URL credentials', 'https://user:pass@customer.example.com/imports/customer.rdb'],
  ])('rejects URL sources with %s', (_caseName, url) => {
    expect(() => RDBTask.validateSync(makeImportTask({
      type: 'url',
      url,
    }))).toThrow();
  });
});