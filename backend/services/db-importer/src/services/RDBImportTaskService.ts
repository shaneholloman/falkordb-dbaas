import { FastifyBaseLogger } from 'fastify';
import { ApiError } from '@falkordb/errors';
import {
  ImportRDBTaskType,
  RDBImportRequestSourceType,
  RDBImportSourceType,
  RDBImportTaskPayloadType,
  TaskDocumentType,
} from '@falkordb/schemas/global';
import { randomUUID } from 'crypto';
import { ITasksDBRepository } from '../repositories/tasks';
import { OmnistrateRepository } from '../repositories/omnistrate/OmnistrateRepository';
import { K8sRepository } from '../repositories/k8s/K8sRepository';
import { ITaskQueueRepository } from '../repositories/tasksQueue/ITaskQueueRepository';
import { OmnistrateInstanceSchemaType } from '../schemas/omnistrate-instance';

export class RDBImportTaskService {
  constructor(
    private tasksRepository: ITasksDBRepository,
    private omnistrateRepository: OmnistrateRepository,
    private k8sRepository: K8sRepository,
    private taskQueueRepository: ITaskQueueRepository,
    private _importBucketName: string,
    private _opts: { logger: FastifyBaseLogger },
  ) { }

  async getPendingImportTasks(instanceId: string): Promise<TaskDocumentType[]> {
    try {
      const tasks = await this.tasksRepository
        .listTasks(instanceId, {
          page: 1,
          pageSize: 1,
          status: ['created', 'pending', 'in_progress'],
          types: ['RDBImport'],
        })
        .then((result) => result.data);
      const now = Date.now();
      return tasks.filter((task) => new Date(task.createdAt).getTime() + 60 * 60 * 1000 > now);
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

  private _resolveSourceExportPodIds(instance: OmnistrateInstanceSchemaType): string[] {
    const podPrefix = this._resolvePodPrefix(instance);
    if (instance.deploymentType.startsWith('Cluster')) {
      return [0, 2, 4].map((index) => `${podPrefix}-${index}`);
    }

    return [`${podPrefix}-0`];
  }

  private _createTaskPayload(
    instance: OmnistrateInstanceSchemaType,
    deploymentSizeInMb: number,
    source?: RDBImportSourceType,
  ): RDBImportTaskPayloadType {
    const randomId = randomUUID();
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
      deploymentSizeInMb,
      aofEnabled: instance.aofEnabled,
      backupPath: instance.aofEnabled ? `/data/backup/appendonlydir` : `/data/backup/dump.rdb`,
      isCluster: instance.deploymentType.startsWith('Cluster'),
      source,
    };
  }

  private _convertMaxMemoryToMB(maxMemory: string | undefined): number {
    if (!maxMemory) {
      return 0;
    }
    const memoryInBytes = parseInt(maxMemory, 10);
    return Math.floor(memoryInBytes / (1024 * 1024));
  }

  async getImportableInstanceWithoutAccessCheck(instanceId: string): Promise<OmnistrateInstanceSchemaType> {
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

  async getImportableInstance(requestorId: string, instanceId: string): Promise<OmnistrateInstanceSchemaType> {
    const instance = await this.getImportableInstanceWithoutAccessCheck(instanceId);

    const hasAccess = await this.omnistrateRepository.checkIfUserHasAccessToInstance(requestorId, instance, undefined, [
      'root',
      'editor',
    ]);
    if (!hasAccess) {
      throw ApiError.unauthorized('User does not have access to this instance', 'USER_NOT_AUTHORIZED');
    }

    return instance;
  }

  async prepareInstanceSource({
    source,
    requestorId,
    destinationInstanceId,
    destinationMaxMemoryBytes,
    destinationIsCluster,
  }: {
    source: Extract<RDBImportRequestSourceType, { type: 'instance' }>;
    requestorId: string;
    destinationInstanceId: string;
    destinationMaxMemoryBytes: number;
    destinationIsCluster: boolean;
  }): Promise<Extract<RDBImportSourceType, { type: 'instance' }>> {
    if (source.instanceId === destinationInstanceId) {
      throw new Error('Source instance must be different from destination instance');
    }

    const sourceInstance = await this.omnistrateRepository.getInstance(source.instanceId);
    if (!sourceInstance) {
      throw new Error(`Source instance ${source.instanceId} was not found`);
    }

    const hasAccess = await this.omnistrateRepository.checkIfUserHasAccessToInstance(requestorId, sourceInstance, undefined, [
      'root',
      'editor',
      'reader',
    ]);
    if (!hasAccess) {
      throw new Error(`User does not have access to source instance ${source.instanceId}`);
    }
    if (sourceInstance.status !== 'RUNNING') {
      throw new Error(`Source instance ${source.instanceId} is not running`);
    }
    if (sourceInstance.productTierName === 'FalkorDB BYOA') {
      throw new Error('BYOA source instances are not supported');
    }

    const sourcePodIds = this._resolveSourceExportPodIds(sourceInstance);
    const sourceUsedMemoryDatasets = await Promise.all(sourcePodIds.map((sourcePodId) => this.k8sRepository.getUsedMemoryDataset(
      sourceInstance.cloudProvider,
      sourceInstance.clusterId,
      sourceInstance.region,
      sourceInstance.id,
      sourcePodId,
      sourceInstance.tls,
    )));
    const sourceUsedMemoryDataset = destinationIsCluster
      ? Math.max(...sourceUsedMemoryDatasets)
      : sourceUsedMemoryDatasets.reduce((total, usedMemoryDataset) => total + usedMemoryDataset, 0);
    if (destinationMaxMemoryBytes !== 0 && sourceUsedMemoryDataset > destinationMaxMemoryBytes) {
      throw new Error(`Source instance dataset size ${sourceUsedMemoryDataset} exceeds destination maxmemory ${destinationMaxMemoryBytes}`);
    }

    return {
      type: source.type,
      instanceId: source.instanceId,
      cloudProvider: sourceInstance.cloudProvider,
      clusterId: sourceInstance.clusterId,
      region: sourceInstance.region,
      podId: sourcePodIds[0],
      podIds: sourcePodIds,
      isCluster: sourceInstance.deploymentType.startsWith('Cluster'),
      tls: sourceInstance.tls,
    };
  }

  async getMaxMemory(instance: OmnistrateInstanceSchemaType): Promise<string> {
    const podId = `${this._resolvePodPrefix(instance)}-0`;
    try {
      return await this.k8sRepository.getMaxMemory(
        instance.cloudProvider,
        instance.clusterId,
        instance.region,
        instance.id,
        podId,
        instance.tls,
      );
    } catch (error) {
      this._opts.logger.error({ error }, 'Error getting max memory');
      throw ApiError.internalServerError('Error getting instance size', 'INSTANCE_SIZE_ERROR');
    }
  }

  async createAndSubmitTask({
    instance,
    source,
    scheduleId,
  }: {
    instance: OmnistrateInstanceSchemaType;
    source: RDBImportSourceType;
    scheduleId?: string;
  }): Promise<{ taskId: string }> {
    const maxMemory = await this.getMaxMemory(instance);
    if (!maxMemory) {
      this._opts.logger.error('Max memory is not set for the instance');
      throw ApiError.internalServerError('Instance size is not set', 'INSTANCE_SIZE_NOT_SET');
    }

    const payload = this._createTaskPayload(instance, this._convertMaxMemoryToMB(maxMemory), source);
    let task: ImportRDBTaskType;
    try {
      task = (await this.tasksRepository.createTask('RDBImport', payload, { scheduleId })) as ImportRDBTaskType;
    } catch (error) {
      this._opts.logger.error({ error }, 'Error creating task');
      throw ApiError.internalServerError('Error creating task', 'TASK_CREATION_ERROR');
    }

    await this.tasksRepository.updateTask({
      taskId: task.taskId,
      status: 'in_progress',
      updatedAt: new Date().toISOString(),
    });

    try {
      await this.taskQueueRepository.submitImportRDBTask({
        ...task,
        status: 'in_progress',
      });
    } catch (error) {
      this._opts.logger.error({ error, taskId: task.taskId }, 'Error submitting RDB import task to queue');
      await this.tasksRepository.updateTask({
        taskId: task.taskId,
        status: 'failed',
        errors: ['Failed to submit import task to queue'],
        updatedAt: new Date().toISOString(),
      });
      throw ApiError.internalServerError('Error submitting task', 'TASK_SUBMISSION_ERROR');
    }

    return { taskId: task.taskId };
  }
}