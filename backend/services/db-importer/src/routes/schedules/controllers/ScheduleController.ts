import { FastifyBaseLogger } from 'fastify';
import { ApiError } from '@falkordb/errors';
import { PublicSchedule, ScheduleDocument, ScheduleType } from '@falkordb/schemas/services/import-export-rdb/v1';
import {
  RDBExportPublicTargetType,
  RDBExportTargetType,
  RDBImportRequestSourceType,
  RDBImportSourceType,
  TaskDocumentType,
  TaskStatusType,
  TaskTypesType,
} from '@falkordb/schemas/global';
import { randomUUID } from 'crypto';
import { ITasksDBRepository } from '../../../repositories/tasks';
import { ISchedulesDBRepository } from '../../../repositories/schedules';
import { OmnistrateRepository } from '../../../repositories/omnistrate/OmnistrateRepository';
import { ITaskQueueRepository } from '../../../repositories/tasksQueue/ITaskQueueRepository';
import { OmnistrateInstanceSchemaType } from '../../../schemas/omnistrate-instance';
import { RDBExportTaskService } from '../../../services/RDBExportTaskService';
import { RDBImportTaskService } from '../../../services/RDBImportTaskService';
import { K8sRepository } from '../../../repositories/k8s/K8sRepository';

const EXPORT_TASK_TYPES: TaskTypesType[] = ['SingleShardRDBExport', 'MultiShardRDBExport'];
const IMPORT_TASK_TYPES: TaskTypesType[] = ['RDBImport'];
const RUNNING_TASK_STATUSES = ['created', 'pending', 'in_progress'] as const;
const DEFAULT_RDB_EXPORT_ALLOWED_TIERS = ['FalkorDB Pro', 'FalkorDB Enterprise'];
const RDB_IMPORT_MAX_SCHEDULES_PER_INSTANCE = 1;
const NON_TRANSIENT_SCHEDULE_ERROR_CODES = new Set([
  'BYOA_NOT_SUPPORTED',
  'INSTANCE_NOT_FOUND',
  'INVALID_EXPORT_TARGET_CREDENTIALS',
  'INVALID_IMPORT_SOURCE',
  'INVALID_SCHEDULE_IMPORT_SOURCE',
  'INVALID_SCHEDULE_TYPE',
  'SCHEDULED_EXPORT_TIER_NOT_ALLOWED',
]);

type TriggerScheduleResult = {
  triggered: { scheduleId: string; taskId: string }[];
  skipped: { scheduleId: string; reason: string }[];
  disabled: { scheduleId: string; reason: string }[];
  failed: { scheduleId: string; error: string }[];
};

type RDBExportSchedulePayload = { instanceId: string; target?: RDBExportTargetType };
type RDBImportSchedulePayload = { instanceId: string; source: Extract<RDBImportSourceType, { type: 'instance' }> };
type PublicScheduleRunState = {
  lastRunAt?: string;
  lastTaskId?: string;
  lastTaskStatus?: TaskStatusType;
  lastFailure?: string;
  lastFailureAt?: string;
  consecutiveFailures?: number;
};

type ErrorLike = {
  message?: unknown;
  errorCode?: unknown;
};

export class ScheduleController {
  constructor(
    private schedulesRepository: ISchedulesDBRepository,
    private tasksRepository: ITasksDBRepository,
    private omnistrateRepository: OmnistrateRepository,
    private k8sRepository: K8sRepository,
    private taskQueueRepository: ITaskQueueRepository,
    private _exportBucketName: string,
    private _importBucketName: string,
    private _scheduleOptions: {
      defaultFailureThreshold: number;
      rdbExportAllowedTiers: string;
      rdbExportMaxPerInstance: number;
    },
    private _opts: { logger: FastifyBaseLogger },
  ) { }

  private _sanitizeTarget(target?: RDBExportTargetType): RDBExportPublicTargetType | undefined {
    if (!target || target.type === 'default') {
      return target;
    }
    if (target.type === 'gcs') {
      return {
        type: 'gcs',
        bucketName: target.bucketName,
      };
    }
    if (target.type === 's3') {
      return {
        type: 's3',
        bucketName: target.bucketName,
        region: target.region,
      };
    }

    return target;
  }

  private _toPublicSchedule(schedule: ScheduleDocument, runState: PublicScheduleRunState = {}): PublicSchedule {
    if (schedule.type === 'RDBImport') {
      const payload = schedule.payload as RDBImportSchedulePayload;
      return {
        ...schedule,
        ...runState,
        payload: {
          instanceId: payload.instanceId,
          source: {
            type: 'instance',
            instanceId: payload.source.instanceId,
          },
        },
      };
    }

    const payload = schedule.payload as RDBExportSchedulePayload;
    return {
      ...schedule,
      ...runState,
      payload: {
        ...payload,
        target: this._sanitizeTarget(payload.target),
      },
    };
  }

  private _defaultFailureThreshold(): number {
    const value = this._scheduleOptions.defaultFailureThreshold;
    return Number.isInteger(value) && value > 0 ? value : 3;
  }

  private _rdbExportMaxSchedulesPerInstance(): number {
    const value = this._scheduleOptions.rdbExportMaxPerInstance;
    return Number.isInteger(value) && value > 0 ? value : 2;
  }

  private _getRDBExportScheduleAllowedTiers(): string[] {
    const configuredTiers = this._scheduleOptions.rdbExportAllowedTiers
      .split(',')
      .map((tier) => tier.trim())
      .filter(Boolean);

    return configuredTiers.length > 0 ? configuredTiers : DEFAULT_RDB_EXPORT_ALLOWED_TIERS;
  }

  private _assertRDBExportScheduleTier(instance: OmnistrateInstanceSchemaType): void {
    const allowedTiers = this._getRDBExportScheduleAllowedTiers();
    if (allowedTiers.length === 0 || allowedTiers.includes('all') || allowedTiers.includes(instance.productTierName)) {
      return;
    }

    throw ApiError.forbidden('Scheduled exports are not available for this tier', 'SCHEDULED_EXPORT_TIER_NOT_ALLOWED');
  }

  private _makeExportTaskService(): RDBExportTaskService {
    return new RDBExportTaskService(
      this.tasksRepository,
      this.omnistrateRepository,
      this.taskQueueRepository,
      this._exportBucketName,
      this._opts,
    );
  }

  private _makeImportTaskService(): RDBImportTaskService {
    return new RDBImportTaskService(
      this.tasksRepository,
      this.omnistrateRepository,
      this.k8sRepository,
      this.taskQueueRepository,
      this._importBucketName,
      this._opts,
    );
  }

  private _nextRunAt(periodMinutes: number, minuteOfHour: 0 | 15 | 30 | 45, from = new Date()): string {
    const next = new Date(from);
    next.setUTCSeconds(0, 0);
    next.setUTCMinutes(minuteOfHour);
    while (next <= from) {
      next.setTime(next.getTime() + periodMinutes * 60 * 1000);
    }
    return next.toISOString();
  }

  private _nextRunAfter(schedule: ScheduleDocument, from = new Date()): string {
    let next = new Date(schedule.nextRunAt);
    if (Number.isNaN(next.getTime())) {
      return this._nextRunAt(schedule.periodMinutes, schedule.minuteOfHour, from);
    }
    while (next <= from) {
      next = new Date(next.getTime() + schedule.periodMinutes * 60 * 1000);
    }
    return next.toISOString();
  }

  private async _assertUserHasExportAccess(requestorId: string, instance: OmnistrateInstanceSchemaType): Promise<void> {
    const hasAccess = await this.omnistrateRepository.checkIfUserHasAccessToInstance(requestorId, instance, undefined, [
      'root',
      'editor',
      'reader',
    ]);

    if (!hasAccess) {
      throw ApiError.unauthorized('User does not have access to this instance', 'USER_NOT_AUTHORIZED');
    }
  }

  private async _assertScheduleAccess(requestorId: string, instanceId: string): Promise<void> {
    const hasAccess = await this.omnistrateRepository.checkIfUserHasAccessToInstance(requestorId, undefined, instanceId, [
      'root',
      'editor',
      'reader',
    ]);
    if (!hasAccess) {
      throw ApiError.forbidden("You don't have access to this instance", 'FORBIDDEN');
    }
  }

  private async _assertInstanceScheduleLimit(type: ScheduleType, instanceId: string): Promise<void> {
    const existingSchedules = await this.schedulesRepository.listSchedules({ type, instanceId });
    const maxSchedules = type === 'RDBImport'
      ? RDB_IMPORT_MAX_SCHEDULES_PER_INSTANCE
      : this._rdbExportMaxSchedulesPerInstance();
    if (existingSchedules.length >= maxSchedules) {
      throw ApiError.badRequest('Maximum schedules per instance reached', 'MAX_SCHEDULES_PER_INSTANCE_REACHED');
    }
  }

  private async _createRDBExportTask(schedule: ScheduleDocument): Promise<{ taskId: string }> {
    const exportTaskService = this._makeExportTaskService();
    const payload = schedule.payload as RDBExportSchedulePayload;
    const instance = await exportTaskService.getExportableInstance(payload.instanceId);
    this._assertRDBExportScheduleTier(instance);

    return exportTaskService.createAndSubmitTask({
      instance,
      target: payload.target,
      scheduleId: schedule.scheduleId,
    });
  }

  private async _createRDBImportTask(schedule: ScheduleDocument): Promise<{ taskId: string }> {
    if (schedule.type !== 'RDBImport') {
      throw ApiError.badRequest('Invalid schedule type', 'INVALID_SCHEDULE_TYPE');
    }

    const importTaskService = this._makeImportTaskService();
    const payload = schedule.payload as RDBImportSchedulePayload;
    const instance = await importTaskService.getImportableInstanceWithoutAccessCheck(payload.instanceId);
    return importTaskService.createAndSubmitTask({
      instance,
      source: payload.source,
      scheduleId: schedule.scheduleId,
    });
  }

  private _taskTypesForSchedule(type: ScheduleType): TaskTypesType[] {
    return type === 'RDBImport' ? IMPORT_TASK_TYPES : EXPORT_TASK_TYPES;
  }

  private _getLastTaskFailure(task?: TaskDocumentType): string | undefined {
    if (!task || task.status !== 'failed') {
      return undefined;
    }

    return task.errors?.at(-1) ?? task.error;
  }

  private async _getScheduleRunState(schedule: ScheduleDocument): Promise<PublicScheduleRunState> {
    const tasks = await this.tasksRepository.listTasksByScheduleId(schedule.scheduleId, {
      types: this._taskTypesForSchedule(schedule.type),
    });
    const latestTask = tasks[0];
    const failedTasks = tasks.filter((task) => task.status === 'failed');
    const latestFailedTask = failedTasks[0];

    return {
      lastRunAt: latestTask?.createdAt,
      lastTaskId: latestTask?.taskId,
      lastTaskStatus: latestTask?.status,
      lastFailure: this._getLastTaskFailure(latestFailedTask),
      lastFailureAt: latestFailedTask?.updatedAt,
      consecutiveFailures: failedTasks.length,
    };
  }

  private async _toPublicScheduleWithRunState(schedule: ScheduleDocument): Promise<PublicSchedule> {
    return this._toPublicSchedule(schedule, await this._getScheduleRunState(schedule));
  }

  private _errorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    const message = error && typeof error === 'object' ? (error as ErrorLike).message : undefined;
    if (typeof message === 'string') {
      return message;
    }
    return String(error);
  }

  private _errorCode(error: unknown): string | undefined {
    const errorCode = error && typeof error === 'object' ? (error as ErrorLike).errorCode : undefined;
    return typeof errorCode === 'string' ? errorCode : undefined;
  }

  private _isNonTransientScheduleError(error: unknown): boolean {
    const errorCode = this._errorCode(error);
    return !!errorCode && NON_TRANSIENT_SCHEDULE_ERROR_CODES.has(errorCode);
  }

  private async _createTaskForSchedule(schedule: ScheduleDocument): Promise<{ taskId: string }> {
    if (schedule.type === 'RDBImport') {
      return this._createRDBImportTask(schedule);
    }

    return this._createRDBExportTask(schedule);
  }

  async createSchedule({
    requestorId,
    type,
    payload,
    periodMinutes,
    minuteOfHour,
    failureThreshold,
  }: {
    requestorId: string;
    type: ScheduleType;
    payload: {
      instanceId: string;
      username?: string;
      password?: string;
      target?: RDBExportTargetType;
      source?: Extract<RDBImportRequestSourceType, { type: 'instance' }>;
    };
    periodMinutes: number;
    minuteOfHour: 0 | 15 | 30 | 45;
    failureThreshold?: number;
  }): Promise<PublicSchedule> {
    await this._assertInstanceScheduleLimit(type, payload.instanceId);

    let schedulePayload: { instanceId: string; target?: RDBExportTargetType } | { instanceId: string; source: Extract<RDBImportSourceType, { type: 'instance' }> };
    if (type === 'RDBImport') {
      if (!payload.source || payload.source.type !== 'instance') {
        throw ApiError.badRequest('Scheduled imports only support instance sources', 'INVALID_SCHEDULE_IMPORT_SOURCE');
      }

      const importTaskService = this._makeImportTaskService();
      const instance = await importTaskService.getImportableInstance(requestorId, payload.instanceId);
      const pendingTasks = await importTaskService.getPendingImportTasks(payload.instanceId);
      if (pendingTasks.length > 0) {
        throw ApiError.conflict('There is already a task in progress', 'TASK_IN_PROGRESS');
      }
      const maxMemory = await importTaskService.getMaxMemory(instance);
      if (!maxMemory) {
        throw ApiError.internalServerError('Instance size is not set', 'INSTANCE_SIZE_NOT_SET');
      }
      let source: Extract<RDBImportSourceType, { type: 'instance' }>;
      try {
        source = await importTaskService.prepareInstanceSource({
          source: payload.source,
          requestorId,
          destinationInstanceId: payload.instanceId,
          destinationMaxMemoryBytes: parseInt(maxMemory, 10),
          destinationIsCluster: instance.deploymentType.startsWith('Cluster'),
        });
      } catch (error) {
        this._opts.logger.warn({ error }, 'Invalid scheduled import source');
        throw ApiError.badRequest('Invalid scheduled import source', 'INVALID_IMPORT_SOURCE');
      }
      schedulePayload = {
        instanceId: payload.instanceId,
        source,
      };
    } else {
      const exportTaskService = this._makeExportTaskService();
      const instance = await exportTaskService.getExportableInstance(payload.instanceId);
      this._assertRDBExportScheduleTier(instance);
      await this._assertUserHasExportAccess(requestorId, instance);
      await exportTaskService.verifyTargetWriteAccess(payload.target, `exports/${instance.id}/schedule-validation-${randomUUID()}.rdb`);
      schedulePayload = {
        instanceId: payload.instanceId,
        target: payload.target,
      };
    }

    const schedule = await this.schedulesRepository.createSchedule({
      requestorId,
      type,
      payload: schedulePayload,
      periodMinutes,
      minuteOfHour,
      failureThreshold: failureThreshold ?? this._defaultFailureThreshold(),
      nextRunAt: this._nextRunAt(periodMinutes, minuteOfHour),
    });

    return this._toPublicSchedule(schedule);
  }

  async listSchedules(requestorId: string, filters: { type?: ScheduleType; instanceId?: string }): Promise<PublicSchedule[]> {
    if (filters.instanceId) {
      await this._assertScheduleAccess(requestorId, filters.instanceId);
    }
    const schedules = await this.schedulesRepository.listSchedules(filters);
    return Promise.all(schedules.map((schedule) => this._toPublicScheduleWithRunState(schedule)));
  }

  async updateSchedule(requestorId: string, scheduleId: string, update: { enabled?: boolean }): Promise<PublicSchedule> {
    const schedule = await this.schedulesRepository.getSchedule(scheduleId);
    if (!schedule) {
      throw ApiError.notFound('Schedule not found', 'SCHEDULE_NOT_FOUND');
    }
    await this._assertScheduleAccess(requestorId, schedule.payload.instanceId);
    const updated = await this.schedulesRepository.updateSchedule(scheduleId, update);
    return this._toPublicScheduleWithRunState(updated);
  }

  private async _triggerSchedule(schedule: ScheduleDocument, now: Date): Promise<TriggerScheduleResult> {
    try {
      const taskTypes = this._taskTypesForSchedule(schedule.type);
      const [runningTasks, failedTasks] = await Promise.all([
        this.tasksRepository.listTasksByScheduleId(schedule.scheduleId, {
          status: [...RUNNING_TASK_STATUSES],
          types: taskTypes,
        }),
        this.tasksRepository.listTasksByScheduleId(schedule.scheduleId, {
          status: ['failed'],
          types: taskTypes,
        }),
      ]);

      if (runningTasks.length > 0) {
        return {
          triggered: [],
          skipped: [{ scheduleId: schedule.scheduleId, reason: 'previous task is still running' }],
          disabled: [],
          failed: [],
        };
      }

      if (failedTasks.length >= schedule.failureThreshold) {
        await this.schedulesRepository.updateSchedule(schedule.scheduleId, { enabled: false });
        return {
          triggered: [],
          skipped: [],
          disabled: [{ scheduleId: schedule.scheduleId, reason: 'failure threshold reached' }],
          failed: [],
        };
      }

      const { taskId } = await this._createTaskForSchedule(schedule);
      await this.schedulesRepository.updateNextRunAt(schedule.scheduleId, this._nextRunAfter(schedule, now));

      return {
        triggered: [{ scheduleId: schedule.scheduleId, taskId }],
        skipped: [],
        disabled: [],
        failed: [],
      };
    } catch (error) {
      const message = this._errorMessage(error);
      this._opts.logger.error({ error, scheduleId: schedule.scheduleId, type: schedule.type }, 'Error triggering schedule');
      if (this._isNonTransientScheduleError(error)) {
        await this.schedulesRepository.updateSchedule(schedule.scheduleId, { enabled: false });
        return {
          triggered: [],
          skipped: [],
          disabled: [{ scheduleId: schedule.scheduleId, reason: message }],
          failed: [{ scheduleId: schedule.scheduleId, error: message }],
        };
      }
      return {
        triggered: [],
        skipped: [],
        disabled: [],
        failed: [{ scheduleId: schedule.scheduleId, error: message }],
      };
    }
  }

  async triggerDueSchedules(now = new Date()): Promise<TriggerScheduleResult> {
    const schedules = await this.schedulesRepository.listDueSchedules(now);
    const results = await Promise.all(schedules.map((schedule) => this._triggerSchedule(schedule, now)));

    return results.reduce<TriggerScheduleResult>((acc, result) => ({
      triggered: acc.triggered.concat(result.triggered),
      skipped: acc.skipped.concat(result.skipped),
      disabled: acc.disabled.concat(result.disabled),
      failed: acc.failed.concat(result.failed),
    }), { triggered: [], skipped: [], disabled: [], failed: [] });
  }
}