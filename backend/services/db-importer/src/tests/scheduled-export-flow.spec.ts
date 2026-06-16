import { Value } from '@sinclair/typebox/value';
import { ExportRDBTaskType, ImportRDBTaskType, TaskDocumentType } from '@falkordb/schemas/global';
import { CreateScheduleRequestBodySchema, PublicScheduleSchema, ScheduleDocument } from '@falkordb/schemas/services/import-export-rdb/v1';
import { ApiError } from '@falkordb/errors';
import { ScheduleController } from '../routes/schedules/controllers/ScheduleController';
import { getRequestorId } from '../routes/schedules/handlers/auth';
import { sign } from 'jsonwebtoken';

const s3SendMock = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: s3SendMock,
  })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

const logger = {
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
};

const makeTask = (taskId = 'task-id', status: ExportRDBTaskType['status'] = 'created', scheduleId?: string): ExportRDBTaskType => ({
  taskId,
  type: 'SingleShardRDBExport',
  createdAt: '2026-06-11T10:00:00.000Z',
  updatedAt: '2026-06-11T10:00:30.000Z',
  status,
  scheduleId,
  payload: {
    cloudProvider: 'gcp',
    clusterId: 'cluster-id',
    region: 'us-central1',
    instanceId: 'instance-id',
    podId: 'node-f-0',
    hasTLS: false,
    destination: {
      bucketName: 'export-bucket',
      fileName: 'exports/instance-id/export.rdb',
      expiresIn: 60 * 60 * 1000,
      target: { type: 'default' },
    },
  },
});

const makeImportTask = (taskId = 'import-task-id', status: ImportRDBTaskType['status'] = 'created', scheduleId?: string): ImportRDBTaskType => ({
  taskId,
  type: 'RDBImport',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status,
  scheduleId,
  payload: {
    cloudProvider: 'gcp',
    clusterId: 'cluster-id',
    region: 'us-central1',
    instanceId: 'instance-id',
    podIds: ['node-f-0'],
    hasTLS: false,
    bucketName: 'import-bucket',
    fileName: 'imports/instance-id/import.rdb',
    rdbSizeFileName: 'imports/instance-id/import-size.txt',
    rdbKeyNumberFileName: 'imports/instance-id/import-keys.txt',
    deploymentSizeInMb: 1024,
    aofEnabled: false,
    backupPath: '/data/backup/dump.rdb',
    isCluster: false,
    source: {
      type: 'instance',
      instanceId: 'source-instance-id',
      cloudProvider: 'gcp',
      clusterId: 'source-cluster-id',
      region: 'us-central1',
      podId: 'node-f-0',
      podIds: ['node-f-0'],
      isCluster: false,
      tls: false,
    },
  },
});

const makeSchedule = (overrides: Partial<ScheduleDocument> = {}): ScheduleDocument => ({
  scheduleId: 'schedule-id',
  requestorId: 'user-id',
  type: 'RDBExport',
  payload: {
    instanceId: 'instance-id',
    target: { type: 'default' },
  },
  periodMinutes: 60,
  minuteOfHour: 15,
  failureThreshold: 2,
  enabled: true,
  nextRunAt: '2026-06-11T10:15:00.000Z',
  createdAt: '2026-06-11T09:00:00.000Z',
  updatedAt: '2026-06-11T09:00:00.000Z',
  ...overrides,
});

const makeImportSchedule = (overrides: Partial<ScheduleDocument> = {}): ScheduleDocument => makeSchedule({
  type: 'RDBImport',
  payload: {
    instanceId: 'instance-id',
    source: {
      type: 'instance',
      instanceId: 'source-instance-id',
      cloudProvider: 'gcp',
      clusterId: 'source-cluster-id',
      region: 'us-central1',
      podId: 'node-f-0',
      podIds: ['node-f-0'],
      isCluster: false,
      tls: false,
    },
  },
  ...overrides,
});

const makeController = ({
  dueSchedules = [],
  existingSchedules = [],
  scheduleToGet = makeSchedule(),
  runningTasks = [],
  failedTasks = [],
  scheduledTasks,
  createdTask = makeTask(),
  instanceStatuses = {},
  userHasAccess = true,
}: {
  dueSchedules?: ScheduleDocument[];
  existingSchedules?: ScheduleDocument[];
  scheduleToGet?: ScheduleDocument | null;
  runningTasks?: TaskDocumentType[];
  failedTasks?: TaskDocumentType[];
  scheduledTasks?: TaskDocumentType[];
  createdTask?: TaskDocumentType;
  instanceStatuses?: Record<string, 'RUNNING' | 'FAILED' | 'STOPPED' | 'DEPLOYING'>;
  userHasAccess?: boolean;
} = {}) => {
  const schedulesRepository = {
    createSchedule: jest.fn().mockImplementation(async (schedule) => makeSchedule(schedule)),
    listSchedules: jest.fn().mockResolvedValue(existingSchedules),
    getSchedule: jest.fn().mockResolvedValue(scheduleToGet),
    listDueSchedules: jest.fn().mockResolvedValue(dueSchedules),
    updateSchedule: jest.fn().mockImplementation(async (scheduleId, update) => makeSchedule({ scheduleId, ...update })),
    updateNextRunAt: jest.fn().mockImplementation(async (scheduleId, nextRunAt) => makeSchedule({ scheduleId, nextRunAt })),
    deleteSchedule: jest.fn().mockImplementation(async (scheduleId) => makeSchedule({ scheduleId })),
  };
  const tasksRepository = {
    listTasks: jest.fn().mockResolvedValue({ data: [] }),
    listTasksByScheduleId: jest.fn().mockImplementation(async (_scheduleId, opts) => {
      if (!opts?.status) {
        return scheduledTasks ?? runningTasks.concat(failedTasks);
      }
      if (opts.status?.includes('failed')) {
        return failedTasks;
      }
      return runningTasks;
    }),
    createTask: jest.fn().mockResolvedValue(createdTask),
    updateTask: jest.fn().mockResolvedValue({ ...createdTask, status: 'pending' }),
  };
  const omnistrateRepository = {
    getInstance: jest.fn().mockImplementation(async (instanceId = 'instance-id') => ({
      id: instanceId,
      cloudProvider: 'gcp',
      clusterId: instanceId === 'source-instance-id' ? 'source-cluster-id' : 'cluster-id',
      region: 'us-central1',
      tls: false,
      status: instanceStatuses[instanceId] ?? 'RUNNING',
      productTierName: 'FalkorDB Pro',
      deploymentType: 'Free',
      subscriptionId: 'subscription-id',
      podIds: ['node-f-0'],
      aofEnabled: false,
    })),
    checkIfUserHasAccessToInstance: jest.fn().mockResolvedValue(userHasAccess),
  };
  const taskQueueRepository = {
    submitExportRDBTask: jest.fn().mockResolvedValue(undefined),
    submitImportRDBTask: jest.fn().mockResolvedValue(undefined),
  };
  const k8sRepository = {
    getMaxMemory: jest.fn().mockResolvedValue(String(1024 * 1024 * 1024)),
    getUsedMemoryDataset: jest.fn().mockResolvedValue(128 * 1024 * 1024),
  };

  return {
    controller: new ScheduleController(
      schedulesRepository as never,
      tasksRepository as never,
      omnistrateRepository as never,
      k8sRepository as never,
      taskQueueRepository as never,
      'export-bucket',
      'import-bucket',
      {
        defaultFailureThreshold: 3,
        rdbExportAllowedTiers: process.env.SCHEDULE_RDB_EXPORT_ALLOWED_TIERS ?? '',
        rdbExportMaxPerInstance: Number(process.env.SCHEDULE_RDB_EXPORT_MAX_PER_INSTANCE ?? 2),
      },
      { logger: logger as never },
    ),
    schedulesRepository,
    tasksRepository,
    omnistrateRepository,
    k8sRepository,
    taskQueueRepository,
  };
};

describe('scheduled export flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    s3SendMock.mockResolvedValue({});
    process.env.SCHEDULE_RDB_EXPORT_ALLOWED_TIERS = 'FalkorDB Pro,FalkorDB Enterprise';
    process.env.SCHEDULE_RDB_EXPORT_MAX_PER_INSTANCE = '2';
  });

  afterEach(() => {
    delete process.env.SCHEDULE_RDB_EXPORT_ALLOWED_TIERS;
    delete process.env.SCHEDULE_RDB_EXPORT_MAX_PER_INSTANCE;
  });

  it('returns 401-style errors for missing or malformed authorization tokens', () => {
    expect(getRequestorId(`Bearer ${sign({ userID: 'user-id' }, 'secret')}`)).toBe('user-id');
    expect(() => getRequestorId()).toThrow(expect.objectContaining({
      statusCode: 401,
      errorCode: 'INVALID_TOKEN',
    }));
    expect(() => getRequestorId('Bearer not-a-jwt')).toThrow(expect.objectContaining({
      statusCode: 401,
      errorCode: 'INVALID_TOKEN',
    }));
    expect(() => getRequestorId(`Bearer ${sign('string-payload', 'secret')}`)).toThrow(expect.objectContaining({
      statusCode: 401,
      errorCode: 'INVALID_TOKEN',
    }));
  });

  it('validates minimum one hour period and quarter-hour schedule minute', () => {
    expect(Value.Check(CreateScheduleRequestBodySchema, {
      type: 'RDBExport',
      payload: {
        instanceId: 'instance-id',
      },
      periodMinutes: 60,
      minuteOfHour: 15,
    })).toBe(true);

    expect(Value.Check(CreateScheduleRequestBodySchema, {
      type: 'RDBExport',
      payload: {
        instanceId: 'instance-id',
        username: 'falkordb',
        password: 'password',
      },
      periodMinutes: 60,
      minuteOfHour: 15,
    })).toBe(true);

    expect(Value.Check(CreateScheduleRequestBodySchema, {
      type: 'RDBExport',
      payload: {
        instanceId: 'instance-id',
        username: 'falkordb',
        password: 'password',
      },
      periodMinutes: 45,
      minuteOfHour: 15,
    })).toBe(false);

    expect(Value.Check(CreateScheduleRequestBodySchema, {
      type: 'RDBExport',
      payload: {
        instanceId: 'instance-id',
        username: 'falkordb',
        password: 'password',
      },
      periodMinutes: 60,
      minuteOfHour: 10,
    })).toBe(false);
  });

  it('rejects export schedules with empty target bucket names', () => {
    expect(Value.Check(CreateScheduleRequestBodySchema, {
      type: 'RDBExport',
      payload: {
        instanceId: 'instance-id',
        target: {
          type: 's3',
          bucketName: '',
          region: 'us-east-1',
          accessKeyId: 'access-key',
          secretAccessKey: 'secret-key',
        },
      },
      periodMinutes: 60,
      minuteOfHour: 15,
    })).toBe(false);
  });

  it('validates import schedules only support instance sources', () => {
    expect(Value.Check(CreateScheduleRequestBodySchema, {
      type: 'RDBImport',
      payload: {
        instanceId: 'instance-id',
        source: {
          type: 'instance',
          instanceId: 'source-instance-id',
          username: 'falkordb',
          password: 'password',
        },
      },
      periodMinutes: 60,
      minuteOfHour: 15,
    })).toBe(true);

    expect(Value.Check(CreateScheduleRequestBodySchema, {
      type: 'RDBImport',
      payload: {
        instanceId: 'instance-id',
        source: {
          type: 'url',
          url: 'https://example.com/dump.rdb',
        },
      },
      periodMinutes: 60,
      minuteOfHour: 15,
    })).toBe(false);
  });

  it('creates a schedule without exposing target credentials in the response', async () => {
    const { controller, schedulesRepository, omnistrateRepository } = makeController();

    const schedule = await controller.createSchedule({
      requestorId: 'user-id',
      type: 'RDBExport',
      payload: {
        instanceId: 'instance-id',
        target: {
          type: 's3',
          bucketName: 'customer-bucket',
          region: 'us-east-1',
          accessKeyId: 'access-key',
          secretAccessKey: 'secret-key',
        },
      },
      periodMinutes: 60,
      minuteOfHour: 30,
    });

    expect(omnistrateRepository.checkIfUserHasAccessToInstance).toHaveBeenCalledWith(
      'user-id',
      expect.objectContaining({ id: 'instance-id' }),
      undefined,
      ['root', 'editor', 'reader'],
    );
    expect(schedulesRepository.createSchedule).toHaveBeenCalledWith(expect.objectContaining({
      periodMinutes: 60,
      minuteOfHour: 30,
      failureThreshold: 3,
    }));
    expect(schedule.type).toBe('RDBExport');
    if (schedule.type !== 'RDBExport') {
      throw new Error(`Expected RDBExport schedule, got ${schedule.type}`);
    }
    expect((schedule.payload as { target?: unknown }).target).toEqual({
      type: 's3',
      bucketName: 'customer-bucket',
      region: 'us-east-1',
    });
    expect(JSON.stringify(schedule)).not.toContain('secret-key');
  });

  it('uses Pro and Enterprise as the default allowed tiers', async () => {
    delete process.env.SCHEDULE_RDB_EXPORT_ALLOWED_TIERS;
    const { controller, schedulesRepository } = makeController();

    await controller.createSchedule({
      requestorId: 'user-id',
      type: 'RDBExport',
      payload: {
        instanceId: 'instance-id',
        username: 'falkordb',
        password: 'password',
      },
      periodMinutes: 60,
      minuteOfHour: 30,
    });

    expect(schedulesRepository.createSchedule).toHaveBeenCalled();
  });

  it('uses the configured period when computing the first run time', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-11T10:30:00.000Z'));
    const { controller, schedulesRepository } = makeController();

    await controller.createSchedule({
      requestorId: 'user-id',
      type: 'RDBExport',
      payload: {
        instanceId: 'instance-id',
      },
      periodMinutes: 120,
      minuteOfHour: 15,
    });

    expect(schedulesRepository.createSchedule).toHaveBeenCalledWith(expect.objectContaining({
      nextRunAt: '2026-06-11T12:15:00.000Z',
    }));
    jest.useRealTimers();
  });

  it('rejects import schedule creation when an instance already has one import schedule', async () => {
    const { controller, schedulesRepository } = makeController({
      existingSchedules: [makeImportSchedule({ scheduleId: 'schedule-id-1' })],
    });

    await expect(controller.createSchedule({
      requestorId: 'user-id',
      type: 'RDBImport',
      payload: {
        instanceId: 'instance-id',
        source: {
          type: 'instance',
          instanceId: 'source-instance-id',
          username: 'falkordb',
          password: 'password',
        },
      },
      periodMinutes: 60,
      minuteOfHour: 30,
    })).rejects.toMatchObject({ errorCode: 'MAX_SCHEDULES_PER_INSTANCE_REACHED' });

    expect(schedulesRepository.createSchedule).not.toHaveBeenCalled();
  });

  it('rejects export schedule creation when an instance reaches the configured export schedule limit', async () => {
    process.env.SCHEDULE_RDB_EXPORT_MAX_PER_INSTANCE = '3';
    const { controller, schedulesRepository } = makeController({
      existingSchedules: [
        makeSchedule({ scheduleId: 'schedule-id-1' }),
        makeSchedule({ scheduleId: 'schedule-id-2' }),
        makeSchedule({ scheduleId: 'schedule-id-3' }),
      ],
    });

    await expect(controller.createSchedule({
      requestorId: 'user-id',
      type: 'RDBExport',
      payload: {
        instanceId: 'instance-id',
        username: 'falkordb',
        password: 'password',
      },
      periodMinutes: 60,
      minuteOfHour: 30,
    })).rejects.toMatchObject({ errorCode: 'MAX_SCHEDULES_PER_INSTANCE_REACHED' });

    expect(schedulesRepository.createSchedule).not.toHaveBeenCalled();
  });

  it('creates an import schedule with sanitized prepared instance source metadata', async () => {
    const { controller, schedulesRepository, omnistrateRepository } = makeController();

    const schedule = await controller.createSchedule({
      requestorId: 'user-id',
      type: 'RDBImport',
      payload: {
        instanceId: 'instance-id',
        source: {
          type: 'instance',
          instanceId: 'source-instance-id',
          username: 'falkordb',
          password: 'password',
        },
      },
      periodMinutes: 60,
      minuteOfHour: 30,
    });

    expect(omnistrateRepository.checkIfUserHasAccessToInstance).toHaveBeenCalledWith(
      'user-id',
      expect.objectContaining({ id: 'instance-id' }),
      undefined,
      ['root', 'editor'],
    );
    expect(omnistrateRepository.checkIfUserHasAccessToInstance).toHaveBeenCalledWith(
      'user-id',
      expect.objectContaining({ id: 'source-instance-id' }),
      undefined,
      ['root', 'editor', 'reader'],
    );
    expect(schedulesRepository.createSchedule).toHaveBeenCalledWith(expect.objectContaining({
      type: 'RDBImport',
      payload: expect.objectContaining({
        instanceId: 'instance-id',
        source: expect.objectContaining({
          type: 'instance',
          instanceId: 'source-instance-id',
          clusterId: 'source-cluster-id',
          podIds: ['node-f-0'],
        }),
      }),
    }));
    expect(schedule.payload).toEqual({
      instanceId: 'instance-id',
      source: {
        type: 'instance',
        instanceId: 'source-instance-id',
      },
    });
    expect(JSON.stringify(schedulesRepository.createSchedule.mock.calls[0][0])).not.toContain('password');
  });

  it('rejects invalid scheduled import sources without credential wording', async () => {
    const { controller, k8sRepository } = makeController();
    k8sRepository.getUsedMemoryDataset.mockResolvedValue(2 * 1024 * 1024 * 1024);

    await expect(controller.createSchedule({
      requestorId: 'user-id',
      type: 'RDBImport',
      payload: {
        instanceId: 'instance-id',
        source: {
          type: 'instance',
          instanceId: 'source-instance-id',
        },
      },
      periodMinutes: 60,
      minuteOfHour: 30,
    })).rejects.toMatchObject({
      message: 'Invalid scheduled import source',
      errorCode: 'INVALID_IMPORT_SOURCE',
    });
  });

  it('lists schedules with latest task status and failure details', async () => {
    const failedTask = makeImportTask('failed-import-task-id', 'failed', 'schedule-id');
    failedTask.errors = ['this field has unspecified keys: scheduleId'];
    failedTask.createdAt = '2026-06-15T08:19:01.041Z';
    failedTask.updatedAt = '2026-06-15T08:19:01.388Z';
    const { controller, tasksRepository } = makeController({
      existingSchedules: [makeImportSchedule()],
      failedTasks: [failedTask],
      scheduledTasks: [failedTask],
    });

    const schedules = await controller.listSchedules('user-id', {});

    expect(tasksRepository.listTasksByScheduleId).toHaveBeenCalledWith('schedule-id', {
      types: ['RDBImport'],
    });
    expect(schedules[0]).toEqual(expect.objectContaining({
      scheduleId: 'schedule-id',
      type: 'RDBImport',
      lastRunAt: '2026-06-15T08:19:01.041Z',
      lastTaskId: 'failed-import-task-id',
      lastTaskStatus: 'failed',
      lastFailure: 'this field has unspecified keys: scheduleId',
      lastFailureAt: '2026-06-15T08:19:01.388Z',
      consecutiveFailures: 1,
    }));
    expect(Value.Check(PublicScheduleSchema, schedules[0])).toBe(true);
  });

  it('deletes schedules after checking instance access', async () => {
    const schedule = makeSchedule({ scheduleId: 'delete-schedule-id' });
    const { controller, schedulesRepository, omnistrateRepository } = makeController({
      scheduleToGet: schedule,
    });

    const deleted = await controller.deleteSchedule('user-id', 'delete-schedule-id');

    expect(schedulesRepository.getSchedule).toHaveBeenCalledWith('delete-schedule-id');
    expect(omnistrateRepository.checkIfUserHasAccessToInstance).toHaveBeenCalledWith('user-id', undefined, 'instance-id', [
      'root',
      'editor',
      'reader',
    ]);
    expect(schedulesRepository.deleteSchedule).toHaveBeenCalledWith('delete-schedule-id');
    expect(deleted).toEqual(expect.objectContaining({
      scheduleId: 'delete-schedule-id',
      payload: expect.objectContaining({ instanceId: 'instance-id' }),
    }));
    expect(Value.Check(PublicScheduleSchema, deleted)).toBe(true);
  });

  it('returns not found when deleting a missing schedule', async () => {
    const { controller, schedulesRepository, omnistrateRepository } = makeController({
      scheduleToGet: null,
    });

    await expect(controller.deleteSchedule('user-id', 'missing-schedule-id')).rejects.toMatchObject({
      message: 'Schedule not found',
      errorCode: 'SCHEDULE_NOT_FOUND',
    });
    expect(omnistrateRepository.checkIfUserHasAccessToInstance).not.toHaveBeenCalled();
    expect(schedulesRepository.deleteSchedule).not.toHaveBeenCalled();
  });

  it('does not delete schedules without instance access', async () => {
    const { controller, schedulesRepository } = makeController({
      userHasAccess: false,
    });

    await expect(controller.deleteSchedule('user-id', 'schedule-id')).rejects.toMatchObject({
      message: "You don't have access to this instance",
      errorCode: 'FORBIDDEN',
    });
    expect(schedulesRepository.deleteSchedule).not.toHaveBeenCalled();
  });

  it('triggers due schedules by creating normal export tasks', async () => {
    const dueSchedule = makeSchedule({ nextRunAt: '2026-06-11T10:15:00.000Z' });
    const { controller, schedulesRepository, tasksRepository, taskQueueRepository } = makeController({
      dueSchedules: [dueSchedule],
      createdTask: makeTask('scheduled-task-id'),
    });

    const result = await controller.triggerDueSchedules(new Date('2026-06-11T10:15:00.000Z'));

    expect(tasksRepository.createTask).toHaveBeenCalledWith('SingleShardRDBExport', expect.objectContaining({
      instanceId: 'instance-id',
    }), { scheduleId: 'schedule-id' });
    expect(taskQueueRepository.submitExportRDBTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'scheduled-task-id',
    }));
    expect(schedulesRepository.updateNextRunAt).toHaveBeenCalledWith(
      'schedule-id',
      '2026-06-11T11:15:00.000Z',
    );
    expect(result.triggered).toEqual([{ scheduleId: 'schedule-id', taskId: 'scheduled-task-id' }]);
  });

  it('triggers due import schedules by creating normal import tasks', async () => {
    const dueSchedule = makeImportSchedule({ nextRunAt: '2026-06-11T10:15:00.000Z' });
    const { controller, schedulesRepository, tasksRepository, omnistrateRepository, taskQueueRepository } = makeController({
      dueSchedules: [dueSchedule],
      createdTask: makeImportTask('scheduled-import-task-id'),
    });

    const result = await controller.triggerDueSchedules(new Date('2026-06-11T10:15:00.000Z'));

    expect(tasksRepository.listTasksByScheduleId).toHaveBeenCalledWith('schedule-id', expect.objectContaining({
      types: ['RDBImport'],
    }));
    expect(tasksRepository.createTask).toHaveBeenCalledWith('RDBImport', expect.objectContaining({
      instanceId: 'instance-id',
      source: expect.objectContaining({
        type: 'instance',
        instanceId: 'source-instance-id',
      }),
    }), { scheduleId: 'schedule-id' });
    expect(taskQueueRepository.submitImportRDBTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'scheduled-import-task-id',
      status: 'in_progress',
    }));
    expect(omnistrateRepository.checkIfUserHasAccessToInstance).not.toHaveBeenCalled();
    expect(schedulesRepository.updateNextRunAt).toHaveBeenCalledWith(
      'schedule-id',
      '2026-06-11T11:15:00.000Z',
    );
    expect(result.triggered).toEqual([{ scheduleId: 'schedule-id', taskId: 'scheduled-import-task-id' }]);
  });

  it('disables due export schedules when the target instance is not running', async () => {
    const dueSchedule = makeSchedule({ nextRunAt: '2026-06-11T10:15:00.000Z' });
    const { controller, schedulesRepository, tasksRepository, taskQueueRepository } = makeController({
      dueSchedules: [dueSchedule],
      instanceStatuses: { 'instance-id': 'STOPPED' },
    });

    const result = await controller.triggerDueSchedules(new Date('2026-06-11T10:15:00.000Z'));

    expect(tasksRepository.createTask).not.toHaveBeenCalled();
    expect(taskQueueRepository.submitExportRDBTask).not.toHaveBeenCalled();
    expect(schedulesRepository.updateSchedule).toHaveBeenCalledWith('schedule-id', { enabled: false });
    expect(schedulesRepository.updateNextRunAt).not.toHaveBeenCalled();
    expect(result.disabled).toEqual([{ scheduleId: 'schedule-id', reason: 'instance instance-id is STOPPED' }]);
    expect(result.failed).toEqual([]);
  });

  it('disables due import schedules when the destination instance is not running', async () => {
    const dueSchedule = makeImportSchedule({ nextRunAt: '2026-06-11T10:15:00.000Z' });
    const { controller, schedulesRepository, tasksRepository, taskQueueRepository } = makeController({
      dueSchedules: [dueSchedule],
      instanceStatuses: { 'instance-id': 'DEPLOYING' },
    });

    const result = await controller.triggerDueSchedules(new Date('2026-06-11T10:15:00.000Z'));

    expect(tasksRepository.createTask).not.toHaveBeenCalled();
    expect(taskQueueRepository.submitImportRDBTask).not.toHaveBeenCalled();
    expect(schedulesRepository.updateSchedule).toHaveBeenCalledWith('schedule-id', { enabled: false });
    expect(schedulesRepository.updateNextRunAt).not.toHaveBeenCalled();
    expect(result.disabled).toEqual([{ scheduleId: 'schedule-id', reason: 'instance instance-id is DEPLOYING' }]);
    expect(result.failed).toEqual([]);
  });

  it('disables due import schedules when the source instance is not running', async () => {
    const dueSchedule = makeImportSchedule({ nextRunAt: '2026-06-11T10:15:00.000Z' });
    const { controller, schedulesRepository, tasksRepository, omnistrateRepository, taskQueueRepository } = makeController({
      dueSchedules: [dueSchedule],
      instanceStatuses: { 'source-instance-id': 'FAILED' },
    });

    const result = await controller.triggerDueSchedules(new Date('2026-06-11T10:15:00.000Z'));

    expect(omnistrateRepository.getInstance).toHaveBeenCalledWith('instance-id');
    expect(omnistrateRepository.getInstance).toHaveBeenCalledWith('source-instance-id');
    expect(tasksRepository.createTask).not.toHaveBeenCalled();
    expect(taskQueueRepository.submitImportRDBTask).not.toHaveBeenCalled();
    expect(schedulesRepository.updateSchedule).toHaveBeenCalledWith('schedule-id', { enabled: false });
    expect(schedulesRepository.updateNextRunAt).not.toHaveBeenCalled();
    expect(result.disabled).toEqual([{ scheduleId: 'schedule-id', reason: 'source instance source-instance-id is FAILED' }]);
    expect(result.failed).toEqual([]);
  });

  it('disables schedules when failed tasks reach the threshold', async () => {
    const dueSchedule = makeSchedule({
      failureThreshold: 2,
    });
    const { controller, schedulesRepository, tasksRepository } = makeController({
      dueSchedules: [dueSchedule],
      failedTasks: [makeTask('failed-task-id-1', 'failed', 'schedule-id'), makeTask('failed-task-id-2', 'failed', 'schedule-id')],
    });

    const result = await controller.triggerDueSchedules(new Date('2026-06-11T10:15:00.000Z'));

    expect(tasksRepository.createTask).not.toHaveBeenCalled();
    expect(schedulesRepository.updateSchedule).toHaveBeenCalledWith(
      'schedule-id',
      { enabled: false },
    );
    expect(result.disabled).toEqual([{ scheduleId: 'schedule-id', reason: 'failure threshold reached' }]);
  });

  it('reports messages from ApiError-like schedule trigger failures', async () => {
    const dueSchedule = makeSchedule({
      nextRunAt: '2026-06-11T10:15:00.000Z',
    });
    const { controller, tasksRepository } = makeController({
      dueSchedules: [dueSchedule],
    });
    jest.spyOn(tasksRepository, 'listTasksByScheduleId').mockRejectedValueOnce(
      ApiError.badRequest('Invalid export target credentials', 'INVALID_EXPORT_TARGET_CREDENTIALS'),
    );

    const result = await controller.triggerDueSchedules(new Date('2026-06-11T10:15:00.000Z'));

    expect(result.failed).toEqual([{ scheduleId: 'schedule-id', error: 'Invalid export target credentials' }]);
  });

  it('disables schedules immediately for non-transient trigger failures', async () => {
    const dueSchedule = makeSchedule({
      nextRunAt: '2026-06-11T10:15:00.000Z',
      failureThreshold: 10,
    });
    const { controller, schedulesRepository, tasksRepository } = makeController({
      dueSchedules: [dueSchedule],
    });
    jest.spyOn(tasksRepository, 'listTasksByScheduleId').mockRejectedValueOnce(
      ApiError.badRequest('Invalid export target credentials', 'INVALID_EXPORT_TARGET_CREDENTIALS'),
    );

    const result = await controller.triggerDueSchedules(new Date('2026-06-11T10:15:00.000Z'));

    expect(schedulesRepository.updateSchedule).toHaveBeenCalledWith('schedule-id', { enabled: false });
    expect(result.disabled).toEqual([{ scheduleId: 'schedule-id', reason: 'Invalid export target credentials' }]);
    expect(result.failed).toEqual([{ scheduleId: 'schedule-id', error: 'Invalid export target credentials' }]);
  });
});