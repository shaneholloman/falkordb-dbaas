import { ImportRDBTaskType, sanitizeForLogging } from '@falkordb/schemas/global';
import { RdbImportCopyInstanceSourceToBucketProcessorData, RdbImportCopyInstanceSourceToBucketProcessorDataSchema, RdbImportTaskNames } from '@falkordb/schemas/services/db-importer-worker/v1';
import { Value } from '@sinclair/typebox/value';
import { Processor } from 'bullmq';
import { Logger } from 'pino';
import { setupContainer } from '../container';
import { IBlobStorageRepository } from '../repositories/blob/IBlobStorageRepository';
import { K8sRepository } from '../repositories/k8s/K8sRepository';
import { ITasksDBRepository } from '../repositories/tasks';

/**
 * Exports one RDB from a prepared source instance pod into the managed import bucket.
 * Standalone instance imports use this once for the final RDB object; cluster imports use one
 * copy job per source shard pod and write temporary part objects that are merged by the next flow stage.
 */
const processor: Processor<RdbImportCopyInstanceSourceToBucketProcessorData> = async (job) => {
  const container = setupContainer();
  const logger = container.resolve<Logger>('logger');
  const tasksRepository = container.resolve<ITasksDBRepository>(ITasksDBRepository.name);
  const blobStorageRepository = container.resolve<IBlobStorageRepository>(IBlobStorageRepository.name);
  const k8sRepository = container.resolve<K8sRepository>(K8sRepository.name);

  logger.debug(`Processing 'rdb-import-copy-instance-source-to-bucket' job ${job.id} with data: ${JSON.stringify(job.data, null, 2)}`);

  try {
    const data = Value.Clean(RdbImportCopyInstanceSourceToBucketProcessorDataSchema, job.data);
    Value.Assert(RdbImportCopyInstanceSourceToBucketProcessorDataSchema, data);

    const task = await tasksRepository.getTaskById(data.taskId) as ImportRDBTaskType;
    if (!task || task.type !== 'RDBImport') {
      throw new Error(`Task ${data.taskId} not found or is not an RDB import task`);
    }
    const source = task.payload.source;
    if (!source || source.type !== 'instance') {
      throw new Error(`Task ${data.taskId} is not an instance-source RDB import task`);
    }
    if (!source.cloudProvider || !source.clusterId || !source.region || !source.podIds || source.isCluster === undefined || source.tls === undefined) {
      throw new Error('Instance import source is missing prepared instance metadata');
    }
    if (!source.podIds.includes(data.podId)) {
      throw new Error(`Pod ${data.podId} is not part of source instance ${source.instanceId}`);
    }

    const destinationWriteUrl = await blobStorageRepository.getWriteUrl(
      data.bucketName,
      data.fileName,
      'application/octet-stream',
      60 * 60 * 1000,
    );

    await k8sRepository.sendSaveAndUploadCommand(
      source.cloudProvider,
      source.clusterId,
      source.region,
      source.instanceId,
      data.podId,
      source.tls,
      destinationWriteUrl,
    );

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error, data: sanitizeForLogging(job.data) }, `Error processing job ${job.id}: ${error}`);
    await tasksRepository.updateTask({
      taskId: job.data.taskId,
      errors: [errorMessage],
      status: 'failed',
    });
    throw error;
  }
};

export default {
  name: RdbImportTaskNames.RdbImportCopyInstanceSourceToBucket,
  processor,
  concurrency: undefined,
  schema: RdbImportCopyInstanceSourceToBucketProcessorDataSchema,
};