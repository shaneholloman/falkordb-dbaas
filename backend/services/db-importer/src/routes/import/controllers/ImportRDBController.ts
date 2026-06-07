import { FastifyBaseLogger } from 'fastify';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Storage } from '@google-cloud/storage';
import { K8sRepository } from '../../../repositories/k8s/K8sRepository';
import { OmnistrateRepository } from '../../../repositories/omnistrate/OmnistrateRepository';
import assert = require('assert');
import { IBlobStorageRepository } from '../../../repositories/blob/IBlobStorageRepository';
import { ITasksDBRepository } from '../../../repositories/tasks';
import { ApiError } from '@falkordb/errors';
import { OmnistrateInstanceSchemaType } from '../../../schemas/omnistrate-instance';
import { ImportRDBTaskType, RDBImportSourceType, RDBImportTaskPayloadType, sanitizeForLogging, TaskDocumentType } from '@falkordb/schemas/global';
import { ITaskQueueRepository } from '../../../repositories/tasksQueue/ITaskQueueRepository';
import crypto = require('crypto');

export class ImportRDBController {
  constructor(
    private omnistrateRepository: OmnistrateRepository,
    private k8sRepository: K8sRepository,
    private tasksRepository: ITasksDBRepository,
    private storageRepository: IBlobStorageRepository,
    private taskQueueRepository: ITaskQueueRepository,
    private _importBucketName: string,
    private _opts: {
      logger: FastifyBaseLogger;
    },
  ) {
    assert(_importBucketName, 'ImportRDBController: importBucketName is required');
  }

  async _getPendingImportTasks(instanceId: string): Promise<TaskDocumentType[]> {
    try {
      const tasks = await this.tasksRepository
        .listTasks(instanceId, {
          page: 1,
          pageSize: 1,
          status: ['created', 'pending', 'in_progress'],
          types: ['RDBImport'],
        })
        .then((result) => result.data);
      // filter out expired tasks
      const now = Date.now();
      const pendingTasks = tasks.filter((task) => {
        return new Date(task.createdAt).getTime() + 60 * 60 * 1000 > now; // 1 hour
      });
      return pendingTasks;
    } catch (error) {
      this._opts.logger.error({ error }, 'Error getting pending tasks');
      throw ApiError.internalServerError('Error getting pending tasks', 'PENDING_TASKS_ERROR');
    }
  }

  private _resolvePodPrefix(instance: OmnistrateInstanceSchemaType): string {
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

  private _createTaskPayload(
    instance: OmnistrateInstanceSchemaType,
    deploymentSizeInMb: number,
    source?: RDBImportSourceType,
  ): RDBImportTaskPayloadType {
    const randomId = crypto.randomUUID();
    return {
      cloudProvider: instance.cloudProvider,
      region: instance.region,
      clusterId: instance.clusterId,
      instanceId: instance.id,
      podIds: instance.podIds,
      hasTLS: instance.tls,
      bucketName: this._importBucketName,
      fileName: `imports/${instance.id}/${randomId}.rdb`,
      rdbSizeFileName: `imports/${instance.id}/${randomId}-size.txt`,
      rdbKeyNumberFileName: `imports/${instance.id}/${randomId}-keys.txt`,
      deploymentSizeInMb: deploymentSizeInMb,
      aofEnabled: instance.aofEnabled,
      backupPath: instance.aofEnabled ? `/data/backup/appendonlydir` : `/data/backup/dump.rdb`,
      isCluster: instance.deploymentType.startsWith('Cluster'),
      source,
    };
  }

  private async _validateCustomerSource(source: RDBImportSourceType): Promise<void> {
    try {
      if (source.type === 'gcs') {
        const storage = new Storage({
          projectId: source.credentials.project_id,
          credentials: source.credentials,
        });
        const [exists] = await storage.bucket(source.bucketName).file(source.fileName).exists();

        if (!exists) {
          throw new Error(`GCS object gs://${source.bucketName}/${source.fileName} does not exist or cannot be accessed`);
        }
        return;
      }

      const s3Client = new S3Client({
        region: source.region,
        credentials: {
          accessKeyId: source.accessKeyId,
          secretAccessKey: source.secretAccessKey,
          sessionToken: source.sessionToken,
        },
      });

      await s3Client.send(new HeadObjectCommand({
        Bucket: source.bucketName,
        Key: source.key,
      }));
    } catch (error) {
      this._opts.logger.warn({ error, source: sanitizeForLogging(source) }, 'Invalid import source credentials or object access');
      throw ApiError.badRequest('Invalid import source credentials or object access', 'INVALID_IMPORT_SOURCE');
    }
  }

  private _convertMaxMemoryToMB(maxMemory: string | undefined): number {
    if (!maxMemory) {
      return 0;
    }
    const memoryInBytes = parseInt(maxMemory, 10);
    return Math.floor(memoryInBytes / (1024 * 1024)); // Convert bytes to MB
  }

  async requestUploadUrl({
    requestorId,
    instanceId,
    username,
    password,
    source,
  }: {
    requestorId: string;
    instanceId: string;
    username: string;
    password: string;
    source?: RDBImportSourceType;
  }): Promise<{ taskId: string; uploadUrl?: string }> {
    // Get instance details from omnistrate
    let instance: OmnistrateInstanceSchemaType | undefined;
    try {
      instance = await this.omnistrateRepository.getInstance(instanceId);
    } catch (error) {
      this._opts.logger.error({ error }, 'Error getting instance');
      throw ApiError.internalServerError('Error getting instance', 'INSTANCE_ERROR');
    }

    const hasAccess = await this.omnistrateRepository.checkIfUserHasAccessToInstance(requestorId, instance, undefined, [
      'root',
      'editor',
    ]);

    if (!hasAccess) {
      throw ApiError.unauthorized('User does not have access to this instance', 'USER_NOT_AUTHORIZED');
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

    const pendingTasks = await this._getPendingImportTasks(instanceId);
    if (pendingTasks.length > 0) {
      throw ApiError.conflict('There is already a task in progress', 'TASK_IN_PROGRESS');
    }

    const podId = `${this._resolvePodPrefix(instance)}-0`;

    // Validate credentials with k8s repository
    let isAdmin = false;
    try {
      isAdmin = await this.k8sRepository.isUserAdmin(
        instance.cloudProvider,
        instance.clusterId,
        instance.region,
        instanceId,
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

    let maxMemory: string | undefined;
    try {
      maxMemory = await this.k8sRepository.getMaxMemory(
        instance.cloudProvider,
        instance.clusterId,
        instance.region,
        instanceId,
        podId,
        instance.tls,
      );
    } catch (error) {
      this._opts.logger.error({ error }, 'Error getting max memory');
      throw ApiError.internalServerError('Error getting instance size', 'INSTANCE_SIZE_ERROR');
    }

    if (!maxMemory) {
      this._opts.logger.error('Max memory is not set for the instance');
      throw ApiError.internalServerError('Instance size is not set', 'INSTANCE_SIZE_NOT_SET');
    }

    if (source) {
      await this._validateCustomerSource(source);
    }

    let task: ImportRDBTaskType | undefined;
    const payload = this._createTaskPayload(
      instance,
      this._convertMaxMemoryToMB(maxMemory),
      source,
    );

    try {
      task = (await this.tasksRepository.createTask('RDBImport', payload)) as ImportRDBTaskType;
    } catch (error) {
      this._opts.logger.error({ error }, 'Error creating task');
      throw ApiError.internalServerError('Error creating task', 'TASK_CREATION_ERROR');
    }

    if (source) {
      await this.tasksRepository.updateTask({
        taskId: task.taskId,
        status: 'pending',
        updatedAt: new Date().toISOString(),
      });

      await this.taskQueueRepository.submitImportRDBTask({
        ...task,
        status: 'pending',
      });

      return {
        taskId: task.taskId,
      };
    }

    let uploadUrl = '';
    try {
      uploadUrl = await this.storageRepository.getWriteUrl(
        this._importBucketName,
        payload.fileName,
        'application/octet-stream',
        60 * 60 * 1000, // 1 hour
      );
    } catch (error) {
      await this.tasksRepository.updateTask({
        taskId: task.taskId,
        status: 'failed',
        errors: ['Internal error'],
      });
      throw error;
    }

    await this.tasksRepository.updateTask({
      taskId: task.taskId,
      status: 'pending',
    });

    return {
      taskId: task.taskId,
      uploadUrl,
    };
  }

  async confirmUpload({
    requestorId,
    taskId,
    instanceId,
  }: {
    requestorId: string;
    taskId: string;
    instanceId: string;
  }): Promise<void> {
    // Check if the user has access to the instance
    const instance = await this.omnistrateRepository.getInstance(instanceId);
    if (!instance) {
      throw ApiError.notFound('Instance not found', 'INSTANCE_NOT_FOUND');
    }

    const hasAccess = await this.omnistrateRepository.checkIfUserHasAccessToInstance(requestorId, instance, undefined, [
      'root',
      'editor',
    ]);
    if (!hasAccess) {
      throw ApiError.unauthorized('User does not have access to this instance', 'USER_NOT_AUTHORIZED');
    }

    // Check if the task exists
    const task = (await this.tasksRepository.getTaskById(taskId)) as ImportRDBTaskType;
    if (!task) {
      throw ApiError.notFound('Task not found', 'TASK_NOT_FOUND');
    }
    if (task.type !== 'RDBImport') {
      throw ApiError.badRequest('Invalid task', 'INVALID_TASK_TYPE');
    }

    // Check if the task is in a valid state
    if (task.status !== 'pending') {
      throw ApiError.badRequest('Task is not in a valid state', 'TASK_INVALID_STATE');
    }

    // Update the task status to in_progress
    await this.tasksRepository.updateTask({
      taskId,
      updatedAt: new Date().toISOString(),
    });

    await this.taskQueueRepository.submitImportRDBTask(task);
  }
}
