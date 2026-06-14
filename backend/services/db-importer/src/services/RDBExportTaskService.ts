import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ApiError } from '@falkordb/errors';
import {
  ExportRDBTaskType,
  MultiShardRDBExportPayloadType,
  RDBExportTargetType,
  RDBExportTaskPayloadType,
  SingleShardRDBExportPayloadType,
  TaskDocumentType,
  TaskTypesType,
} from '@falkordb/schemas/global';
import { Storage } from '@google-cloud/storage';
import { FastifyBaseLogger } from 'fastify';
import { randomUUID } from 'crypto';
import { OmnistrateInstanceSchemaType } from '../schemas/omnistrate-instance';
import { ITasksDBRepository } from '../repositories/tasks';
import { ITaskQueueRepository } from '../repositories/tasksQueue/ITaskQueueRepository';
import { OmnistrateRepository } from '../repositories/omnistrate/OmnistrateRepository';

const EXPORT_TASK_TYPES: TaskTypesType[] = ['SingleShardRDBExport', 'MultiShardRDBExport'];

export class RDBExportTaskService {
  constructor(
    private tasksRepository: ITasksDBRepository,
    private omnistrateRepository: OmnistrateRepository,
    private taskQueueRepository: ITaskQueueRepository,
    private _exportBucketName: string,
    private _opts: { logger: FastifyBaseLogger },
  ) { }

  resolvePodPrefix(instance: OmnistrateInstanceSchemaType): string {
    switch (instance.deploymentType) {
      case 'Standalone':
        return 'node-s';
      case 'Single-Zone':
        return 'node-sz';
      case 'Multi-Zone':
        return 'node-mz';
      case 'Cluster-Single-Zone':
        return 'cluster-sz';
      case 'Cluster-Multi-Zone':
        return 'cluster-mz';
      default:
        return 'node-f';
    }
  }

  resolvePrimaryPodId(instance: OmnistrateInstanceSchemaType): string {
    return `${this.resolvePodPrefix(instance)}-0`;
  }

  getTaskType(instance: OmnistrateInstanceSchemaType): TaskTypesType {
    switch (instance.deploymentType) {
      case 'Standalone':
      case 'Single-Zone':
      case 'Multi-Zone':
        return 'SingleShardRDBExport';
      case 'Cluster-Single-Zone':
      case 'Cluster-Multi-Zone':
        return 'MultiShardRDBExport';
      default:
        return 'SingleShardRDBExport';
    }
  }

  resolveDestinationFileName(instanceId: string): string {
    return `exports/${instanceId}/${randomUUID()}.rdb`;
  }

  createTaskPayload(
    taskType: TaskTypesType,
    instance: OmnistrateInstanceSchemaType,
    podId: string,
    target: RDBExportTargetType,
    destinationFileName: string,
  ): RDBExportTaskPayloadType {
    if (taskType === 'SingleShardRDBExport') {
      return {
        instanceId: instance.id,
        podId,
        cloudProvider: instance.cloudProvider,
        clusterId: instance.clusterId,
        region: instance.region,
        hasTLS: instance.tls,
        destination: {
          bucketName: this._exportBucketName,
          fileName: destinationFileName,
          expiresIn: 60 * 60 * 1000,
          target,
        },
      } as SingleShardRDBExportPayloadType;
    }

    if (taskType === 'MultiShardRDBExport') {
      const pods = [0, 2, 4].map((i) => `${this.resolvePodPrefix(instance)}-${i}`);
      return {
        instanceId: instance.id,
        podId,
        cloudProvider: instance.cloudProvider,
        clusterId: instance.clusterId,
        region: instance.region,
        hasTLS: instance.tls,
        destination: {
          nodes: pods.map((podId) => ({
            podId,
            partFileName: `exports/${instance.id}/${podId}.rdb`,
          })),
          fileName: destinationFileName,
          bucketName: this._exportBucketName,
          expiresIn: 60 * 60 * 1000,
          target,
        },
      } as MultiShardRDBExportPayloadType;
    }

    throw new Error(`Unsupported RDB export task type: ${taskType}`);
  }

  async getExportableInstance(instanceId: string): Promise<OmnistrateInstanceSchemaType> {
    let instance: OmnistrateInstanceSchemaType | undefined;
    try {
      instance = await this.omnistrateRepository.getInstance(instanceId);
    } catch (error) {
      this._opts.logger.error({ error }, 'Error getting instance');
      throw ApiError.internalServerError('Error getting instance', 'INSTANCE_ERROR');
    }

    if (!instance) {
      throw ApiError.notFound('Instance not found', 'INSTANCE_NOT_FOUND');
    }
    if (instance.status !== 'RUNNING') {
      throw ApiError.badRequest('Instance is not running', 'INSTANCE_NOT_RUNNING');
    }
    if (instance.productTierName === 'FalkorDB BYOA') {
      throw ApiError.badRequest('BYOA instances are not supported', 'BYOA_NOT_SUPPORTED');
    }

    return instance;
  }

  async verifyTargetWriteAccess(target: RDBExportTargetType | undefined, fileName: string): Promise<void> {
    if (target?.type !== 'gcs' && target?.type !== 's3') {
      return;
    }

    try {
      if (target.type === 'gcs') {
        const storage = new Storage({
          projectId: target.credentials.project_id,
          credentials: target.credentials,
        });

        await storage.bucket(target.bucketName).file(fileName).save(Buffer.alloc(0), {
          contentType: 'application/octet-stream',
          resumable: false,
        });
        return;
      }

      const s3Client = new S3Client({
        region: target.region,
        credentials: {
          accessKeyId: target.accessKeyId,
          secretAccessKey: target.secretAccessKey,
          sessionToken: target.sessionToken,
        },
      });

      await s3Client.send(
        new PutObjectCommand({
          Bucket: target.bucketName,
          Key: fileName,
          Body: new Uint8Array(),
          ContentType: 'application/octet-stream',
        }),
      );
    } catch (error) {
      this._opts.logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
          target: {
            type: target.type,
            bucketName: target.bucketName,
            region: target.type === 's3' ? target.region : undefined,
          },
        },
        'Error validating export target write access',
      );
      throw ApiError.badRequest('Invalid export target credentials', 'INVALID_EXPORT_TARGET_CREDENTIALS');
    }
  }

  async getPendingExportTasks(instanceId: string): Promise<TaskDocumentType[]> {
    try {
      const tasks = await this.tasksRepository
        .listTasks(instanceId, {
          page: 1,
          pageSize: 1,
          status: ['created', 'pending', 'in_progress'],
          types: EXPORT_TASK_TYPES,
        })
        .then((result) => result.data);
      const now = Date.now();
      return tasks.filter((task) => new Date(task.createdAt).getTime() + 60 * 60 * 1000 > now);
    } catch (error) {
      this._opts.logger.error({ error }, 'Error getting pending tasks');
      throw ApiError.internalServerError('Error getting pending tasks', 'PENDING_TASKS_ERROR');
    }
  }

  async createAndSubmitTask({
    instance,
    target = {},
    scheduleId,
  }: {
    instance: OmnistrateInstanceSchemaType;
    target?: RDBExportTargetType;
    scheduleId?: string;
  }): Promise<{ taskId: string }> {
    const pendingTasks = await this.getPendingExportTasks(instance.id);
    if (pendingTasks.length > 0) {
      throw ApiError.conflict('There is already a task in progress', 'TASK_IN_PROGRESS');
    }

    const podId = this.resolvePrimaryPodId(instance);
    const taskType = this.getTaskType(instance);
    const destinationFileName = this.resolveDestinationFileName(instance.id);

    await this.verifyTargetWriteAccess(target, destinationFileName);

    let task: ExportRDBTaskType | undefined;
    try {
      task = (await this.tasksRepository.createTask(
        taskType,
        this.createTaskPayload(taskType, instance, podId, target, destinationFileName),
        { scheduleId },
      )) as ExportRDBTaskType;
    } catch (error) {
      this._opts.logger.error({ error }, 'Error creating task');
      throw ApiError.internalServerError('Error creating task', 'TASK_CREATION_ERROR');
    }

    try {
      await this.taskQueueRepository.submitExportRDBTask(task);
    } catch (error) {
      this._opts.logger.error({ error }, 'Error submitting task');
      this.tasksRepository.updateTask({
        taskId: task.taskId,
        status: 'failed',
        errors: ['Error submitting task'],
      });
      throw ApiError.internalServerError('Error submitting task', 'TASK_SUBMISSION_ERROR');
    }

    try {
      await this.tasksRepository.updateTask({
        taskId: task.taskId,
        status: 'pending',
      });
    } catch (error) {
      this._opts.logger.error({ error }, 'Error updating task status');
    }

    return { taskId: task.taskId };
  }
}