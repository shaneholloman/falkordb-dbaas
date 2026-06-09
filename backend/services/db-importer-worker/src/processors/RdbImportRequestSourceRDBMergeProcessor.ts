import { RdbImportRequestSourceRDBMergeProcessorData, RdbImportRequestSourceRDBMergeProcessorDataSchema, RdbImportTaskNames } from '@falkordb/schemas/services/db-importer-worker/v1';
import { Value } from '@sinclair/typebox/value';
import { DelayedError, Processor } from 'bullmq';
import { Logger } from 'pino';
import { setupContainer } from '../container';
import { K8sRepository } from '../repositories/k8s/K8sRepository';
import { ITasksDBRepository } from '../repositories/tasks';

/**
 * Starts the Kubernetes merge job for cluster source-instance imports.
 * It consumes the per-shard RDB part objects uploaded by copy-instance-source jobs and writes one
 * managed bucket object that the normal import validation and import processors can consume.
 */
const processor: Processor<RdbImportRequestSourceRDBMergeProcessorData> = async (job) => {
  const container = setupContainer();
  const logger = container.resolve<Logger>('logger');
  const tasksRepository = container.resolve<ITasksDBRepository>(ITasksDBRepository.name);
  const k8sRepository = container.resolve<K8sRepository>(K8sRepository.name);

  logger.debug(`Processing 'rdb-import-request-source-rdb-merge' job ${job.id} with data: ${JSON.stringify(job.data, null, 2)}`);

  try {
    Value.Assert(RdbImportRequestSourceRDBMergeProcessorDataSchema, job.data);

    await k8sRepository.createMergeRDBsJob(
      job.data.projectId,
      job.data.cloudProvider,
      job.data.clusterId,
      job.data.region,
      job.data.namespace,
      `${job.data.taskId}-source-import`,
      job.data.bucketName,
      job.data.rdbFileNames,
      job.data.outputRdbFileName,
    );

    return { success: true };
  } catch (error) {
    if (error instanceof DelayedError) {
      throw error;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(error, `Error processing job ${job.id}: ${error}`);
    await tasksRepository.updateTask({
      taskId: job.data.taskId,
      errors: [errorMessage],
      status: 'failed',
    });
    throw error;
  }
};

export default {
  name: RdbImportTaskNames.RdbImportRequestSourceRDBMerge,
  processor,
  concurrency: undefined,
  schema: RdbImportRequestSourceRDBMergeProcessorDataSchema,
};