import { RDBTask, TaskTypes } from '../schemas/rdb-task';
import { RDBImportRequestSourceSchema, RDBImportSourceSchema } from '@falkordb/schemas/global';
import { Value } from '@sinclair/typebox/value';

const makeImportTask = (source: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
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
  ...overrides,
});

describe('RDB import source task schema', () => {
  it('accepts file upload sources in task payloads only', () => {
    const source = {
      type: 'file',
    };

    expect(() => RDBTask.validateSync(makeImportTask(source))).not.toThrow();
    expect(Value.Check(RDBImportSourceSchema, source)).toBe(true);
    expect(Value.Check(RDBImportRequestSourceSchema, source)).toBe(false);
  });

  it('accepts prepared instance sources', () => {
    expect(() => RDBTask.validateSync(makeImportTask({
      type: 'instance',
      instanceId: 'source-instance-id',
      cloudProvider: 'gcp',
      clusterId: 'source-cluster-id',
      region: 'us-central1',
      podId: 'node-s-0',
      podIds: ['node-s-0'],
      isCluster: false,
      tls: false,
    }, { scheduleId: 'schedule-id' }))).not.toThrow();
  });

  it('accepts prepared cluster instance sources', () => {
    expect(() => RDBTask.validateSync(makeImportTask({
      type: 'instance',
      instanceId: 'source-instance-id',
      cloudProvider: 'gcp',
      clusterId: 'source-cluster-id',
      region: 'us-central1',
      podId: 'cluster-sz-0',
      podIds: ['cluster-sz-0', 'cluster-sz-2', 'cluster-sz-4'],
      isCluster: true,
      tls: false,
    }))).not.toThrow();
  });

  it('rejects unprepared instance sources', () => {
    expect(() => RDBTask.validateSync(makeImportTask({
      type: 'instance',
      instanceId: 'source-instance-id',
      username: 'source-user',
      password: 'source-password',
    }))).toThrow();
  });

  it('requires prepared metadata in shared task schema while request schema accepts client input', () => {
    const requestSource = {
      type: 'instance',
      instanceId: 'source-instance-id',
      username: 'source-user',
      password: 'source-password',
    };

    expect(Value.Check(RDBImportRequestSourceSchema, requestSource)).toBe(true);
    expect(Value.Check(RDBImportSourceSchema, requestSource)).toBe(false);
    expect(Value.Check(RDBImportSourceSchema, {
      type: 'instance',
      instanceId: requestSource.instanceId,
      cloudProvider: 'gcp',
      clusterId: 'source-cluster-id',
      region: 'us-central1',
      podId: 'node-s-0',
      podIds: ['node-s-0'],
      isCluster: false,
      tls: false,
    })).toBe(true);
  });

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