import { FastifyBaseLogger } from 'fastify';
import { ApiError } from '@falkordb/errors';
import { PublicSchedule, ScheduleDocument } from '@falkordb/schemas/services/import-export-rdb/v1';
import {
  RDBExportPublicTargetType,
  RDBExportTargetType,
  TaskTypesType,
} from '@falkordb/schemas/global';
import { randomUUID } from 'crypto';
import { ITasksDBRepository } from '../../../repositories/tasks';
import { ISchedulesDBRepository } from '../../../repositories/schedules';
import { OmnistrateRepository } from '../../../repositories/omnistrate/OmnistrateRepository';
import { K8sRepository } from '../../../repositories/k8s/K8sRepository';
import { ITaskQueueRepository } from '../../../repositories/tasksQueue/ITaskQueueRepository';
import { OmnistrateInstanceSchemaType } from '../../../schemas/omnistrate-instance';
import { RDBExportTaskService } from '../../../services/RDBExportTaskService';

const EXPORT_TASK_TYPES: TaskTypesType[] = ['SingleShardRDBExport', 'MultiShardRDBExport'];
const RUNNING_TASK_STATUSES = ['created', 'pending', 'in_progress'] as const;
const DEFAULT_RDB_EXPORT_ALLOWED_TIERS = ['FalkorDB Pro', 'FalkorDB Enterprise'];
const MAX_SCHEDULES_PER_INSTANCE = 2;

type TriggerScheduleResult = {
  triggered: { scheduleId: string; taskId: string }[];
  skipped: { scheduleId: string; reason: string }[];
  disabled: { scheduleId: string; reason: string }[];
  failed: { scheduleId: string; error: string }[];
};

export class ScheduleController {
  constructor(
    private schedulesRepository: ISchedulesDBRepository,
    private tasksRepository: ITasksDBRepository,
    private omnistrateRepository: OmnistrateRepository,
    private k8sRepository: K8sRepository,
    private taskQueueRepository: ITaskQueueRepository,
    private _exportBucketName: string,
    private _scheduleOptions: {
      defaultFailureThreshold: number;
      rdbExportAllowedTiers: string;
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

  private _toPublicSchedule(schedule: ScheduleDocument): PublicSchedule {
    return {
      ...schedule,
      payload: {
        ...schedule.payload,
        target: this._sanitizeTarget(schedule.payload.target),
      },
    };
  }

  private _defaultFailureThreshold(): number {
    const value = this._scheduleOptions.defaultFailureThreshold;
    return Number.isInteger(value) && value > 0 ? value : 3;
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
    if (allowedTiers.length === 0 || allowedTiers.includes(instance.productTierName)) {
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

  private _nextRunAt(periodMinutes: number, minuteOfHour: 0 | 15 | 30 | 45, from = new Date()): string {
    const next = new Date(from);
    next.setUTCSeconds(0, 0);
    next.setUTCMinutes(minuteOfHour);
    if (next <= from) {
      next.setUTCHours(next.getUTCHours() + 1);
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

  private async _assertInstanceScheduleLimit(type: 'RDBExport', instanceId: string): Promise<void> {
    const existingSchedules = await this.schedulesRepository.listSchedules({ type, instanceId });
    if (existingSchedules.length >= MAX_SCHEDULES_PER_INSTANCE) {
      throw ApiError.badRequest('Maximum schedules per instance reached', 'MAX_SCHEDULES_PER_INSTANCE_REACHED');
    }
  }

  private async _assertAdminCredentials(
    instance: OmnistrateInstanceSchemaType,
    podId: string,
    username: string,
    password: string,
  ): Promise<void> {
    let isAdmin = false;
    try {
      isAdmin = await this.k8sRepository.isUserAdmin(
        instance.cloudProvider,
        instance.clusterId,
        instance.region,
        instance.id,
        podId,
        username,
        password,
        instance.tls,
      );
    } catch (error) {
      this._opts.logger.error({ error }, 'Error validating credentials');
      throw ApiError.internalServerError('Error validating credentials', 'CREDENTIALS_ERROR');
    }

    if (!isAdmin) {
      throw ApiError.unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
    }
  }

  private async _createRDBExportTask(schedule: ScheduleDocument): Promise<{ taskId: string }> {
    const exportTaskService = this._makeExportTaskService();
    const instance = await exportTaskService.getExportableInstance(schedule.payload.instanceId);
    this._assertRDBExportScheduleTier(instance);

    return exportTaskService.createAndSubmitTask({
      instance,
      target: schedule.payload.target,
      scheduleId: schedule.scheduleId,
    });
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
    type: 'RDBExport';
    payload: {
      instanceId: string;
      username: string;
      password: string;
      target?: RDBExportTargetType;
    };
    periodMinutes: number;
    minuteOfHour: 0 | 15 | 30 | 45;
    failureThreshold?: number;
  }): Promise<PublicSchedule> {
    const exportTaskService = this._makeExportTaskService();
    const instance = await exportTaskService.getExportableInstance(payload.instanceId);
    this._assertRDBExportScheduleTier(instance);
    await this._assertUserHasExportAccess(requestorId, instance);
    await this._assertInstanceScheduleLimit(type, payload.instanceId);

    const podId = exportTaskService.resolvePrimaryPodId(instance);
    await this._assertAdminCredentials(instance, podId, payload.username, payload.password);
    await exportTaskService.verifyTargetWriteAccess(payload.target, `exports/${instance.id}/schedule-validation-${randomUUID()}.rdb`);

    const schedule = await this.schedulesRepository.createSchedule({
      requestorId,
      type,
      payload: {
        instanceId: payload.instanceId,
        target: payload.target,
      },
      periodMinutes,
      minuteOfHour,
      failureThreshold: failureThreshold ?? this._defaultFailureThreshold(),
      nextRunAt: this._nextRunAt(periodMinutes, minuteOfHour),
    });

    return this._toPublicSchedule(schedule);
  }

  async listSchedules(requestorId: string, filters: { type?: 'RDBExport'; instanceId?: string }): Promise<PublicSchedule[]> {
    if (filters.instanceId) {
      await this._assertScheduleAccess(requestorId, filters.instanceId);
    }
    const schedules = await this.schedulesRepository.listSchedules(filters);
    return schedules.map((schedule) => this._toPublicSchedule(schedule));
  }

  async updateSchedule(requestorId: string, scheduleId: string, update: { enabled?: boolean }): Promise<PublicSchedule> {
    const schedule = await this.schedulesRepository.getSchedule(scheduleId);
    if (!schedule) {
      throw ApiError.notFound('Schedule not found', 'SCHEDULE_NOT_FOUND');
    }
    await this._assertScheduleAccess(requestorId, schedule.payload.instanceId);
    const updated = await this.schedulesRepository.updateSchedule(scheduleId, update);
    return this._toPublicSchedule(updated);
  }

  private async _triggerSchedule(schedule: ScheduleDocument, now: Date): Promise<TriggerScheduleResult> {
    try {
      const [runningTasks, failedTasks] = await Promise.all([
        this.tasksRepository.listTasksByScheduleId(schedule.scheduleId, {
          status: [...RUNNING_TASK_STATUSES],
          types: EXPORT_TASK_TYPES,
        }),
        this.tasksRepository.listTasksByScheduleId(schedule.scheduleId, {
          status: ['failed'],
          types: EXPORT_TASK_TYPES,
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

      if (schedule.type !== 'RDBExport') {
        return {
          triggered: [],
          skipped: [{ scheduleId: schedule.scheduleId, reason: 'unsupported schedule type' }],
          disabled: [],
          failed: [],
        };
      }

      const { taskId } = await this._createRDBExportTask(schedule);
      await this.schedulesRepository.updateNextRunAt(schedule.scheduleId, this._nextRunAfter(schedule, now));

      return {
        triggered: [{ scheduleId: schedule.scheduleId, taskId }],
        skipped: [],
        disabled: [],
        failed: [],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._opts.logger.error({ error, scheduleId: schedule.scheduleId }, 'Error triggering scheduled export');
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